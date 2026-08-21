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

export interface ScrubResult {
  /** Text, der sofort an den Client gehen darf. */
  text: string;
  /** Marker-Nummern in der Reihenfolge ihres Auftretens. */
  markers: number[];
}

/**
 * Laengster Praefix eines vollstaendigen Markers, der noch kein Marker ist:
 * "[" plus bis zu drei Ziffern. Mehr als drei Ziffern kann ein Marker nicht
 * haben, weil nie mehr als eine zweistellige Zahl an Textstellen im Prompt
 * steht - die Grenze verhindert, dass eine oeffnende Klammer in normalem Text
 * den Strom unbegrenzt anhaelt.
 */
const MAX_HELD = 4;

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
      // Nur Ziffern dahinter und keine schliessende Klammer: koennte noch
      // einer werden.
      return /^\d*$/.test(tail) ? i : buffer.length;
    }
    return buffer.length;
  }
}

/**
 * Entfernt vollstaendige Marker aus einem entschiedenen Textstueck und gibt
 * ihre Nummern zurueck.
 *
 * Der Marker verschwindet aus dem Text: die Oberflaeche setzt an seiner Stelle
 * einen anklickbaren Chip. Wuerde er stehen bleiben, stuende die Nummer doppelt
 * da - einmal als Text, einmal als Chip.
 */
function extractMarkers(text: string): ScrubResult {
  if (!text.includes('[')) return { text, markers: [] };

  const markers: number[] = [];
  const cleaned = text.replace(COMPLETE_MARKER, (_match, digits: string) => {
    markers.push(Number.parseInt(digits, 10));
    return '';
  });
  return { text: cleaned, markers };
}
