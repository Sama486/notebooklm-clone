import { createHash } from 'node:crypto';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import type { AiClient } from '../ai/types.js';

/**
 * Embedding-Cache.
 *
 * Bei einem KI-Produkt ist Skalierung zuerst eine Kostenfrage. Derselbe Text
 * zweimal einzubetten kostet zweimal - und das passiert öfter, als man denkt:
 * beim erneuten Einlesen einer Quelle, bei zwei Nutzern mit demselben
 * Standarddokument, bei überlappenden Abschnitten mit identischem Inhalt.
 *
 * Der Cache liegt in der DATENBANK, nicht im Prozessspeicher. Zwei Gründe:
 * er überlebt einen Neustart, und mehrere Instanzen teilen ihn sich. Ein
 * Cache im Prozess wäre genau die Art Zustand, die bei der zweiten Instanz
 * anfängt, Geld zu kosten statt zu sparen.
 *
 * Schlüssel ist ein SHA-256 über Modellname und Text. Der Modellname gehört
 * hinein: derselbe Text ergibt bei einem anderen Modell einen anderen Vektor,
 * und Vektoren aus zwei Modellen sind nicht vergleichbar.
 *
 * BENANNTE ABWEICHUNG: Ein Vektor aus dem Cache ist nicht bitgenau derselbe wie
 * der frisch berechnete - der Weg durch die Datenbank kostet die letzte Stelle
 * der Gleitkommazahl (relativer Fehler in der Grössenordnung 1e-16). Für die
 * Rangfolge ist das ohne Bedeutung: die Kosinus-Werte konkurrierender
 * Abschnitte liegen um Grössenordnungen weiter auseinander. Der Hinweis steht
 * hier, damit niemand später auf exakte Gleichheit prüft und sich wundert.
 */

export function embeddingKey(model: string, text: string): string {
  // Nullbyte als Trennzeichen zwischen Modellname und Text, nicht etwa ein
  // Leerzeichen: es kann weder in einem Modellnamen noch in einem Text
  // vorkommen (Postgres speichert kein NUL in einer Textspalte). Damit gibt es
  // keine zwei Eingaben, die denselben Schlüssel ergeben.
  return createHash('sha256').update(`${model}\0${text}`).digest('hex');
}

/**
 * Bettet Texte ein und nutzt dabei den Cache.
 *
 * Gibt die Vektoren in der Reihenfolge der Eingabe zurück - der Aufrufer
 * ordnet sie seinen Abschnitten nach Position zu.
 */
export async function embedWithCache(ai: AiClient, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const model = ai.embeddingModel;
  const keys = texts.map((text) => embeddingKey(model, text));

  const cached = await prisma.embeddingCache.findMany({
    where: { hash: { in: [...new Set(keys)] } },
    select: { hash: true, embedding: true },
  });
  const byHash = new Map(cached.map((row) => [row.hash, row.embedding]));

  // Nur das einbetten, was fehlt - und jeden fehlenden Text nur einmal, auch
  // wenn er mehrfach vorkommt.
  const missing: string[] = [];
  const missingKeys = new Set<string>();
  texts.forEach((text, index) => {
    const key = keys[index] as string;
    if (byHash.has(key) || missingKeys.has(key)) return;
    missingKeys.add(key);
    missing.push(text);
  });

  if (missing.length > 0) {
    logger.info('Erzeuge Embeddings', { angefragt: texts.length, neu: missing.length });
    const fresh = await ai.embedDocuments(missing);

    const rows = missing.map((text, index) => ({
      hash: embeddingKey(model, text),
      model,
      embedding: fresh[index] as number[],
    }));
    for (const row of rows) byHash.set(row.hash, row.embedding);

    // `skipDuplicates`, weil zwei gleichzeitige Einlesevorgänge denselben Text
    // einbetten können. Der zweite Schreibversuch soll dann nichts tun statt
    // den ganzen Vorgang scheitern zu lassen.
    await prisma.embeddingCache.createMany({ data: rows, skipDuplicates: true });
  }

  return keys.map((key) => {
    const embedding = byHash.get(key);
    if (!embedding) throw new Error('Embedding fehlt nach dem Erzeugen');
    return embedding;
  });
}
