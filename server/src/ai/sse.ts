import { logger } from '../logger.js';

/**
 * Zerlegt einen Server-Sent-Events-Strom und gibt den Text der Modellantwort
 * stueckweise zurueck.
 *
 * Eigenes Modul, weil hier zwei Fallen zusammenkommen, die beide nur unter
 * echten Netzbedingungen auftreten - und die man deshalb gezielt testen muss,
 * statt sie beim Ausprobieren zu bemerken:
 *
 * 1. ZEILENENDEN. Die Spezifikation erlaubt sowohl \n\n als auch \r\n\r\n als
 *    Trennung zwischen zwei Ereignissen. Gemini verwendet \r\n\r\n. Wer nur auf
 *    \n\n prueft, findet nie ein vollstaendiges Ereignis und liefert eine leere
 *    Antwort aus - ohne Fehler, ohne Hinweis, einfach nichts.
 * 2. PAKETGRENZEN. Ein Ereignis kann mitten durchgeschnitten ankommen, und ein
 *    Mehrbyte-Zeichen ebenso. Deshalb bleibt ein unvollstaendiges Ereignis im
 *    Puffer stehen, und der Decoder laeuft mit `stream: true`.
 */

/** Trennung zwischen zwei Ereignissen, mit und ohne Wagenruecklauf. */
const EVENT_SEPARATOR = /\r?\n\r?\n/;
const LINE_SEPARATOR = /\r?\n/;

export async function* sseTextChunks(source: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const part of source) {
    // `stream: true`: ein Mehrbyte-Zeichen kann zwischen zwei Netzpaketen
    // zerrissen sein. Ohne das entstuende an der Bruchstelle ein Ersatzzeichen
    // mitten in einem Umlaut.
    buffer += decoder.decode(part, { stream: true });

    const events = buffer.split(EVENT_SEPARATOR);
    // Das letzte Stueck ist moeglicherweise unvollstaendig und bleibt stehen,
    // bis der Rest kommt.
    buffer = events.pop() ?? '';

    for (const event of events) {
      const text = textFromEvent(event);
      if (text) yield text;
    }
  }

  // Der Strom ist zu Ende - was noch im Puffer steht, ist vollstaendig.
  buffer += decoder.decode();
  const text = textFromEvent(buffer);
  if (text) yield text;
}

/** Zieht den Antworttext aus einem einzelnen Ereignis. */
export function textFromEvent(event: string): string {
  const payload = event
    .split(LINE_SEPARATOR)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('');

  if (!payload || payload === '[DONE]') return '';

  try {
    const parsed = JSON.parse(payload) as {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    };
    const parts = parsed.candidates?.[0]?.content?.parts ?? [];
    return (
      parts
        // Denkschritte sind nicht die Antwort. Sie gehoeren nicht ins Fenster
        // des Nutzers und nicht in den gespeicherten Antworttext.
        .filter((part) => part.thought !== true)
        .map((part) => part.text ?? '')
        .join('')
    );
  } catch {
    // Ein unlesbares Ereignis beendet den Strom nicht - der Rest der Antwort
    // ist weiterhin brauchbar.
    logger.warn('Unlesbares Ereignis im Modell-Stream verworfen');
    return '';
  }
}
