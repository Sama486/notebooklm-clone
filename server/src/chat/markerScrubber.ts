/**
 * Fischt Zitat-Marker der Form [n] aus einem Antwortstrom.
 *
 * DIE FALLE: das Modell liefert die Antwort in Paketen beliebiger Groesse. Ein
 * Marker kann dabei mitten hindurch zerrissen werden - ein Paket endet mit "[",
 * das naechste beginnt mit "3]". Wer jedes Paket fuer sich durchsucht, findet
 * den Marker nicht und schiebt dem Nutzer stattdessen ein einzelnes "[" ins
 * Fenster, das dort stehen bleibt.
 *
 * DIE LOESUNG: ein Rueckhaltefenster am Pufferende. Alles, was unmoeglich noch
 * Teil eines angefangenen Markers sein kann, geht sofort raus. Nur der
 * moegliche Anfang eines Markers wird zurueckgehalten, bis das naechste Paket
 * kommt oder der Strom endet. Zurueckgehalten werden hoechstens ein paar
 * Zeichen - an der wahrgenommenen Geschwindigkeit aendert das nichts.
 *
 * Reine Zustandsmaschine: keine Datenbank, kein Netz, kein Modellaufruf. Damit
 * ist genau der Teil billig testbar, in dem die Fehler sitzen.
 */

/**
 * Ein Stueck Text und die Marker, die unmittelbar DAHINTER standen.
 *
 * Die Aufteilung in Segmente ist der Grund, warum das Ergebnis nicht einfach
 * aus Text plus einer Liste von Nummern besteht: ein Paket kann mehrere Marker
 * an verschiedenen Stellen enthalten ("A [1] B [2] C"). Wer nur sammelt, welche
 * Nummern vorkamen, weiss nicht mehr, wo sie standen - und die Oberflaeche
 * haengt dann alle Chips ans Ende des Pakets statt hinter die Aussage, die sie
 * belegen. Aus "koennte [1]." wuerde "koennte ." gefolgt vom Chip.
 */
export interface Segment {
  text: string;
  markers: number[];
}

export interface ScrubResult {
  /** Segmente, die sofort an den Client gehen duerfen - in Reihenfolge. */
  segments: Segment[];
}

/**
 * Laengster Praefix eines vollstaendigen Markers, der noch kein Marker ist:
 * "[" plus bis zu drei Ziffern. Mehr als drei Ziffern kann ein Marker nicht
 * haben, weil nie mehr als eine zweistellige Zahl an Textstellen im Prompt
 * steht - die Grenze verhindert, dass eine oeffnende Klammer in normalem Text
 * den Strom unbegrenzt anhaelt.
 */
const MAX_HELD = 4;

/** Wie viele Leerzeichen hoechstens mit zurueckgehalten werden. */
const MAX_HELD_SPACES = 4;

const COMPLETE_MARKER = /\[(\d{1,3})\]/g;

export class MarkerScrubber {
  /** Zurueckgehaltener Rest, der noch Anfang eines Markers sein koennte. */
  private held = '';

  /**
   * Nimmt das naechste Paket entgegen und gibt zurueck, was ausgeliefert
   * werden darf.
   */
  push(part: string): ScrubResult {
    const buffer = this.held + part;
    this.held = '';

    // Ab dieser Position koennte ein angefangener Marker stehen. Alles davor
    // ist entschieden und darf raus.
    const holdFrom = this.partialMarkerStart(buffer);
    const decided = buffer.slice(0, holdFrom);
    this.held = buffer.slice(holdFrom);

    return extractMarkers(decided);
  }

  /**
   * Schliesst den Strom ab. Ein zurueckgehaltener Rest ist jetzt endgueltig
   * kein Marker mehr - er war normaler Text und wird ausgeliefert.
   */
  flush(): ScrubResult {
    const rest = this.held;
    this.held = '';
    return extractMarkers(rest);
  }

  /**
   * Position, ab der der Puffer der Anfang eines Markers sein koennte.
   *
   * Gesucht wird die letzte oeffnende Klammer im Rueckhaltefenster; steht
   * dahinter nur noch "[" gefolgt von Ziffern, ist der Marker moeglicherweise
   * unvollstaendig und wird zurueckgehalten. Alles andere - etwa "[Anmerkung"
   * oder eine bereits geschlossene Klammer - ist entschieden.
   */
  private partialMarkerStart(buffer: string): number {
    const windowStart = Math.max(0, buffer.length - MAX_HELD);

    for (let i = buffer.length - 1; i >= windowStart; i -= 1) {
      if (buffer[i] !== '[') continue;
      const tail = buffer.slice(i + 1);
      // Etwas anderes als Ziffern dahinter: das wird kein Marker mehr.
      if (!/^\d*$/.test(tail)) return buffer.length;

      // Die Leerzeichen unmittelbar davor gehoeren mit ins Rueckhaltefenster.
      // Sonst waeren sie schon ausgeliefert, wenn sich der Marker als solcher
      // herausstellt - und die Luecke vor dem Chip liesse sich nicht mehr
      // schliessen, weil das Leerzeichen in einem frueheren Paket steckt.
      return pullBackSpaces(buffer, i);
    }

    // Kein angefangener Marker in Sicht. Trotzdem bleiben Leerzeichen am
    // Pufferende zurueck: sie koennten vor einem Marker stehen, der erst im
    // naechsten Paket beginnt. Kommen sie schon jetzt heraus, liesse sich die
    // Luecke vor dem Chip spaeter nicht mehr schliessen - genau das passiert
    // bei Paketgroesse eins, wo jedes Zeichen einzeln ankommt.
    return pullBackSpaces(buffer, buffer.length);
  }
}

/**
 * Verschiebt den Anfang des Rueckhaltefensters ueber unmittelbar davor
 * stehende Leerzeichen nach vorn.
 *
 * Begrenzt, damit eine lange Folge von Leerzeichen den Strom nicht anhaelt.
 */
function pullBackSpaces(buffer: string, from: number): number {
  const limit = Math.max(0, from - MAX_HELD_SPACES);
  let start = from;
  while (start > limit && (buffer[start - 1] === ' ' || buffer[start - 1] === '\t')) start -= 1;
  return start;
}

/**
 * Zerlegt ein entschiedenes Textstueck an seinen Markern in Segmente.
 *
 * Der Marker selbst verschwindet aus dem Text: die Oberflaeche setzt an seiner
 * Stelle einen anklickbaren Chip. Wuerde er stehen bleiben, stuende die Nummer
 * doppelt da - einmal als Text, einmal als Chip.
 *
 * Ein Leerzeichen unmittelbar vor dem Marker faellt weg. Das Modell schreibt
 * "... Aussage [1]." - ohne diesen Schritt entstuende "... Aussage " gefolgt
 * vom Chip und einem einzeln stehenden Punkt.
 */
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
    const marker = Number.parseInt(match[1] as string, 10);

    const last = segments.at(-1);
    // Zwei Marker direkt hintereinander ("[1][2]") gehoeren an dasselbe
    // Textstueck, nicht an ein leeres dazwischen.
    if (before === '' && last) last.markers.push(marker);
    else segments.push({ text: before, markers: [marker] });

    cursor = match.index + match[0].length;
  }

  const rest = text.slice(cursor);
  if (rest) segments.push({ text: rest, markers: [] });

  return { segments };
}
