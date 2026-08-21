import { limits } from '../config.js';

/**
 * Zerlegt einen Volltext in ueberlappende Abschnitte und fuehrt dabei die
 * Zeichen-Positionen im Ursprungstext mit.
 *
 * `charStart` und `charEnd` sind der Grund, warum diese Funktion so aussieht,
 * wie sie aussieht. Ohne sie kann die Oberflaeche nicht zur zitierten Stelle
 * springen - und die Zitatfunktion ist das Kernfeature. Deshalb wird der Text
 * nie umgeschrieben, nie normalisiert und nie getrimmt: jeder zurueckgegebene
 * Abschnitt erfuellt `text.slice(charStart, charEnd) === content`. Genau das
 * prueft der Test.
 *
 * Reine Funktion, kein Netz, keine Datenbank - deshalb billig zu testen.
 */

export interface Chunk {
  index: number;
  content: string;
  charStart: number;
  charEnd: number;
  tokenCount: number;
  page: number | undefined;
}

/**
 * Grobe Umrechnung Token -> Zeichen fuer deutschen Text.
 *
 * Deutsche Texte liegen mit Gemini-artigen Tokenizern bei ungefaehr 3,5 Zeichen
 * je Token - Komposita wie "Berechtigungspruefung" werden in mehrere Stuecke
 * zerlegt. Der Wert muss nicht exakt sein: er steuert die Abschnittsgroesse,
 * und die darf um zwanzig Prozent danebenliegen, ohne dass die Trefferqualitaet
 * leidet. Ein echter Tokenizer waere ein Netzaufruf je Abschnitt - dieser Preis
 * steht in keinem Verhaeltnis.
 */
const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const targetChars = Math.round(limits.chunking.targetTokens * CHARS_PER_TOKEN);
const overlapChars = Math.round(limits.chunking.overlapTokens * CHARS_PER_TOKEN);
const minChars = Math.round(limits.chunking.minTokens * CHARS_PER_TOKEN);

/**
 * Seitenumbrueche aus der PDF-Extraktion: `pageBreaks[i]` ist die
 * Zeichen-Position, an der Seite `i + 2` beginnt. Fuer Text- und URL-Quellen
 * bleibt die Liste leer und `page` damit `undefined`.
 */
export function chunkText(text: string, pageBreaks: number[] = []): Chunk[] {
  if (text.trim().length === 0) return [];

  const boundaries = paragraphBoundaries(text);
  const chunks: Chunk[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const hardEnd = Math.min(cursor + targetChars, text.length);
    // Bevorzugt an einer Absatzgrenze schneiden. Ein Abschnitt, der mitten im
    // Satz aufhoert, verliert genau den Zusammenhang, den das Embedding
    // abbilden soll.
    const end = hardEnd >= text.length ? text.length : bestBoundary(boundaries, cursor, hardEnd);

    const content = text.slice(cursor, end);
    if (content.trim().length > 0) {
      chunks.push({
        index: chunks.length,
        content,
        charStart: cursor,
        charEnd: end,
        tokenCount: estimateTokens(content),
        page: pageAt(cursor, pageBreaks),
      });
    }

    if (end >= text.length) break;

    // Ueberlappung: der naechste Abschnitt beginnt ein Stueck vor dem Ende des
    // vorigen. Ohne sie faellt eine Aussage, die genau ueber der Schnittkante
    // liegt, bei der Suche durch beide Raster.
    const next = Math.max(end - overlapChars, cursor + 1);
    cursor = next;
  }

  return mergeTinyTail(chunks, text);
}

/** Positionen hinter Absatz- und danach Satzgrenzen, aufsteigend. */
function paragraphBoundaries(text: string): number[] {
  const positions = new Set<number>();

  for (const match of text.matchAll(/\n[ \t]*\n/g)) {
    positions.add(match.index + match[0].length);
  }
  // Satzenden als zweite Wahl, wenn ein Absatz laenger ist als ein Abschnitt.
  for (const match of text.matchAll(/[.!?:]["')\]]?\s+/g)) {
    positions.add(match.index + match[0].length);
  }
  return [...positions].sort((a, b) => a - b);
}

/**
 * Groesste Grenze, die noch vor `hardEnd` liegt und nicht zu dicht hinter
 * `start` - sonst entstuenden Splitter statt Abschnitte. Findet sich keine,
 * wird hart bei `hardEnd` geschnitten.
 */
function bestBoundary(boundaries: number[], start: number, hardEnd: number): number {
  const earliest = start + Math.round(targetChars * 0.5);
  let best = -1;

  // Aufsteigend sortiert: die letzte passende Grenze ist die groesste.
  for (const position of boundaries) {
    if (position > hardEnd) break;
    if (position >= earliest) best = position;
  }
  return best === -1 ? hardEnd : best;
}

/** Seitenzahl (1-basiert) zur Zeichen-Position, oder `undefined` ohne Seiten. */
function pageAt(charPosition: number, pageBreaks: number[]): number | undefined {
  if (pageBreaks.length === 0) return undefined;
  let page = 1;
  for (const start of pageBreaks) {
    if (charPosition >= start) page += 1;
    else break;
  }
  return page;
}

/**
 * Haengt einen zu kurzen letzten Abschnitt an seinen Vorgaenger.
 *
 * Ein Rest von zwanzig Zeichen bekommt sonst ein eigenes Embedding und
 * konkurriert bei der Suche mit vollwertigen Abschnitten - bei sehr kurzem Text
 * ist die Kosinus-Aehnlichkeit zufaellig hoch.
 */
function mergeTinyTail(chunks: Chunk[], text: string): Chunk[] {
  if (chunks.length < 2) return chunks;

  const last = chunks[chunks.length - 1] as Chunk;
  if (last.content.trim().length >= minChars) return chunks;

  const previous = chunks[chunks.length - 2] as Chunk;
  const merged: Chunk = {
    index: previous.index,
    charStart: previous.charStart,
    charEnd: last.charEnd,
    content: text.slice(previous.charStart, last.charEnd),
    tokenCount: estimateTokens(text.slice(previous.charStart, last.charEnd)),
    page: previous.page,
  };
  return [...chunks.slice(0, -2), merged];
}
