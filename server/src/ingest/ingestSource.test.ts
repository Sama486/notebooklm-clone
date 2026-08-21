import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { AiError } from '../ai/types.js';
import { createTestAiClient } from '../ai/testDouble.js';
import { resetDatabase } from '../test/helpers.js';
import { ingestSource } from './ingestSource.js';
import { embeddingKey, embedWithCache } from './embeddingCache.js';

/**
 * Fehlerpfade beim Einlesen.
 *
 * Der Vorgang laeuft im Hintergrund - ein Fehler kann also nirgends als
 * HTTP-Status landen. Er muss als Status an der Quelle sichtbar werden, sonst
 * sitzt der Nutzer vor einem Ladebalken, der nie fertig wird.
 */
describe('Einlesen: Fehlerpfade und Wiederholbarkeit', () => {
  let notebookId: string;
  let userId: string;

  beforeAll(async () => {
    await resetDatabase();
    const user = await prisma.user.create({
      data: { email: 'einlesen@example.test', passwordHash: 'nicht-verwendet' },
    });
    userId = user.id;
  });

  beforeEach(async () => {
    const notebook = await prisma.notebook.create({
      data: { userId, title: 'Einlesen' },
    });
    notebookId = notebook.id;
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  async function createSource(content: string) {
    return prisma.source.create({
      data: {
        notebookId,
        title: 'Quelle',
        type: 'text',
        content,
        sizeBytes: content.length,
        status: 'pending',
      },
    });
  }

  it('setzt den Status auf ready und schreibt die Abschnitte', async () => {
    const source = await createSource('Ein Absatz mit Inhalt. '.repeat(60));
    await ingestSource(source.id, createTestAiClient());

    const after = await prisma.source.findUniqueOrThrow({ where: { id: source.id } });
    expect(after.status).toBe('ready');
    expect(after.error).toBeNull();
    expect(after.chunkCount).toBeGreaterThan(0);
    expect(await prisma.chunk.count({ where: { sourceId: source.id } })).toBe(after.chunkCount);
  });

  it('setzt bei leerem Text den Status failed mit lesbarer Meldung', async () => {
    const source = await createSource('   \n\n   ');
    await ingestSource(source.id, createTestAiClient());

    const after = await prisma.source.findUniqueOrThrow({ where: { id: source.id } });
    expect(after.status).toBe('failed');
    expect(after.error).toContain('keinen verwertbaren Text');
  });

  it('setzt bei einem Fehler des KI-Dienstes failed - mit neutraler Meldung', async () => {
    // Bewusst einzigartiger Text: waere er schon im Cache, kaeme der Dienst
    // gar nicht an die Reihe und der Fehler traete nie ein.
    const source = await createSource(`Einmaliger Text ${Date.now()}. `.repeat(60));

    const brokenAi = createTestAiClient();
    brokenAi.embedDocuments = () => {
      throw new AiError('Der KI-Dienst antwortete mit Status 503.', true);
    };

    await ingestSource(source.id, brokenAi);

    const after = await prisma.source.findUniqueOrThrow({ where: { id: source.id } });
    expect(after.status).toBe('failed');
    // Kein Durchreichen des Anbieterfehlers - die Meldung landet in der
    // Oberflaeche und darf nichts Internes verraten.
    expect(after.error).not.toContain('503');
    expect(after.error).toContain('erneut versuchen');
    // Und es liegen keine halben Abschnitte herum.
    expect(await prisma.chunk.count({ where: { sourceId: source.id } })).toBe(0);
  });

  it('wirft nicht, wenn die Quelle inzwischen geloescht wurde', async () => {
    const source = await createSource('Inhalt. '.repeat(60));
    await prisma.source.delete({ where: { id: source.id } });

    // Der Nutzer hat geloescht, waehrend der Vorgang in der Warteschlange
    // stand. Das ist kein Fehler, sondern nichts mehr zu tun - und es darf auch
    // keinen Fehler ins Log schreiben.
    const errors: unknown[][] = [];
    const originalError = logger.error;
    logger.error = (...args: [string, Record<string, unknown>?]) => errors.push(args);
    try {
      await expect(ingestSource(source.id, createTestAiClient())).resolves.toBeUndefined();
    } finally {
      logger.error = originalError;
    }
    expect(errors).toEqual([]);
  });

  it('erzeugt beim zweiten Durchlauf keine doppelten Abschnitte', async () => {
    const source = await createSource('Ein Absatz mit Inhalt. '.repeat(60));

    await ingestSource(source.id, createTestAiClient());
    const first = await prisma.chunk.count({ where: { sourceId: source.id } });

    await ingestSource(source.id, createTestAiClient());
    const second = await prisma.chunk.count({ where: { sourceId: source.id } });

    expect(second).toBe(first);
    // Auch die Nummerierung bleibt luecken- und doppelfrei.
    const chunks = await prisma.chunk.findMany({
      where: { sourceId: source.id },
      orderBy: { index: 'asc' },
      select: { index: true },
    });
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('schreibt Abschnitte, deren Positionen auf den Volltext passen', async () => {
    const content = 'Die Zeichen-Positionen tragen die Zitatfunktion. '.repeat(80);
    const source = await createSource(content);
    await ingestSource(source.id, createTestAiClient());

    for (const chunk of await prisma.chunk.findMany({ where: { sourceId: source.id } })) {
      expect(content.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content);
      // Die Denormalisierung muss stimmen - die Suche filtert danach.
      expect(chunk.notebookId).toBe(notebookId);
    }
  });
});

describe('Embedding-Cache', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it('fragt denselben Text nur einmal beim Dienst an', async () => {
    const ai = createTestAiClient();
    let calls = 0;
    const original = ai.embedDocuments.bind(ai);
    ai.embedDocuments = async (texts) => {
      calls += 1;
      return original(texts);
    };

    const texts = ['Erster Text', 'Zweiter Text', 'Erster Text'];
    const first = await embedWithCache(ai, texts);
    expect(calls).toBe(1);
    // Trotz Dublette in der Eingabe kommen drei Vektoren zurueck, in der
    // Reihenfolge der Eingabe.
    expect(first).toHaveLength(3);
    expect(first[0]).toEqual(first[2]);

    // Zweiter Aufruf: alles im Cache, kein weiterer Dienstaufruf.
    const second = await embedWithCache(ai, texts);
    expect(calls).toBe(1);

    // Nicht bitgenau vergleichen: der Weg durch die Datenbank kostet die
    // letzte Stelle der Gleitkommazahl (siehe Kommentar in embeddingCache.ts).
    // Fuer die Rangfolge ist das ohne Bedeutung, fuer toEqual waere es ein
    // Unterschied.
    expect(second).toHaveLength(first.length);
    second.forEach((vector, index) => {
      vector.forEach((value, position) => {
        expect(value).toBeCloseTo((first[index] as number[])[position] as number, 12);
      });
    });
  });

  it('nimmt den Modellnamen in den Schluessel auf', () => {
    // Vektoren aus zwei Modellen sind nicht vergleichbar - derselbe Text darf
    // deshalb nicht denselben Cache-Eintrag treffen.
    expect(embeddingKey('modell-a', 'Text')).not.toBe(embeddingKey('modell-b', 'Text'));
    expect(embeddingKey('modell-a', 'Text')).toBe(embeddingKey('modell-a', 'Text'));
  });

  it('gibt bei leerer Eingabe nichts zurueck', async () => {
    expect(await embedWithCache(createTestAiClient(), [])).toEqual([]);
  });
});
