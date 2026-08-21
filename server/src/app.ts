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

export function createApp() {
  const app = express();

  // Render terminiert TLS in einem vorgelagerten Proxy. Ohne diese Zeile sieht
  // die Anwendung als Absender-IP den Proxy - und das Rate-Limit wuerde alle
  // Nutzer in einen Topf werfen. Genau 1, nicht `true`: `true` liesse einen
  // Client seine eigene IP ueber X-Forwarded-For faelschen und damit das
  // Rate-Limit umgehen.
  app.set('trust proxy', isProduction ? 1 : false);
  app.disable('x-powered-by');

  // Die API liefert ausschliesslich JSON und Streams aus, kein HTML. CSP und
  // die uebrigen Header sind trotzdem gesetzt - falls doch einmal etwas
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

  // Global klein gehalten. Der PDF-Upload bringt seine eigene, groessere Grenze
  // mit (sources/routes.ts) - eine grosszuegige globale Grenze wuerde jeden
  // JSON-Endpunkt zum Speicher-Ventil machen.
  app.use(express.json({ limit: limits.body.json }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  app.use('/api', globalLimiter);
  app.use('/api', streamProbeRouter);
  app.use('/api/auth', authRouter);

  // `requireAuth` liegt auf dem Router, nicht auf einzelnen Routen: eine
  // spaeter hinzugefuegte Route in diesen Dateien ist damit von sich aus
  // geschuetzt, ohne dass jemand daran denken muss.
  app.use('/api/notebooks', requireAuth, notebooksRouter);
  app.use('/api/notebooks', requireAuth, sourcesRouter);
  app.use('/api/notebooks', requireAuth, chatRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
