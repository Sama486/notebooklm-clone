import { Router, type Request } from 'express';
import express from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { limits } from '../config.js';
import { asyncHandler } from '../http/asyncHandler.js';
import { parseBody, parseParams, parseQuery, uuidParam } from '../http/validate.js';
import { ingestLimiter } from '../http/rateLimit.js';
import { badRequest, conflict, notFound, unprocessable } from '../http/errors.js';
import { currentUserId } from '../auth/middleware.js';
import { requireNotebook, requireSource } from '../data/notebookAccess.js';
import { getAiClient } from '../ai/index.js';
import { startIngestInBackground } from '../ingest/ingestSource.js';
import { extractPdf } from './extractPdf.js';
import { extractHtml, titleFromUrl } from './extractHtml.js';
import { fetchExternalUrl } from '../net/safeFetch.js';

export const sourcesRouter = Router();

const notebookParams = uuidParam('notebookId');
const sourceParams = z.object({
  notebookId: z.string().uuid(),
  sourceId: z.string().uuid(),
});

const titleSchema = z.string().trim().min(1).max(limits.source.titleMax);

/**
 * Legt eine Quelle an und startet die Verarbeitung.
 *
 * Gemeinsamer Abschluss aller drei Quellenarten: die Quelle wird mit dem
 * bereits extrahierten Volltext gespeichert, und das Zerlegen und Einbetten
 * laeuft danach im Hintergrund weiter. Die Antwort geht sofort raus.
 */
async function createSourceAndStart(input: {
  notebookId: string;
  title: string;
  type: 'pdf' | 'text' | 'url';
  content: string;
  sizeBytes: number;
  originalUrl?: string;
  fileData?: Buffer;
  pageBreaks?: number[];
}) {
  // Obergrenze je Notebook. Ohne sie kann ein einzelnes Konto die Datenbank
  // und das Embedding-Kontingent alleine auslasten.
  const existing = await prisma.source.count({ where: { notebookId: input.notebookId } });
  if (existing >= limits.source.maxPerNotebook) {
    throw conflict(
      `Ein Notebook kann hoechstens ${limits.source.maxPerNotebook} Quellen enthalten.`,
      'too_many_sources',
    );
  }

  const source = await prisma.source.create({
    data: {
      notebookId: input.notebookId,
      title: input.title,
      type: input.type,
      content: input.content,
      sizeBytes: input.sizeBytes,
      originalUrl: input.originalUrl ?? null,
      fileData: input.fileData ?? null,
      pageBreaks: input.pageBreaks ?? [],
      status: 'pending',
    },
    select: { id: true, title: true, type: true, status: true, createdAt: true },
  });

  startIngestInBackground(source.id, getAiClient());
  return source;
}

// ---------------------------------------------------------------------------
// PDF hochladen
// ---------------------------------------------------------------------------

/**
 * Der Upload kommt als Roh-Body, nicht als Multipart-Formular.
 *
 * Damit entfaellt ein Multipart-Parser als Angriffsflaeche - die verbreitete
 * Bibliothek dafuer hatte in ihrer 1.x-Reihe mehrere Schwachstellen. Der Titel
 * kommt als Zod-geprueffter Query-Parameter, und der Dateiname aus dem Upload
 * ist damit von vornherein nur Anzeigetext: er beruehrt nie einen Pfad, weil
 * es keinen Pfad gibt. Es wird nichts ins Dateisystem geschrieben.
 *
 * `express.raw` mit eigener, groesserer Grenze - die globale JSON-Grenze von
 * 128 kb gilt hier nicht, alle anderen Endpunkte behalten sie.
 */
