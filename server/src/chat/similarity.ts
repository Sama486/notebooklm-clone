/**
 * Aehnlichkeitsberechnung und Rangfolge.
 *
 * Bewusst ein exakter Durchlauf ueber alle Abschnitte eines Notebooks statt
 * eines Vektor-Index. Die Begruendung steht nicht hier als Behauptung, sondern
 * im README als Messung: scripts/measure-search.ts faehrt die Suche gegen 100,
 * 1.000 und 10.000 Abschnitte und gibt Laufzeit und uebertragene Datenmenge
 * aus, samt benanntem Kipppunkt.
 *
 * Der Wechsel auf einen Index bleibt lokal begrenzt, weil die Rangfolge hinter
 * dieser Modulgrenze liegt: `rankBySimilarity` ist die einzige Stelle, die
 * entscheidet, welche Abschnitte in den Prompt gehen. Wer pgvector einbaut,
 * ersetzt den Aufrufer dieser Funktion und sonst nichts.
 *
 * Reine Funktionen ohne Datenbank und ohne Netz.
 */

export interface ScoredChunk<T> {
  chunk: T;
  score: number;
}

/**
 * Kosinus-Aehnlichkeit zweier Vektoren, Wertebereich -1 bis 1.
 *
 * Kosinus und nicht euklidischer Abstand, weil nur die Richtung des Vektors die
 * Bedeutung traegt; die Laenge haengt an der Textlaenge und wuerde lange
 * Abschnitte systematisch bevorzugen.
 *
 * Zwei Sonderfaelle geben 0 zurueck statt zu werfen: unterschiedliche
 * Dimensionen (ein Abschnitt wurde mit einem anderen Modell eingebettet) und
 * ein Nullvektor (Division durch null). "Nicht aehnlich" ist die sichere
 * Antwort - ein Abschnitt, der nicht vergleichbar ist, darf nicht in die
 * Antwort geraten.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  // Eine Schleife statt drei: bei 10.000 Abschnitten mal 768 Dimensionen macht
  // das den Unterschied zwischen einem und drei Durchlaeufen ueber 7,7 Mio.
  // Zahlen.
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Sortiert Abschnitte nach Aehnlichkeit zur Frage und gibt die besten zurueck.
 *
 * `getEmbedding` statt eines festen Feldnamens, damit die Funktion nicht weiss,
 * wie ein Abschnitt aus der Datenbank aussieht - das macht sie ohne Prisma
 * testbar.
 */
export function rankBySimilarity<T>(
  queryEmbedding: readonly number[],
  chunks: readonly T[],
  getEmbedding: (chunk: T) => readonly number[],
  topK: number,
): ScoredChunk<T>[] {
  if (topK <= 0) return [];

  const scored: ScoredChunk<T>[] = [];
  for (const chunk of chunks) {
    const score = cosineSimilarity(queryEmbedding, getEmbedding(chunk));
    // Abschnitte ohne jede Aehnlichkeit gar nicht erst einsortieren.
    if (score > 0) scored.push({ chunk, score });
  }

  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, topK);
}
