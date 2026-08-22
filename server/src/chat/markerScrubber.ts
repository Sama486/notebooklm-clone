/**
 * Fischt Zitat-Marker der Form [n] aus einem Antwortstrom.
 *
 * DIE FALLE: das Modell liefert die Antwort in Paketen beliebiger Größe. Ein
 * Marker kann dabei mitten hindurch zerrissen werden - ein Paket endet mit "[",
 * das nächste beginnt mit "3]". Wer jedes Paket für sich durchsucht, findet
 * den Marker nicht und schiebt dem Nutzer stattdessen ein einzelnes "[" ins
 * Fenster, das dort stehen bleibt.
 *
 * DIE LOESUNG: ein Rückhaltefenster am Pufferende. Alles, was unmöglich noch
 * Teil eines angefangenen Markers sein kann, geht sofort raus. Nur der
 * mögliche Anfang eines Markers wird zurückgehalten, bis das nächste Paket
 * kommt oder der Strom endet. Zurückgehalten werden höchstens ein paar
 * Zeichen - an der wahrgenommenen Geschwindigkeit ändert das nichts.
 *
 * Reine Zustandsmaschine: keine Datenbank, kein Netz, kein Modellaufruf. Damit
 * ist genau der Teil billig testbar, in dem die Fehler sitzen.
 */

/**
 * Ein Stück Text und die Marker, die unmittelbar DAHINTER standen.
 *
 * Die Aufteilung in Segmente ist der Grund, warum das Ergebnis nicht einfach
 * aus Text plus einer Liste von Nummern besteht: ein Paket kann mehrere Marker
 * an verschiedenen Stellen enthalten ("A [1] B [2] C"). Wer nur sammelt, welche
 * Nummern vorkamen, weiß nicht mehr, wo sie standen - und die Oberfläche
 * hängt dann alle Chips ans Ende des Pakets statt hinter die Aussage, die sie
 * belegen. Aus "könnte [1]." würde "könnte ." gefolgt vom Chip.
 */
export interface Segment {
  text: string;
  markers: number[];
}

export interface ScrubResult {
  /** Segmente, die sofort an den Client gehen dürfen - in Reihenfolge. */
  segments: Segment[];
}

/**
 * Längster Präfix eines vollständigen Markers, der noch kein Marker ist.
 *
 * Muss auch eine zusammengefasste Form abdecken: Modelle schreiben Belege
 * gelegentlich als "[2, 3]" statt "[2][3]". Bei höchstens acht Textstellen im
 * Prompt ist "[1, 2, 3, 4, 5, 6, 7, 8]" der längste denkbare Fall - 24 Zeichen.
 * Die Grenze verhindert, dass eine öffnende Klammer in normalem Text den Strom
 * unbegrenzt anhält.
 */
const MAX_HELD = 24;

/** Wie viele Leerzeichen höchstens mit zurückgehalten werden. */
const MAX_HELD_SPACES = 4;

/**
 * Ein vollständiger Marker: eine Zahl oder mehrere durch Komma getrennte.
 *
 * Die zusammengefasste Form stand ursprünglich nicht drin, und das Ergebnis war
 * in der Oberfläche zu sehen: aus "[2, 3]" wurden keine Chips, die Klammer
 * blieb als Text stehen und Beleg 2 ging verloren. Der System-Prompt verlangt
 * jetzt die Einzelform - aber ein Prompt ist eine Bitte, keine Zusicherung,
 * deshalb wird die zusammengefasste Form hier trotzdem verstanden.
 */
const COMPLETE_MARKER = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g;

/** Was noch zu einem angefangenen Marker werden kann: Ziffern, Komma, Leerraum. */
const MOEGLICHER_MARKER_REST = /^[\d,\s]*$/;

export class MarkerScrubber {
  /** Zurückgehaltener Rest, der noch Anfang eines Markers sein könnte. */
  private held = '';

  /**
   * Nimmt das nächste Paket entgegen und gibt zurück, was ausgeliefert
   * werden darf.
   */
  push(part: string): ScrubResult {
    const buffer = this.held + part;
    this.held = '';

    // Ab dieser Position könnte ein angefangener Marker stehen. Alles davor
    // ist entschieden und darf raus.
    const holdFrom = this.partialMarkerStart(buffer);
    const decided = buffer.slice(0, holdFrom);
    this.held = buffer.slice(holdFrom);

    return extractMarkers(decided);
  }

  /**
   * Schließt den Strom ab. Ein zurückgehaltener Rest ist jetzt endgültig
   * kein Marker mehr - er war normaler Text und wird ausgeliefert.
   */
  flush(): ScrubResult {
    const rest = this.held;
    this.held = '';
    return extractMarkers(rest);
  }