sourcesRouter.post(
  '/:notebookId/sources/pdf',
  ingestLimiter,
  express.raw({ type: 'application/pdf', limit: limits.body.pdfUpload }),
  asyncHandler(async (req, res) => {
    const { notebookId } = parseParams(notebookParams, req);
    await requireNotebook(notebookId, currentUserId(req));

    const { title } = parseQuery(z.object({ title: titleSchema }), req);
    const data = pdfBody(req);

    // Extraktion vor dem Anlegen: ist die Datei kein PDF oder unlesbar, gibt es
    // gar keine Quelle statt einer sofort fehlgeschlagenen.
    const extracted = await extractPdf(data);

    const source = await createSourceAndStart({
      notebookId,
      title,
      type: 'pdf',
      content: extracted.text,
      pageBreaks: extracted.pageBreaks,
      sizeBytes: data.length,
      // Das Original bleibt in der Datenbank, damit die Dokumentansicht es
      // spaeter anzeigen kann. Begruendung im README: das Dateisystem der
      // Instanz ist fluechtig, und ein Objektspeicher waere ein weiterer
      // Dienst samt Zugangsdaten fuer wenige Megabyte.
      fileData: data,
    });

    res.status(201).json({ source });
  }),
);

function pdfBody(req: Request): Buffer {
  // Kein Buffer: der Content-Type passte nicht zum `type`-Filter oben, der
  // Body war leer, oder jemand hat JSON geschickt.
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    throw badRequest(
      'Es wurde keine PDF-Datei uebertragen. Content-Type muss application/pdf sein.',
      'no_file',
    );
  }
  return req.body;
}

// ---------------------------------------------------------------------------
// Text einfuegen
// ---------------------------------------------------------------------------

sourcesRouter.post(
  '/:notebookId/sources/text',
  ingestLimiter,
  // Eigene Grenze: mehr als JSON sonst darf, weniger als ein PDF.
  express.json({ limit: limits.body.pastedText * 2 }),
  asyncHandler(async (req, res) => {
    const { notebookId } = parseParams(notebookParams, req);
    await requireNotebook(notebookId, currentUserId(req));

    const { title, content } = parseBody(
      z.object({
        title: titleSchema,
        content: z.string().trim().min(1, 'darf nicht leer sein').max(limits.body.pastedText),
      }),
      req,
    );

    const source = await createSourceAndStart({
      notebookId,
      title,
      type: 'text',
      content,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
    });

    res.status(201).json({ source });
  }),
);

// ---------------------------------------------------------------------------
// Website-URL
// ---------------------------------------------------------------------------

sourcesRouter.post(
  '/:notebookId/sources/url',
  ingestLimiter,
  asyncHandler(async (req, res) => {
    const { notebookId } = parseParams(notebookParams, req);
    await requireNotebook(notebookId, currentUserId(req));

    const { url } = parseBody(z.object({ url: z.string().trim().min(1).max(2000) }), req);

    // Der gesamte SSRF-Schutz steckt in fetchExternalUrl: Schema-Pruefung,
    // Adresspruefung aller aufgeloesten IPs, IP-Bindung an die Verbindung,
    // erneute Pruefung bei jeder Weiterleitung, Zeit- und Groessengrenze.
    const fetched = await fetchExternalUrl(url);

    if (!/text\/html|application\/xhtml|text\/plain/i.test(fetched.contentType)) {
      throw unprocessable(
        'Unter dieser Adresse liegt keine Textseite.',
        'unsupported_content_type',
      );
    }

    const html = fetched.body.toString('utf8');
    const extracted = extractHtml(html, titleFromUrl(fetched.finalUrl));

    const source = await createSourceAndStart({
      notebookId,
      title: extracted.title,
      type: 'url',
      content: extracted.text,
      sizeBytes: fetched.body.length,
      originalUrl: fetched.finalUrl,
    });

    res.status(201).json({ source });
  }),
);

// ---------------------------------------------------------------------------
// Lesen, aendern, loeschen
// ---------------------------------------------------------------------------

