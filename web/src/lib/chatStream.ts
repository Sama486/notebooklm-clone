import { rawRequest } from './api.js';
import type { Citation } from './types.js';

/**
 * Liest die gestreamte Chat-Antwort.
 *
 * `fetch` statt `EventSource`, weil EventSource nur GET kann und keine eigenen
 * Kopfzeilen zulaesst - der Token muesste dann in die URL, und URLs landen in
 * Server-Logs und im Verlauf des Browsers.
 */

export interface ChatHandlers {
  onCitations: (citations: Citation[]) => void;
  onToken: (text: string, markers: number[]) => void;
  onError: (message: string) => void;
  onDone: (citations: Citation[]) => void;
}

export async function streamChat(
  notebookId: string,
  question: string,
  handlers: ChatHandlers,
  signal: AbortSignal,
): Promise<void> {
  const response = await rawRequest(`/api/notebooks/${notebookId}/chat`, {
    method: 'POST',
    body: { question },
    signal,
  });

  if (!response.body) {
    handlers.onError('Der Server hat keine Antwort geliefert.');
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // `stream: true`, weil ein Mehrbyte-Zeichen zwischen zwei Netzpaketen
    // zerrissen sein kann. Ohne das entstuende an der Bruchstelle ein
    // Ersatzzeichen mitten in einem Umlaut.
    buffer += decoder.decode(value, { stream: true });

    // Ereignisse sind durch eine Leerzeile getrennt. Ein unvollstaendiges
    // Ereignis am Pufferende bleibt stehen, bis der Rest ankommt - dieselbe
    // Ueberlegung wie beim Rueckhaltefenster fuer Marker auf der Serverseite.
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const event of events) dispatch(event, handlers);
  }

  if (buffer.trim()) dispatch(buffer, handlers);
}

function dispatch(rawEvent: string, handlers: ChatHandlers): void {
  let name = 'message';
  const dataLines: string[] = [];

  for (const line of rawEvent.split('\n')) {
    if (line.startsWith('event:')) name = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (dataLines.length === 0) return;

  let payload: unknown;
  try {
    payload = JSON.parse(dataLines.join(''));
  } catch {
    // Ein unlesbares Ereignis beendet den Stream nicht - der Rest der Antwort
    // ist weiterhin brauchbar.
    return;
  }

  switch (name) {
    case 'citations':
      handlers.onCitations((payload as { citations: Citation[] }).citations);
      break;
    case 'token': {
      const { text, markers } = payload as { text: string; markers: number[] };
      handlers.onToken(text, markers ?? []);
      break;
    }
    case 'error':
      handlers.onError((payload as { message: string }).message);
      break;
    case 'done':
      handlers.onDone((payload as { citations: Citation[] }).citations);
      break;
    default:
      break;
  }
}
