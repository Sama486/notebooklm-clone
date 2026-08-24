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
 * Geschnitten wird an Satzgrenzen, und zwar an beiden Enden. Das Ende war
 * schon immer so; der Anfang war lange eine reine Rechnung (Ende minus
 * Überlappung), nur auf die nächste Wortgrenze gerückt. Damit begann jeder
 * Abschnitt ab dem zweiten mitten im Satz. Für die Suche ist das folgenlos,
 * für den Beleg nicht: der Ausschnitt ist das, was der Nutzer als Nachweis
 * liest, und einer, der mit "zu begleiten, ist für mich" anfängt, wirkt wie
 * ein Fehler. Deshalb ist die kleinste Einheit hier der Satz, nicht das
 * Zeichen.
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

  const grenzen = satzgrenzen(text);
  const chunks: Chunk[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const hardEnd = Math.min(cursor + targetChars, text.length);
    const end = hardEnd >= text.length ? text.length : satzendeVor(text, grenzen, cursor, hardEnd);

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

    cursor = naechsterAnfang(text, grenzen, cursor, end);
  }

  return mergeTinyTail(chunks, text);
}

/**
 * Positionen, an denen ein neuer Satz beginnt - aufsteigend, ohne Duplikate.
 *
 * Dieselbe Liste bedient beide Enden: das Ende eines Abschnitts ist die
 * grösste dieser Positionen, die noch ins Fenster passt, sein Anfang die
 * grösste, die die geforderte Überlappung noch einhält. Weil beide auf
 * derselben Liste arbeiten, kann kein Abschnitt mitten im Satz beginnen oder
 * aufhören.
 *
 * Exportiert, weil hier die Heuristik sitzt, die schiefgehen kann: über
 * `chunkText` liesse sie sich nur mit seitenlangen Texten prüfen, direkt mit
 * einem Einzeiler je Fall.
 */
export function satzgrenzen(text: string): number[] {
  const positionen = new Set<number>();

  for (const match of text.matchAll(/\n[ \t]*\n/g)) {
    const position = match.index + match[0].length;
    if (position < text.length) positionen.add(position);
  }

  // Das Wort vor dem Satzzeichen, dahinter ein optionales schliessendes
  // Anführungs- oder Klammerzeichen, dann Leerraum. Ohne den geforderten
  // Leerraum wäre der Punkt in "web.de" ein Satzende.
  for (const match of text.matchAll(/([^\s.!?:]*)([.!?:])["’»')\]]?\s+/g)) {
    const position = match.index + match[0].length;
    if (position >= text.length) continue;
    if (!istSatzende(match[1] ?? '', match[2] ?? '', text[position] ?? '')) continue;
    positionen.add(position);
  }

  return [...positionen].sort((a, b) => a - b);
}

/**
 * Abkürzungen, nach denen ein Punkt kein Satzende ist.
 *
 * Bewusst kurz und deutschsprachig statt vollständig: die Liste fängt die
 * Fälle ab, die in Bewerbungen, Berichten und Fachtexten wirklich vorkommen.
 * Was sie nicht kennt, fängt in aller Regel die Prüfung darunter ab - im
 * Deutschen beginnt ein Satz gross, eine Fortsetzung nach einer Abkürzung
 * klein.
 */
const ABKUERZUNGEN = new Set([
  'abb', 'abs', 'art', 'bspw', 'bzw', 'ca', 'dr', 'etc', 'evtl', 'ff', 'ggf', 'inkl', 'kap',
  'max', 'min', 'mio', 'mrd', 'nr', 'prof', 'sog', 'str', 'tel', 'usw', 'vgl', 'zzgl',
]);

/**
 * Ob an dieser Stelle wirklich ein Satz endet.
 *
 * Ohne diese Prüfung zerfällt "12. August 2026" in zwei Sätze und "z. B." in
 * drei. Das wäre nicht nur hässlich: aus solchen Splittern entstehen echte
 * Abschnittsgrenzen, und ein Beleg, der mit "August 2026 Bewerbung als"
 * beginnt, ist genauso unbrauchbar wie ein Schnitt mitten im Wort.
 */
function istSatzende(wort: string, zeichen: string, folgezeichen: string): boolean {
  // Ein Kleinbuchstabe danach ist im Deutschen kein Satzanfang.
  if (/[a-zäöüß]/.test(folgezeichen)) return false;
  if (zeichen !== '.') return true;
  if (/^\d+$/.test(wort)) return false; // Ordnungszahl: "12. August"
  if (wort.length <= 1) return false; // Initial oder der erste Teil von "z. B."

  return !ABKUERZUNGEN.has(wort.toLowerCase());
}

/**
 * Grösste Satzgrenze, die noch vor `hardEnd` liegt und nicht zu dicht hinter
 * `start` - sonst entstünden Splitter statt Abschnitte. Findet sich keine, ist
 * der Satz länger als ein ganzer Abschnitt; dann wird an einer Wortgrenze
 * geschnitten, weil es keine bessere Möglichkeit gibt.
 */
function satzendeVor(text: string, grenzen: number[], start: number, hardEnd: number): number {
  const earliest = start + Math.round(targetChars * 0.5);
  let best = -1;

  // Aufsteigend sortiert: die letzte passende Grenze ist die grösste.
  for (const position of grenzen) {
    if (position > hardEnd) break;
    if (position >= earliest) best = position;
  }

  return best === -1 ? zurWortgrenze(text, hardEnd, earliest) : best;
}

/**
 * Anfang des nächsten Abschnitts: die grösste Satzgrenze, die die geforderte
 * Überlappung noch einhält.
 *
 * Rückwärts statt vorwärts, und das ist der Punkt: vorwärts zum nächsten
 * Satzanfang würde die Überlappung verkleinern oder ganz aufbrauchen - und die
 * existiert, damit eine Aussage, die genau über der Schnittkante liegt, nicht
 * durch beide Raster fällt. Rückwärts vergrössert sie um höchstens einen Satz.
 *
 * Der Rückgabewert liegt immer echt zwischen `cursor` und `end`: echt über
 * `cursor`, sonst liefe die Schleife ewig, und echt unter `end`, sonst gäbe es
 * keine Überlappung.
 */
function naechsterAnfang(text: string, grenzen: number[], cursor: number, end: number): number {
  const ziel = end - overlapChars;
  let best = -1;

  for (const position of grenzen) {
    if (position > ziel) break;
    if (position > cursor) best = position;
  }
  if (best !== -1) return best;

  // Kein Satzanfang in Reichweite - etwa in einem Text ganz ohne Satzzeichen.
  // Dann wenigstens eine Wortgrenze, wie vor der Umstellung.
  return zurWortgrenze(text, Math.max(ziel, cursor + 1), cursor + 1);
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