/**
 * Volltext einer Quelle - die Grundlage der Dokumentansicht.
 *
 * Die Oberflaeche springt darin zu `charStart` und hebt bis `charEnd` hervor.
 * Deshalb wird der Text UNVERAENDERT ausgeliefert: jede nachtraegliche
 * Bereinigung wuerde die Positionen verschieben, und die Hervorhebung stuende
 * an der falschen Stelle.
 */
sourcesRouter.get(
  '/:notebookId/sources/:sourceId',
  asyncHandler(async (req, res) => {
    const { notebookId, sourceId } = parseParams(sourceParams, req);
    // Erst Notebook gegen userId, dann Quelle ueber notebookId. Nie die Quelle
    // direkt ueber ihre eigene ID.
    const source = await requireSource(sourceId, notebookId, currentUserId(req));

    res.json({
      source: {
        id: source.id,
        title: source.title,
        type: source.type,
        originalUrl: source.originalUrl,
        status: source.status,
        error: source.error,
        chunkCount: source.chunkCount,
        selected: source.selected,
        sizeBytes: source.sizeBytes,
        createdAt: source.createdAt,
        content: source.content,
      },
    });
  }),
);

/** Nur der Status - fuer die Abfrage waehrend der Verarbeitung. */
sourcesRouter.get(
  '/:notebookId/sources',
  asyncHandler(async (req, res) => {
    const { notebookId } = parseParams(notebookParams, req);
    const notebook = await requireNotebook(notebookId, currentUserId(req));

    const sources = await prisma.source.findMany({
      where: { notebookId: notebook.id },
      orderBy: { createdAt: 'asc' },
      take: limits.source.maxPerNotebook,
      // Ohne `content` und `fileData`: die Abfrage laeuft im Sekundentakt,
      // solange etwas verarbeitet wird.
      select: {
        id: true,
        title: true,
        type: true,
        originalUrl: true,
        status: true,
        error: true,
        chunkCount: true,
        selected: true,
        sizeBytes: true,
        createdAt: true,
      },
    });

    res.json({ sources });
  }),
);

sourcesRouter.patch(
  '/:notebookId/sources/:sourceId',
  asyncHandler(async (req, res) => {
    const { notebookId, sourceId } = parseParams(sourceParams, req);
    await requireSource(sourceId, notebookId, currentUserId(req));

    const { selected } = parseBody(z.object({ selected: z.boolean() }), req);

    // `updateMany` mit notebookId im where: auch der schreibende Zugriff geht
    // ueber das Notebook, nicht ueber die Quellen-ID allein.
    await prisma.source.updateMany({ where: { id: sourceId, notebookId }, data: { selected } });

    res.json({ source: { id: sourceId, selected } });
  }),
);

/** Erneut einlesen, etwa nach einem Fehler. */
sourcesRouter.post(
  '/:notebookId/sources/:sourceId/reingest',
  ingestLimiter,
  asyncHandler(async (req, res) => {
    const { notebookId, sourceId } = parseParams(sourceParams, req);
    const source = await requireSource(sourceId, notebookId, currentUserId(req));

    if (source.status === 'processing') {
      throw conflict('Diese Quelle wird gerade verarbeitet.', 'already_processing');
    }

    // Wiederholbar: ingestSource loescht die alten Abschnitte, bevor es neue
    // schreibt. Zweimal ausgefuehrt entstehen keine Dubletten.
    await prisma.source.update({
      where: { id: source.id },
      data: { status: 'pending', error: null },
    });
    startIngestInBackground(source.id, getAiClient());

    res.status(202).json({ source: { id: source.id, status: 'pending' } });
  }),
);

sourcesRouter.delete(
  '/:notebookId/sources/:sourceId',
  asyncHandler(async (req, res) => {
    const { notebookId, sourceId } = parseParams(sourceParams, req);
    await requireSource(sourceId, notebookId, currentUserId(req));

    const deleted = await prisma.source.deleteMany({ where: { id: sourceId, notebookId } });
    if (deleted.count === 0) throw notFound('Quelle nicht gefunden.');

    res.status(204).end();
  }),
);