  /**
   * Position, ab der der Puffer der Anfang eines Markers sein könnte.
   *
   * Gesucht wird die letzte öffnende Klammer im Rückhaltefenster; steht
   * dahinter nur noch "[" gefolgt von Ziffern, ist der Marker möglicherweise
   * unvollständig und wird zurückgehalten. Alles andere - etwa "[Anmerkung"
   * oder eine bereits geschlossene Klammer - ist entschieden.
   */
  private partialMarkerStart(buffer: string): number {
    const windowStart = Math.max(0, buffer.length - MAX_HELD);

    const letzteKlammer = buffer.lastIndexOf('[');

    // Nur die LETZTE öffnende Klammer kann noch ein Marker werden. Frühere sind
    // längst entschieden - und eine tote Klammer wie in "a[i]" darf die Prüfung
    // nicht abbrechen, sonst bleibt das Leerzeichen am Pufferende unbehandelt.
    // Genau daran ist das Vergrößern des Fensters zuerst gescheitert: eine
    // Klammer zwanzig Zeichen vorher lag plötzlich mit im Fenster.
    if (
      letzteKlammer >= windowStart &&
      MOEGLICHER_MARKER_REST.test(buffer.slice(letzteKlammer + 1))
    ) {
      // Die Leerzeichen unmittelbar davor gehören mit ins Rückhaltefenster.
      // Sonst wären sie schon ausgeliefert, wenn sich der Marker als solcher
      // herausstellt - und die Lücke vor dem Chip ließe sich nicht mehr
      // schließen, weil das Leerzeichen in einem früheren Paket steckt.
      return pullBackSpaces(buffer, letzteKlammer);
    }

    // Kein angefangener Marker in Sicht. Trotzdem bleiben Leerzeichen am
    // Pufferende zurück: sie könnten vor einem Marker stehen, der erst im
    // nächsten Paket beginnt. Kommen sie schon jetzt heraus, ließe sich die
    // Lücke vor dem Chip später nicht mehr schließen - genau das passiert
    // bei Paketgrösse eins, wo jedes Zeichen einzeln ankommt.
    return pullBackSpaces(buffer, buffer.length);
  }
}

/**
 * Verschiebt den Anfang des Rückhaltefensters über unmittelbar davor
 * stehende Leerzeichen nach vorn.
 *
 * Begrenzt, damit eine lange Folge von Leerzeichen den Strom nicht anhält.
 */
function pullBackSpaces(buffer: string, from: number): number {
  const limit = Math.max(0, from - MAX_HELD_SPACES);
  let start = from;
  while (start > limit && (buffer[start - 1] === ' ' || buffer[start - 1] === '\t')) start -= 1;
  return start;
}

/**
 * Zerlegt ein entschiedenes Textstück an seinen Markern in Segmente.
 *
 * Der Marker selbst verschwindet aus dem Text: die Oberfläche setzt an seiner
 * Stelle einen anklickbaren Chip. Würde er stehen bleiben, stünde die Nummer
 * doppelt da - einmal als Text, einmal als Chip.
 *
 * Ein Leerzeichen unmittelbar vor dem Marker fällt weg. Das Modell schreibt
 * "... Aussage [1]." - ohne diesen Schritt entstünde "... Aussage " gefolgt
 * vom Chip und einem einzeln stehenden Punkt.
 */
/**
 * Zerlegt einen fertigen Text an seinen Markern - ohne Strom, ohne Zustand.
 *
 * Wird beim Laden gespeicherter Nachrichten gebraucht: die Antwort liegt dort
 * mitsamt ihren Markern in der Datenbank, und die Oberflaeche braucht daraus
 * wieder Segmente. Dieselbe Zerlegung wie beim Streamen, damit es genau eine
 * Stelle gibt, die versteht, was ein Marker ist.
 */
export function splitMarkers(text: string): Segment[] {
  return extractMarkers(text).segments;
}

function extractMarkers(text: string): ScrubResult {
  if (!text.includes('[')) {
    return { segments: text ? [{ text, markers: [] }] : [] };
  }

  const segments: Segment[] = [];
  let cursor = 0;

  COMPLETE_MARKER.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = COMPLETE_MARKER.exec(text)) !== null) {
    const before = text.slice(cursor, match.index).replace(/[ \t]+$/, '');
    // "[2, 3]" ergibt zwei Belege an derselben Stelle im Text.
    const marker = (match[1] as string)
      .split(',')
      .map((teil) => Number.parseInt(teil.trim(), 10))
      .filter((zahl) => Number.isInteger(zahl));

    const last = segments.at(-1);
    // Zwei Marker direkt hintereinander ("[1][2]") gehören an dasselbe
    // Textstück, nicht an ein leeres dazwischen.
    if (before === '' && last) last.markers.push(...marker);
    else segments.push({ text: before, markers: marker });

    cursor = match.index + match[0].length;
  }

  const rest = text.slice(cursor);
  if (rest) segments.push({ text: rest, markers: [] });

  return { segments };
}
