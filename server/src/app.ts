import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { corsOrigins, isProduction, limits } from './config.js';
import { errorHandler, notFoundHandler } from './http/errorHandler.js';
import { globalLimiter } from './http/rateLimit.js';
import { streamProbeRouter } from './http/streamProbe.js';
import { authRouter } from './auth/routes.js';
import { requireAuth } from './auth/middleware.js';
import { notebooksRouter } from './notebooks/routes.js';
import { sourcesRouter } from './sources/routes.js';
import { chatRouter } from './chat/routes.js';
import { notesRouter } from './notes/routes.js';

export function createApp() {
  const app = express();

  // Render terminiert TLS in einem vorgelagerten Proxy. Ohne diese Zeile sieht
  // die Anwendung als Absender-IP den Proxy - und das Rate-Limit würde alle
  // Nutzer in einen Topf werfen. Genau 1, nicht `true`: `true` ließe einen
  // Client seine eigene IP über X-Forwarded-For fälschen und damit das
  // Rate-Limit umgehen.
  app.set('trust proxy', isProduction ? 1 : false);
  app.disable('x-powered-by');

  // Die API liefert ausschließlich JSON und Streams aus, kein HTML. CSP und
  // die übrigen Header sind trotzdem gesetzt - falls doch einmal etwas
  // gerendert wird, ist die restriktive Variante die voreingestellte.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // Enge Herkunftsliste statt `origin: true`. Eine Herkunft, die nicht in der
  // Liste steht, bekommt keinen CORS-Header - der Browser blockt die Antwort.
  app.use(
    cors({
      origin(origin, callback) {
        // Kein Origin-Header: Aufrufe ohne Browser (curl, Health-Check).
        if (!origin) return callback(null, true);
        callback(null, corsOrigins.includes(origin));
      },
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 86_400,
    }),
  );

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  app.use('/api', globalLimiter);
  app.use('/api', streamProbeRouter);

  /**
   * Der Quellen-Router steht VOR dem allgemeinen JSON-Parser, und das ist kein
   * Schönheitsfehler, sondern die Bedingung dafür, dass seine eigenen Grenzen
   * überhaupt wirken.
   *
   * `express.json` merkt sich am Request, dass der Rumpf gelesen wurde, und
   * jeder weitere Body-Parser steigt danach wortlos aus. Stand die kleine
   * Grenze also zuerst in der Kette, hatte sie den Rumpf längst mit 413
   * abgewiesen, bevor die größere Grenze der Text-Route zum Zug kam - die war
   * damit toter Code, und "Text einfügen" brach bei 128 kb ab statt bei
   * 400.000 Zeichen. Der Router bringt seine Parser deshalb je Route selbst
   * mit (sources/routes.ts); alles, was er nicht beantwortet, fällt nach unten
   * durch.
   *
   * `requireAuth` liegt auf dem Router, nicht auf einzelnen Routen: eine
   * später hinzugefügte Route in diesen Dateien ist damit von sich aus
   * geschützt, ohne dass jemand daran denken muss.
   */
  app.use('/api/notebooks', requireAuth, sourcesRouter);

  // Für alles Übrige: klein gehalten, damit kein JSON-Endpunkt zum
  // Speicher-Ventil wird.
  app.use(express.json({ limit: limits.body.json }));

  app.use('/api/auth', authRouter);
  app.use('/api/notebooks', requireAuth, notebooksRouter);
  app.use('/api/notebooks', requireAuth, chatRouter);
  app.use('/api/notebooks', requireAuth, notesRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
