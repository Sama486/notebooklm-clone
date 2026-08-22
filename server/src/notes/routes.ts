import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { limits } from '../config.js';
import { asyncHandler } from '../http/asyncHandler.js';
import { parseBody, parseParams, parseQuery, uuidParam } from '../http/validate.js';
import { conflict, notFound } from '../http/errors.js';
import { currentUserId } from '../auth/middleware.js';
import { requireNotebook } from '../data/notebookAccess.js';
import { splitMarkers } from '../chat/markerScrubber.js';

/**
 * Notizen: gespeicherte Antworten und eigene Aufzeichnungen zu einem Notebook.
 *
 * Fachlich das einfachste Modul im Projekt - und genau deshalb der beste Ort,
 * um zu zeigen, dass die Zugriffsregel nicht an einer Stelle festgeschraubt
 * ist, sondern das Muster trägt: eine Notiz trägt kein `userId`, sie erbt die
 * Trennung über ihr Notebook. Deshalb wird auch hier nie eine Notiz über ihre
 * eigene ID geladen, sondern immer erst das Notebook gegen `userId` aufgelöst
 * und dann über `notebookId` eingeschränkt.
 *
 * Es gibt hier keinen Modellaufruf und keine ausgehende Verbindung. Notizen
 * fügen der Anwendung keine neue Angriffsfläche hinzu.
 */
export const notesRouter = Router();

const notebookParams = uuidParam('notebookId');
const noteParams = z.object({
  notebookId: z.string().uuid(),
  noteId: z.string().uuid(),
});

const titleSchema = z.string().trim().min(1, 'darf nicht leer sein').max(limits.note.titleMax);
const contentSchema = z.string().trim().min(1, 'darf nicht leer sein').max(limits.note.contentMax);

/**
 * Die Belege, die eine gespeicherte Antwort mitbringt.
 *
 * Bewusst eng validiert, obwohl sie vom eigenen Frontend kommen: was in der
 * Datenbank landet, wird später wieder ausgeliefert und angezeigt. Ein
 * ungeprüftes Json-Feld ist die bequemste Stelle, an der sich unerwartete
 * Formen einschleichen - und der Client bestimmt den Inhalt, nicht der Server.
 */
const citationSchema = z.object({
  marker: z.number().int().min(1).max(999),
  chunkId: z.string().uuid(),
  sourceId: z.string().uuid(),
  sourceTitle: z.string().max(limits.source.titleMax),
  charStart: z.number().int().min(0),
  charEnd: z.number().int().min(0),
  page: z.number().int().min(1).nullable(),
  snippet: z.string().max(limits.chat.snippetChars),
});

const citationsSchema = z.array(citationSchema).max(limits.chat.topK).optional();

/**
 * Zerlegt den Notiztext an seinen Markern.
 *
 * Eine als Notiz gesicherte Antwort bringt ihre Marker mit. Sie hier zu
 * zerlegen, statt den Text roh auszuliefern, hält die Belege an der Stelle, an
 * der sie standen - dieselbe Behandlung wie beim Chatverlauf und dieselbe
 * Funktion, damit es genau eine Stelle gibt, die Marker versteht.
 */
function mitSegmenten<T extends { content: string }>(note: T) {
  const segments = splitMarkers(note.content);
  return {
    ...note,
    content: segments.map((segment) => segment.text).join(''),
    segments,
  };
}

/** Nur diese Felder verlassen die Datenbank - `notebookId` bleibt drin. */
const noteSelect = {
  id: true,
  title: true,
  content: true,
  citations: true,
  createdAt: true,
  updatedAt: true,
} as const;

notesRouter.get(
  '/:notebookId/notes',
  asyncHandler(async (req, res) => {
    const { notebookId } = parseParams(notebookParams, req);
    const notebook = await requireNotebook(notebookId, currentUserId(req));

    const { take } = parseQuery(
      z.object({
        take: z.coerce
          .number()
          .int()
          .min(1)
          .max(limits.note.maxPerNotebook)
          .default(limits.note.maxPerNotebook),
      }),
      req,
    );

    const rows = await prisma.note.findMany({
      where: { notebookId: notebook.id },
      orderBy: { createdAt: 'desc' },
      take,
      select: noteSelect,
    });

    res.json({ notes: rows.map(mitSegmenten) });
  }),
);

notesRouter.post(
  '/:notebookId/notes',
  asyncHandler(async (req, res) => {
    const { notebookId } = parseParams(notebookParams, req);
    const notebook = await requireNotebook(notebookId, currentUserId(req));

    const { title, content, citations } = parseBody(
      z.object({ title: titleSchema, content: contentSchema, citations: citationsSchema }),
      req,
    );

    // Obergrenze je Notebook. Ohne sie kann ein einzelnes Konto die Tabelle
    // unbegrenzt wachsen lassen - dieselbe Überlegung wie bei den Quellen.
    const vorhanden = await prisma.note.count({ where: { notebookId: notebook.id } });
    if (vorhanden >= limits.note.maxPerNotebook) {
      throw conflict(
        `Ein Notebook kann höchstens ${limits.note.maxPerNotebook} Notizen enthalten.`,
        'too_many_notes',
      );
    }

    const note = await prisma.note.create({
      data: {
        notebookId: notebook.id,
        title,
        content,
        citations: (citations ?? []) as unknown as Prisma.InputJsonValue,
      },
      select: noteSelect,
    });

    res.status(201).json({ note: mitSegmenten(note) });
  }),
);

notesRouter.patch(
  '/:notebookId/notes/:noteId',
  asyncHandler(async (req, res) => {
    const { notebookId, noteId } = parseParams(noteParams, req);
    await requireNotebook(notebookId, currentUserId(req));

    const änderung = parseBody(
      z
        .object({ title: titleSchema.optional(), content: contentSchema.optional() })
        .refine((value) => value.title !== undefined || value.content !== undefined, {
          message: 'mindestens eines von title oder content angeben',
        }),
      req,
    );

    // `updateMany` mit notebookId im where: der Schreibzugriff geht über das
    // Notebook, nicht über die Notiz-ID allein. Betrifft er null Zeilen, gehört
    // die Notiz zu einem anderen Notebook - und die Antwort ist 404.
    const { count } = await prisma.note.updateMany({
      where: { id: noteId, notebookId },
      data: änderung,
    });
    if (count === 0) throw notFound('Notiz nicht gefunden.');

    const note = await prisma.note.findFirstOrThrow({
      where: { id: noteId, notebookId },
      select: noteSelect,
    });
    res.json({ note: mitSegmenten(note) });
  }),
);

notesRouter.delete(
  '/:notebookId/notes/:noteId',
  asyncHandler(async (req, res) => {
    const { notebookId, noteId } = parseParams(noteParams, req);
    await requireNotebook(notebookId, currentUserId(req));

    const { count } = await prisma.note.deleteMany({ where: { id: noteId, notebookId } });
    if (count === 0) throw notFound('Notiz nicht gefunden.');

    res.status(204).end();
  }),
);
