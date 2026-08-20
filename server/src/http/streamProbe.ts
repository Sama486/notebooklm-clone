import { Router } from 'express';
import { setStreamingHeaders } from './streaming.js';

export const streamProbeRouter = Router();

/**
 * Messpunkt für das Streaming-Verhalten, absichtlich dauerhaft eingebaut.
 *
 * Der Endpunkt streamt zehn Woerter im Sekundentakt. Damit laesst sich gegen
 * die oeffentliche URL pruefen, ob ein Proxy die Antwort puffert:
 *
 *   curl -N -s https://<api>/api/stream-probe | ts '[%H:%M:%.S]'
 *
 * Kommen die Zeitstempel im Sekundenabstand, geht der Stream durch. Kommt alles
 * auf einmal, puffert etwas dazwischen - und dann waere auch die Chat-Antwort
 * kein Stream, sondern eine lange Pause mit einem Block am Ende. Das erst am
 * Ende des Projekts zu bemerken ist der teuerste Zeitpunkt dafuer.
 *
 * Es gibt keine Nutzerdaten und keine Parameter - ein Aufruf kostet nur die
 * zehn Sekunden offene Verbindung.
 */
streamProbeRouter.get('/stream-probe', (req, res) => {
  setStreamingHeaders(res);

  const words = ['eins', 'zwei', 'drei', 'vier', 'fuenf', 'sechs', 'sieben', 'acht', 'neun', 'zehn'];
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

  // Bricht der Client ab, laeuft der Timer sonst zehn Sekunden ins Leere weiter.
  req.on('close', () => clearInterval(timer));
});
