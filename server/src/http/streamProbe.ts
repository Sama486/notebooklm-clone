import { Router } from 'express';
import { setStreamingHeaders } from './streaming.js';

export const streamProbeRouter = Router();

/**
 * Messpunkt für das Streaming-Verhalten, absichtlich dauerhaft eingebaut.
 *
 * Der Endpunkt streamt zehn Wörter im Sekundentakt. Damit lässt sich gegen
 * die öffentliche URL prüfen, ob ein Proxy die Antwort puffert:
 *
 *   curl -N -s https://<api>/api/stream-probe | ts '[%H:%M:%.S]'
 *
 * Kommen die Zeitstempel im Sekundenabstand, geht der Stream durch. Kommt alles
 * auf einmal, puffert etwas dazwischen - und dann wäre auch die Chat-Antwort
 * kein Stream, sondern eine lange Pause mit einem Block am Ende. Das erst am
 * Ende des Projekts zu bemerken ist der teürste Zeitpunkt dafür.
 *
 * Es gibt keine Nutzerdaten und keine Parameter - ein Aufruf kostet nur die
 * zehn Sekunden offene Verbindung.
 */
streamProbeRouter.get('/stream-probe', (req, res) => {
  setStreamingHeaders(res);

  const words = ['eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn'];
  let index = 0;

  const timer = setInterval(() => {
    const word = words[index];
    if (word === undefined) {
      clearInterval(timer);
      res.write('event: done\ndata: {}\n\n');
      res.end();
      return;
    }
    index += 1;
    res.write(`data: ${JSON.stringify({ word, at: new Date().toISOString() })}\n\n`);
  }, 1000);

  // Bricht der Client ab, läuft der Timer sonst zehn Sekunden ins Leere weiter.
  req.on('close', () => clearInterval(timer));
});
