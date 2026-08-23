import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { prisma } from '../db.js';
import { limits } from '../config.js';
import { setAiClient } from '../ai/index.js';
import { createTestAiClient } from '../ai/testDouble.js';
import { auth, createNotebook, createUser, resetDatabase, type TestUser } from '../test/helpers.js';
import { makePdf } from '../test/makePdf.js';

/** Wartet, bis die Hintergrundverarbeitung einen Endzustand erreicht hat. */
async function waitForStatus(sourceId: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const source = await prisma.source.findUnique({
      where: { id: sourceId },
      select: { status: true },
    });
    if (source && (source.status === 'ready' || source.status === 'failed')) return source.status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Zeitlimit beim Warten auf den Verarbeitungsstatus');
}

describe('Quellen einlesen', () => {
  let app: Express;
  let alice: TestUser;
  let bob: TestUser;
  let notebookId: string;

  beforeAll(async () => {
    setAiClient(createTestAiClient());
    app = createApp();
    await resetDatabase();
    alice = await createUser(app);
    bob = await createUser(app);
  });

  beforeEach(async () => {
    notebookId = await createNotebook(app, alice);
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  describe('PDF', () => {
    it('nimmt ein PDF an und verarbeitet es im Hintergrund', async () => {
      const pdf = makePdf([
        'Die Berechtigungsprüfung steht im Zugriffspfad und nicht daneben. '.repeat(20),
        'Der Einstieg ist immer das Notebook. '.repeat(20),
      ]);

      const res = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/pdf?title=Handbuch`)
        .set(auth(alice))
        .set('Content-Type', 'application/pdf')
        .send(pdf);

      // Sofortige Antwort mit Status "pending" - die Verarbeitung läuft
      // danach weiter und blockiert die Anfrage nicht.
      expect(res.status).toBe(201);
      expect(res.body.source.status).toBe('pending');

      expect(await waitForStatus(res.body.source.id)).toBe('ready');

      const source = await prisma.source.findUnique({ where: { id: res.body.source.id } });
      expect(source?.chunkCount).toBeGreaterThan(0);
      expect(source?.content).toContain('Berechtigungsprüfung');
      // Das Original bleibt für die Dokumentansicht erhalten.
      expect(source?.fileData?.length).toBeGreaterThan(0);
      // Seitenanfänge werden mitgeführt.
      expect(source?.pageBreaks.length).toBe(1);
    });

    it('hängt Seitenzahlen an die Abschnitte', async () => {
      const pdf = makePdf([
        'Seite eins mit ausreichend Text für einen Abschnitt. '.repeat(80),
        'Seite zwei mit ausreichend Text für einen Abschnitt. '.repeat(80),
      ]);
      const res = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/pdf?title=Mehrseitig`)
        .set(auth(alice))
        .set('Content-Type', 'application/pdf')
        .send(pdf);
      await waitForStatus(res.body.source.id);

      const chunks = await prisma.chunk.findMany({
        where: { sourceId: res.body.source.id },
        orderBy: { index: 'asc' },
      });
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c) => c.page !== null)).toBe(true);
      expect(new Set(chunks.map((c) => c.page)).size).toBeGreaterThan(1);
    });

    it('speichert Zeichen-Positionen, die auf den Volltext passen', async () => {
      // Die Zusicherung, die die Zitatfunktion trägt - hier durch die ganze
      // Kette hindurch geprüft, nicht nur in der reinen Funktion.
      const res = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/pdf?title=Positionen`)
        .set(auth(alice))
        .set('Content-Type', 'application/pdf')
        .send(makePdf(['Ein Satz über die Zuständigkeit. '.repeat(100)]));
      await waitForStatus(res.body.source.id);

      const source = await prisma.source.findUniqueOrThrow({ where: { id: res.body.source.id } });
      const chunks = await prisma.chunk.findMany({ where: { sourceId: source.id } });

      for (const chunk of chunks) {
        expect(source.content.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content);
      }
    });

    it('lehnt eine Datei ab, die kein PDF ist', async () => {
      const res = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/pdf?title=Schadcode`)
        .set(auth(alice))
        .set('Content-Type', 'application/pdf')
        .send(Buffer.from('<?php system($_GET["cmd"]); ?>'));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('not_a_pdf');
      // Es entsteht keine Quelle - nicht einmal eine fehlgeschlagene.
      expect(await prisma.source.count({ where: { notebookId } })).toBe(0);
    });

    it('lehnt einen Upload ohne Titel ab', async () => {
      const res = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/pdf`)
        .set(auth(alice))
        .set('Content-Type', 'application/pdf')
        .send(makePdf(['Inhalt']));
      expect(res.status).toBe(400);
    });

    it('übernimmt den Dateinamen nirgends - der Titel kommt aus der Anfrage', async () => {
      // Ein Pfad-Ausbruch im Titel bleibt reiner Anzeigetext, weil nichts ins
      // Dateisystem geschrieben wird.
      const res = await request(app)
        .post(
          `/api/notebooks/${notebookId}/sources/pdf?title=${encodeURIComponent('../../etc/passwd')}`,
        )
        .set(auth(alice))
        .set('Content-Type', 'application/pdf')
        .send(makePdf(['Inhalt der Datei.']));

      expect(res.status).toBe(201);
      expect(res.body.source.title).toBe('../../etc/passwd');
    });
  });

  describe('Text', () => {
    it('nimmt eingefügten Text an', async () => {
      const content = 'Ein eingefügter Absatz über die Zuständigkeit. '.repeat(50);
      const res = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/text`)
        .set(auth(alice))
        .send({ title: 'Notiz', content });

      expect(res.status).toBe(201);
      expect(await waitForStatus(res.body.source.id)).toBe('ready');

      const chunks = await prisma.chunk.findMany({ where: { sourceId: res.body.source.id } });
      expect(chunks.length).toBeGreaterThan(0);
      // Text-Quellen haben keine Seiten - `null` statt einer erfundenen 1.
      expect(chunks.every((c) => c.page === null)).toBe(true);
    });

    it('lehnt leeren Text ab', async () => {
      const res = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/text`)
        .set(auth(alice))
        .send({ title: 'Leer', content: '   ' });
      expect(res.status).toBe(400);
    });

    /**
     * Diese beiden Fälle stehen hier, weil die Grenze schon einmal still
     * verschwunden war: der allgemeine JSON-Parser lief vor dem der Route, hat
     * den Rumpf mit 128 kb abgewiesen und damit die größere Grenze zu totem
     * Code gemacht. "Text einfügen" brach bei rund 128 kb ab, obwohl die
     * Konfiguration 400.000 Zeichen versprach - und der Nutzer bekam ein
     * nichtssagendes "Anfrage zu groß" statt eines Hinweises auf die
     * Zeichenzahl. Ein Test an dieser Stelle ist billiger als die Erinnerung
     * an die Reihenfolge in app.ts.
     */
    it('nimmt Text an, der über der allgemeinen Rumpfgrenze liegt', async () => {
      // Deutlich über den 128 kb der Voreinstellung, deutlich unter der
      // Zeichengrenze der Route.
      const content = 'Ein Satz über die Zuständigkeit der Behörde. '.repeat(4_000);
      expect(content.length).toBeGreaterThan(150_000);
      expect(content.length).toBeLessThan(limits.body.pastedText);

      const res = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/text`)
        .set(auth(alice))
        .send({ title: 'Langer Text', content });

      expect(res.status).toBe(201);
    });

    it('weist Text über der Zeichengrenze mit einer Meldung ab, die sie benennt', async () => {
      const res = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/text`)
        .set(auth(alice))
        .send({ title: 'Zu lang', content: 'x'.repeat(limits.body.pastedText + 1) });

      // 400 aus der Zod-Prüfung, nicht 413 aus dem Body-Parser: die
      // Zeichengrenze ist die verbindliche, die Bytegrenze liegt darüber.
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
    });
  });

  describe('URL', () => {
    it('lehnt interne Adressen ab, ohne eine Quelle anzulegen', async () => {
      for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:8080/']) {
        const res = await request(app)
          .post(`/api/notebooks/${notebookId}/sources/url`)
          .set(auth(alice))
          .send({ url });
        expect(res.status, url).toBe(400);
      }
      expect(await prisma.source.count({ where: { notebookId } })).toBe(0);
    });

    it('lehnt file:// ab', async () => {
      const res = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/url`)
        .set(auth(alice))
        .send({ url: 'file:///etc/passwd' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('unsupported_scheme');
    });
  });

  describe('Berechtigung', () => {
    it('Bob kann in Alices Notebook keine Quelle anlegen', async () => {
      const res = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/text`)
        .set(auth(bob))
        .send({ title: 'Fremd', content: 'Inhalt von Bob.' });

      expect(res.status).toBe(404);
      expect(await prisma.source.count({ where: { notebookId } })).toBe(0);
    });

    it('Bob kann Alices Quelle nicht lesen, ändern oder löschen', async () => {
      const created = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/text`)
        .set(auth(alice))
        .send({ title: 'Privat', content: 'Vertraulicher Inhalt. '.repeat(20) });
      const sourceId = created.body.source.id;
      await waitForStatus(sourceId);

      const base = `/api/notebooks/${notebookId}/sources/${sourceId}`;
      expect((await request(app).get(base).set(auth(bob))).status).toBe(404);
      expect((await request(app).patch(base).set(auth(bob)).send({ selected: false })).status).toBe(
        404,
      );
      expect((await request(app).delete(base).set(auth(bob))).status).toBe(404);

      // Die Quelle lebt noch.
      expect(await prisma.source.findUnique({ where: { id: sourceId } })).not.toBeNull();
    });

    it('eine Quellen-ID aus einem anderen Notebook wird nicht aufgelöst', async () => {
      // Der Kern der Regel "Kindobjekte nur über ihr Notebook": beide
      // Notebooks gehören Alice, aber die Quelle liegt im anderen.
      const zweites = await createNotebook(app, alice, 'Zweites');
      const created = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/text`)
        .set(auth(alice))
        .send({ title: 'Woanders', content: 'Inhalt. '.repeat(20) });

      const res = await request(app)
        .get(`/api/notebooks/${zweites}/sources/${created.body.source.id}`)
        .set(auth(alice));
      expect(res.status).toBe(404);
    });
  });

  describe('Wiederholbarkeit', () => {
    it('zweimaliges Einlesen erzeugt keine doppelten Abschnitte', async () => {
      const created = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/text`)
        .set(auth(alice))
        .send({ title: 'Wiederholt', content: 'Ein Absatz mit Inhalt. '.repeat(60) });
      const sourceId = created.body.source.id;
      await waitForStatus(sourceId);

      const ersteAnzahl = await prisma.chunk.count({ where: { sourceId } });

      const wiederholt = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/${sourceId}/reingest`)
        .set(auth(alice));
      expect(wiederholt.status).toBe(202);
      await waitForStatus(sourceId);

      expect(await prisma.chunk.count({ where: { sourceId } })).toBe(ersteAnzahl);
    });
  });

  describe('Umbenennen', () => {
    it('aendert den Titel', async () => {
      const created = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/text`)
        .set(auth(alice))
        .send({ title: 'Alter Titel', content: 'Inhalt. '.repeat(30) });

      const res = await request(app)
        .patch(`/api/notebooks/${notebookId}/sources/${created.body.source.id}`)
        .set(auth(alice))
        .send({ title: 'Neuer Titel' });

      expect(res.status).toBe(200);
      expect(res.body.source.title).toBe('Neuer Titel');
      // Die Auswahl bleibt unberuehrt, wenn nur der Titel geschickt wird.
      expect(res.body.source.selected).toBe(true);
    });

    it('lehnt einen leeren Rumpf ab', async () => {
      const created = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/text`)
        .set(auth(alice))
        .send({ title: 'Titel', content: 'Inhalt. '.repeat(30) });

      // Ein erfolgreicher Aufruf, der nichts tut, waere schlimmer als ein
      // Fehler: der Aufrufer merkt seinen Tippfehler nicht.
      const res = await request(app)
        .patch(`/api/notebooks/${notebookId}/sources/${created.body.source.id}`)
        .set(auth(alice))
        .send({});
      expect(res.status).toBe(400);
    });

    it('lehnt einen leeren und einen zu langen Titel ab', async () => {
      const created = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/text`)
        .set(auth(alice))
        .send({ title: 'Titel', content: 'Inhalt. '.repeat(30) });
      const base = `/api/notebooks/${notebookId}/sources/${created.body.source.id}`;

      expect((await request(app).patch(base).set(auth(alice)).send({ title: '  ' })).status).toBe(400);
      expect(
        (await request(app).patch(base).set(auth(alice)).send({ title: 'x'.repeat(500) })).status,
      ).toBe(400);
    });

    it('Bob kann Alices Quelle nicht umbenennen', async () => {
      const created = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/text`)
        .set(auth(alice))
        .send({ title: 'Privat', content: 'Inhalt. '.repeat(30) });

      const res = await request(app)
        .patch(`/api/notebooks/${notebookId}/sources/${created.body.source.id}`)
        .set(auth(bob))
        .send({ title: 'Uebernommen' });

      expect(res.status).toBe(404);
      const unveraendert = await prisma.source.findUniqueOrThrow({
        where: { id: created.body.source.id },
      });
      expect(unveraendert.title).toBe('Privat');
    });
  });

  describe('Sammelauswahl', () => {
    async function dreiQuellen() {
      for (const i of [1, 2, 3]) {
        await request(app)
          .post(`/api/notebooks/${notebookId}/sources/text`)
          .set(auth(alice))
          .send({ title: `Quelle ${i}`, content: `Inhalt ${i}. `.repeat(30) });
      }
    }

    it('waehlt alle auf einmal ab und wieder an', async () => {
      await dreiQuellen();
      const base = `/api/notebooks/${notebookId}/sources/selection`;

      const ab = await request(app).patch(base).set(auth(alice)).send({ selected: false });
      expect(ab.status).toBe(200);
      expect(ab.body.updated).toBe(3);
      expect(await prisma.source.count({ where: { notebookId, selected: true } })).toBe(0);

      await request(app).patch(base).set(auth(alice)).send({ selected: true });
      expect(await prisma.source.count({ where: { notebookId, selected: false } })).toBe(0);
    });

    it('greift nur im eigenen Notebook', async () => {
      await dreiQuellen();
      const zweites = await createNotebook(app, alice, 'Unberuehrt');
      await request(app)
        .post(`/api/notebooks/${zweites}/sources/text`)
        .set(auth(alice))
        .send({ title: 'Fremd', content: 'Inhalt. '.repeat(30) });

      await request(app)
        .patch(`/api/notebooks/${notebookId}/sources/selection`)
        .set(auth(alice))
        .send({ selected: false });

      // Die Quelle im anderen Notebook bleibt ausgewaehlt.
      expect(await prisma.source.count({ where: { notebookId: zweites, selected: true } })).toBe(1);
    });

    it('Bob kann Alices Auswahl nicht umstellen', async () => {
      await dreiQuellen();
      const res = await request(app)
        .patch(`/api/notebooks/${notebookId}/sources/selection`)
        .set(auth(bob))
        .send({ selected: false });

      expect(res.status).toBe(404);
      expect(await prisma.source.count({ where: { notebookId, selected: true } })).toBe(3);
    });
  });

  describe('Auswahl', () => {
    it('lässt sich abwählen und wieder anwählen', async () => {
      const created = await request(app)
        .post(`/api/notebooks/${notebookId}/sources/text`)
        .set(auth(alice))
        .send({ title: 'Auswählbar', content: 'Inhalt. '.repeat(30) });
      const sourceId = created.body.source.id;

      const base = `/api/notebooks/${notebookId}/sources/${sourceId}`;
      await request(app).patch(base).set(auth(alice)).send({ selected: false });
      expect(
        (await prisma.source.findUniqueOrThrow({ where: { id: sourceId } })).selected,
      ).toBe(false);

      await request(app).patch(base).set(auth(alice)).send({ selected: true });
      expect((await prisma.source.findUniqueOrThrow({ where: { id: sourceId } })).selected).toBe(
        true,
      );
    });
  });
});
