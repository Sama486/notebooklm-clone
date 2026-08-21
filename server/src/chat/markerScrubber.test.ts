import { describe, expect, it } from 'vitest';
import { MarkerScrubber } from './markerScrubber.js';

/** Schickt Pakete durch den Scrubber und sammelt Text und Marker ein. */
function run(parts: string[]): { text: string; markers: number[] } {
  const scrubber = new MarkerScrubber();
  const segments = [...parts.flatMap((part) => scrubber.push(part).segments), ...scrubber.flush().segments];

  return {
    text: segments.map((s) => s.text).join(''),
    markers: segments.flatMap((s) => s.markers),
  };
}

/** Baut den Text mit den Markern an ihrer Position wieder zusammen. */
function withMarkerPositions(parts: string[]): string {
  const scrubber = new MarkerScrubber();
  const segments = [...parts.flatMap((part) => scrubber.push(part).segments), ...scrubber.flush().segments];

  return segments.map((s) => s.text + s.markers.map((m) => `<${m}>`).join('')).join('');
}

/** Zerlegt eine Zeichenkette in Pakete fester Größe. */
function split(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}

describe('Marker-Erkennung im Antwortstrom', () => {
  it('erkennt einen Marker, der in einem Paket ankommt', () => {
    expect(run(['Die Prüfung erfolgt im Zugriffspfad [1].'])).toEqual({
      text: 'Die Prüfung erfolgt im Zugriffspfad.',
      markers: [1],
    });
  });

  it('behält die Position des Markers im Text', () => {
    // Der Chip gehört hinter die Aussage, die er belegt - nicht ans Ende des
    // Pakets. Ohne Segmente stünde hier "A B C<1><2>".
    expect(withMarkerPositions(['A [1] B [2] C'])).toBe('A<1> B<2> C');
  });

  it('schluckt das Leerzeichen vor dem Marker', () => {
    // Sonst entstünde "... könnte " + Chip + "." - mit einem einzeln
    // stehenden Punkt hinter dem Chip.
    expect(withMarkerPositions(['Das könnte so sein [1].'])).toBe('Das könnte so sein<1>.');
  });

  it('erkennt einen Marker, der über zwei Pakete zerrissen ist', () => {
    // DER Fall, um den es geht. Ohne Rückhaltefenster stünde beim Nutzer
    // "... Zugriffspfad [" und danach "3]".
    expect(run(['Die Prüfung erfolgt im Zugriffspfad [', '3] und nirgends sonst.'])).toEqual({
      text: 'Die Prüfung erfolgt im Zugriffspfad und nirgends sonst.',
      markers: [3],
    });
  });

  it('erkennt einen Marker, der über drei Pakete zerrissen ist', () => {
    expect(run(['Beleg [', '1', '2] dazu.'])).toEqual({ text: 'Beleg dazu.', markers: [12] });
  });

  it('erkennt einen Marker am Ende der Antwort', () => {
    // Hier greift flush(): der Strom endet direkt hinter dem Marker.
    expect(run(['Der Beleg steht dort [7]'])).toEqual({ text: 'Der Beleg steht dort', markers: [7] });
  });

  it('gibt eine unvollständige Klammer am Ende wieder frei', () => {
    // Der Strom endet mit "[" - das war kein Marker, sondern Text. Er darf
    // nicht verschluckt werden.
    expect(run(['Ein Rest ['])).toEqual({ text: 'Ein Rest [', markers: [] });
    expect(run(['Ein Rest [4'])).toEqual({ text: 'Ein Rest [4', markers: [] });
  });

  it('lässt eckige Klammern in normalem Text stehen', () => {
    const cases = [
      '[Anmerkung] steht so im Dokument.',
      'Der Ausdruck a[i] bezeichnet ein Feldelement.',
      'Leere Klammern [] bleiben.',
      'Buchstaben in Klammern [abc] bleiben.',
    ];
    for (const text of cases) {
      expect(run([text]), text).toEqual({ text, markers: [] });
    }
  });

  it('erkennt mehrere Marker hintereinander', () => {
    expect(run(['Beides trifft zu [1][2] und auch [3].'])).toEqual({
      text: 'Beides trifft zu und auch.',
      markers: [1, 2, 3],
    });
    // Zwei Marker hintereinander hängen an demselben Textstück.
    expect(withMarkerPositions(['Beides trifft zu [1][2] und auch [3].'])).toBe(
      'Beides trifft zu<1><2> und auch<3>.',
    );
  });

  it('erkennt mehrere Marker, wenn jedes Zeichen einzeln ankommt', () => {
    // Der härteste Fall: Paketgrösse 1. Wenn das hält, hält jede
    // Paketgrösse dazwischen auch.
    const original = 'Erstens [1], zweitens [22], drittens [3]. Ende [4]';
    const expected = 'Erstens, zweitens, drittens. Ende';

    expect(run(split(original, 1))).toEqual({ text: expected, markers: [1, 22, 3, 4] });
  });

  it('liefert dasselbe Ergebnis bei jeder Paketgrösse', () => {
    const original = 'Satz eins [1]. Satz [12] zwei. Ein Feld a[i] und [] leer. Schluss [3]';
    const reference = run([original]);

    for (let size = 1; size <= 12; size += 1) {
      expect(run(split(original, size)), `Paketgrösse ${size}`).toEqual(reference);
    }
  });

  it('hält höchstens vier Zeichen zurück', () => {
    // Eine öffnende Klammer in normalem Text darf den Strom nicht anhalten -
    // sonst blieben Wörter stehen, bis das Modell irgendwann fertig ist.
    const scrubber = new MarkerScrubber();
    const result = scrubber.push('Text mit [ Klammer und viel mehr Text dahinter.');
    expect(result.segments.map((s) => s.text).join('')).toBe(
      'Text mit [ Klammer und viel mehr Text dahinter.',
    );
  });

  it('hält eine vierstellige Zahl nicht fälschlich für einen Marker', () => {
    // Mehr als drei Ziffern kann kein Marker sein - es gibt nie so viele
    // Textstellen im Prompt.
    expect(run(['Jahr [2024] laut Quelle.'])).toEqual({
      text: 'Jahr [2024] laut Quelle.',
      markers: [],
    });
  });

  it('kommt mit leeren Paketen zurecht', () => {
    expect(run(['Beleg [', '', '5', '', '] hier.'])).toEqual({
      text: 'Beleg hier.',
      markers: [5],
    });
  });

  it('gibt bei leerem Strom leeren Text zurück', () => {
    expect(run([])).toEqual({ text: '', markers: [] });
    expect(run([''])).toEqual({ text: '', markers: [] });
  });

  it('lässt Text ohne Marker unverändert durch', () => {
    const text = 'Eine Antwort völlig ohne Belege, dafür mit Umlauten: ÄÖÜ und ß.';
    expect(run(split(text, 3))).toEqual({ text, markers: [] });
  });
});
