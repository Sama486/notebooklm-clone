import type { Response } from 'express';

/**
 * Header, ohne die eine Antwort nicht wortweise beim Browser ankommt.
 *
 * - `text/event-stream` schaltet Zwischenschichten (und den Browser) in den
 *   Stream-Modus statt auf "Antwort sammeln, dann ausliefern".
 * - `no-transform` und `Content-Encoding: identity` verhindern, dass ein Proxy
 *   die Antwort komprimiert - ein Kompressor puffert naturgemaess, weil er
 *   Bloecke braucht.
 * - `X-Accel-Buffering: no` schaltet die Pufferung in nginx ab. Render setzt
 *   nginx davor; ohne diesen Header kommt die Antwort am Stueck.
 * - `flushHeaders()` schickt die Kopfzeilen sofort raus, statt auf das erste
 *   Datenpaket zu warten.
 */
export function setStreamingHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Content-Encoding', 'identity');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

/** Ein Ereignis im Server-Sent-Events-Format. */
export function sendEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
