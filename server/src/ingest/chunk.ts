import { limits } from '../config.js';

/**
 * Zerlegt einen Volltext in überlappende Abschnitte und führt dabei die
 * Zeichen-Positionen im Ursprungstext mit.
 *
 * `charStart` und `charEnd` sind der Grund, warum diese Funktion so aussieht,
 * wie sie aussieht. Ohne sie kann die Oberfläche nicht zur zitierten Stelle
 * springen - und die Zitatfunktion ist das Kernfeature. Deshalb wird der Text
 * nie umgeschrieben, nie normalisiert und nie getrimmt: jeder zurückgegebene
 * Abschnitt erfüllt `text.slice(charStart, charEnd) === content`. Genau das
 * prüft der Test.
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
 * Grobe Umrechnung Token -> Zeichen für deutschen Text.
 *
 * Deutsche Texte liegen mit Gemini-artigen Tokenizern bei ungefähr 3,5 Zeichen
 * je Token - Komposita wie "Berechtigungsprüfung" werden in mehrere Stücke
 * zerlegt. Der Wert muss nicht exakt sein: er steuert die Abschnittsgrösse,
 * und die darf um zwanzig Prozent danebenliegen, ohne dass die Trefferqualität
 * leidet. Ein echter Tokenizer wäre ein Netzaufruf je Abschnitt - dieser Preis
 * steht in keinem Verhältnis.
 */
const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const targetChars = Math.round(limits.chunking.targetTokens * CHARS_PER_TOKEN);
const overlapChars = Math.round(limits.chunking.overlapTokens * CHARS_PER_TOKEN);
const minChars = Math.round(limits.chunking.minTokens * CHARS_PER_TOKEN);

/**
 * Seitenumbrüche aus der PDF-Extraktion: `pageBreaks[i]` ist die
 * Zeichen-Position, an der Seite `i + 2` beginnt. Für Text- und URL-Quellen
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
    // Satz aufhört, verliert genau den Zusammenhang, den das Embedding
    // abbilden soll.
    const end =
      hardEnd >= text.length ? text.length : bestBoundary(text, boundaries, cursor, hardEnd);

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

    // Überlappung: der nächste Abschnitt beginnt ein Stück vor dem Ende des
    // vorigen. Ohne sie fällt eine Aussage, die genau über der Schnittkante
    // liegt, bei der Suche durch beide Raster.
    // Auch der Startpunkt des nächsten Abschnitts muss an einer Wortgrenze
    // liegen - er ist eine reine Rechnung (Ende minus Überlappung) und landet
    // sonst genauso mitten im Wort wie ein harter Schnitt.
    const next = zurWortgrenze(text, Math.max(end - overlapChars, cursor + 1), cursor + 1);
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
  // Satzenden als zweite Wahl, wenn ein Absatz länger ist als ein Abschnitt.
  for (const match of text.matchAll(/[.!?:]["')\]]?\s+/g)) {
    positions.add(match.index + match[0].length);
  }
  return [...positions].sort((a, b) => a - b);
}

/**
 * Größte Grenze, die noch vor `hardEnd` liegt und nicht zu dicht hinter
 * `start` - sonst entstünden Splitter statt Abschnitte. Findet sich keine,
 * wird hart bei `hardEnd` geschnitten.
 */
function bestBoundary(
  text: string,
  boundaries: number[],
  start: number,
  hardEnd: number,
): number {
  const earliest = start + Math.round(targetChars * 0.5);
  let best = -1;

  // Aufsteigend sortiert: die letzte passende Grenze ist die größte.
  for (const position of boundaries) {
    if (position > hardEnd) break;
    if (position >= earliest) best = position;
  }
  // Keine Satzgrenze in Reichweite: dann wenigstens an einer Wortgrenze.
  return best === -1 ? zurWortgrenze(text, hardEnd, earliest) : best;
}

/**
 * Schiebt eine Position rückwärts bis vor das laufende Wort.
 *
 * Ohne diesen Schritt fällt ein Schnitt mitten in ein Wort oder eine Zahl. Im
 * Export eines Lebenslaufs war das zu sehen: ein Abschnitt begann mit "23", dem
 * Rest der Jahreszahl 2023. Das ist nicht nur hässlich - der abgeschnittene
 * Rest geht genauso ins Embedding, und die Hervorhebung im Dokument beginnt
 * mitten im Wort.
 *
 * `mindestens` verhindert, dass ein sehr langes Wort ohne Leerzeichen (etwa
 * eine lange Zahlenkolonne) den Schnitt beliebig weit nach vorn zieht. Ist
 * keine Wortgrenze in Reichweite, bleibt es beim harten Schnitt.
 */
function zurWortgrenze(text: string, position: number, mindestens: number): number {
  if (position <= mindestens || position >= text.length) return position;

  let gefunden = position;
  while (gefunden > mindestens && !/\s/.test(text[gefunden - 1] ?? '')) gefunden -= 1;

  return gefunden > mindestens ? gefunden : position;
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
 * Hängt einen zu kurzen letzten Abschnitt an seinen Vorgänger.
 *
 * Ein Rest von zwanzig Zeichen bekommt sonst ein eigenes Embedding und
 * konkurriert bei der Suche mit vollwertigen Abschnitten - bei sehr kurzem Text
 * ist die Kosinus-Ähnlichkeit zufällig hoch.
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
