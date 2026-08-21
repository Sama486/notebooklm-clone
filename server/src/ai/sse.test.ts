import { describe, expect, it } from 'vitest';
import { sseTextChunks, textFromEvent } from './sse.js';

/** Macht aus einer Zeichenkette einen Bytestrom mit fester Paketgrösse. */
async function* asPackets(text: string, size: number): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
}

async function collect(source: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const part of source) text += part;
  return text;
}

const event = (payload: unknown, newline: string) => `data: ${JSON.stringify(payload)}${newline}${newline}`;
const textEvent = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });

describe('Zerlegung des Ereignisstroms', () => {
  it('liest Ereignisse mit \\r\\n\\r\\n als Trennung', async () => {
    // GENAU DIESER FALL war der Fehler: Gemini trennt seine Ereignisse mit
    // Wagenrücklauf. Ein Parser, der nur \n\n kennt, findet nie ein
    // vollständiges Ereignis und liefert eine leere Antwort aus - ohne
    // Fehlermeldung, einfach nichts.
    const stream =
      event(textEvent('Die Antwort '), '\r\n') +
      event(textEvent('ist 404 '), '\r\n') +
      event(textEvent('[1].'), '\r\n');

    expect(await collect(sseTextChunks(asPackets(stream, 4096)))).toBe('Die Antwort ist 404 [1].');
  });

  it('liest ebenso Ereignisse mit \\n\\n als Trennung', async () => {
    const stream = event(textEvent('Eins '), '\n') + event(textEvent('zwei.'), '\n');
    expect(await collect(sseTextChunks(asPackets(stream, 4096)))).toBe('Eins zwei.');
  });

  it('liefert dasselbe Ergebnis bei jeder Paketgrösse', async () => {
    const stream =
      event(textEvent('Die Berechtigungsprüfung '), '\r\n') +
      event(textEvent('steht im Zugriffspfad '), '\r\n') +
      event(textEvent('[1] und nirgends sonst.'), '\r\n');
    const erwartet = 'Die Berechtigungsprüfung steht im Zugriffspfad [1] und nirgends sonst.';

    // Ein Ereignis kann an jeder Stelle zerschnitten ankommen - auch mitten in
    // der Trennung zwischen zwei Ereignissen.
    for (const size of [1, 2, 3, 7, 16, 64, 1024]) {
      expect(await collect(sseTextChunks(asPackets(stream, size))), `Paketgrösse ${size}`).toBe(
        erwartet,
      );
    }
  });

  it('behält Mehrbyte-Zeichen, die zwischen zwei Paketen zerrissen sind', async () => {
    // Umlaute und Emoji belegen mehrere Bytes. Ohne stream-Modus im Decoder
    // entstünde an der Bruchstelle ein Ersatzzeichen.
    const stream = event(textEvent('Grundsätzliche Prüfung 🔐 der Zuständigkeit.'), '\r\n');

    for (const size of [1, 2, 3, 5]) {
      expect(await collect(sseTextChunks(asPackets(stream, size)))).toBe(
        'Grundsätzliche Prüfung 🔐 der Zuständigkeit.',
      );
      expect(await collect(sseTextChunks(asPackets(stream, size)))).not.toContain('�');
    }
  });

  it('liefert ein letztes Ereignis ohne abschließende Leerzeile aus', async () => {
    // Manche Server schließen den Strom direkt hinter dem letzten Ereignis.
    const stream = `data: ${JSON.stringify(textEvent('Schluss.'))}`;
    expect(await collect(sseTextChunks(asPackets(stream, 8)))).toBe('Schluss.');
  });

  it('lässt Denkschritte weg', async () => {
    // Denk-Token sind nicht die Antwort. Sie gehören nicht ins Fenster des
    // Nutzers und nicht in den gespeicherten Antworttext.
    const gedanke = {
      candidates: [
        { content: { parts: [{ text: 'Ich überlege...', thought: true }, { text: 'Antwort.' }] } },
      ],
    };
    expect(await collect(sseTextChunks(asPackets(event(gedanke, '\r\n'), 4096)))).toBe('Antwort.');
  });

  it('überspringt ein unlesbares Ereignis, statt den Strom abzubrechen', async () => {
    const stream =
      event(textEvent('Erstes. '), '\r\n') +
      'data: {kein gültiges json\r\n\r\n' +
      event(textEvent('Drittes.'), '\r\n');

    expect(await collect(sseTextChunks(asPackets(stream, 4096)))).toBe('Erstes. Drittes.');
  });

  it('ignoriert Kommentar- und Ereignisnamenzeilen', async () => {
    const stream = `: Kommentar\r\nevent: message\r\ndata: ${JSON.stringify(textEvent('Text.'))}\r\n\r\n`;
    expect(await collect(sseTextChunks(asPackets(stream, 4096)))).toBe('Text.');
  });

  it('gibt bei leerem Strom nichts zurück', async () => {
    expect(await collect(sseTextChunks(asPackets('', 16)))).toBe('');
  });
});

describe('Einzelnes Ereignis', () => {
  it('setzt mehrere data-Zeilen zusammen', async () => {
    const payload = JSON.stringify(textEvent('Zusammengesetzt.'));
    const half = Math.floor(payload.length / 2);
    const event = `data: ${payload.slice(0, half)}\r\ndata: ${payload.slice(half)}`;
    expect(textFromEvent(event)).toBe('Zusammengesetzt.');
  });

  it('behandelt [DONE] als Ende und nicht als Text', () => {
    expect(textFromEvent('data: [DONE]')).toBe('');
  });

  it('gibt bei einem Ereignis ohne Kandidaten nichts zurück', () => {
    expect(textFromEvent('data: {"usageMetadata":{"totalTokenCount":12}}')).toBe('');
  });
});
