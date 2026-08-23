import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { limits } from '../config.js';
import { asyncHandler } from '../http/asyncHandler.js';
import { parseBody, parseParams, parseQuery, uuidParam } from '../http/validate.js';
import { currentUserId } from '../auth/middleware.js';
import { requireNotebook } from '../data/notebookAccess.js';
import { notFound } from '../http/errors.js';

export const notebooksRouter = Router();

const titleSchema = z.string().trim().min(1, 'darf nicht leer sein').max(120);

const listQuerySchema = z.object({
  take: z.coerce.number().int().min(1).max(limits.pagination.maxTake).default(limits.pagination.defaultTake),
  cursor: z.string().uuid().optional(),
});

const idParams = uuidParam('notebookId');

/**
 * Liste der eigenen Notebooks, cursor-paginiert.
 *
 * Kein `findMany` ohne `take`: eine unbegrenzte Liste wird genau an dem Tag zum
 * Problem, an dem ein Nutzer viele Notebooks hat - und bis dahin fällt sie
 * niemandem auf. Cursor statt Offset, weil `OFFSET n` die Datenbank zwingt, n
 * Zeilen zu lesen und wegzuwerfen.
 *
 * `_count` statt einer zweiten Abfrage je Notebook - sonst wäre die Liste eine
 * N+1-Abfrage.
 */
notebooksRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req);
    const { take, cursor } = parseQuery(listQuerySchema, req);

    const rows = await prisma.notebook.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1, // eine Zeile mehr, um "gibt es noch mehr?" zu beantworten
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { sources: true } },
      },
    });

    const hasMore = rows.length > take;
    const notebooks = (hasMore ? rows.slice(0, take) : rows).map((n) => ({
      id: n.id,
      title: n.title,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      sourceCount: n._count.sources,
    }));

    res.json({
      notebooks,
      nextCursor: hasMore ? (notebooks.at(-1)?.id ?? null) : null,
    });
  }),
);

notebooksRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req);
    const { title } = parseBody(z.object({ title: titleSchema }), req);
    // `userId` kommt aus dem Token, nie aus dem Body.
    const notebook = await prisma.notebook.create({
      data: { userId, title },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
    res.status(201).json({ notebook });
  }),
);

notebooksRouter.get(
  '/:notebookId',
  asyncHandler(async (req, res) => {
    const { notebookId } = parseParams(idParams, req);
    const notebook = await requireNotebook(notebookId, currentUserId(req));

    // Quellen über `notebookId` - nicht über eigene IDs. Siehe notebookAccess.ts.
    const sources = await prisma.source.findMany({
      where: { notebookId: notebook.id },
      orderBy: { createdAt: 'asc' },
      take: limits.source.maxPerNotebook,
      // `content` und `fileData` bleiben draussen: die Liste würde sonst
      // mehrere Megabyte groß, obwohl die Oberfläche nur Titel und Status zeigt.
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

    res.json({
      notebook: {
        id: notebook.id,
        title: notebook.title,
        createdAt: notebook.createdAt,
        updatedAt: notebook.updatedAt,
      },
      sources,
    });
  }),
);

notebooksRouter.patch(
  '/:notebookId',
  asyncHandler(async (req, res) => {
    const { notebookId } = parseParams(idParams, req);
    const userId = currentUserId(req);
    const { title } = parseBody(z.object({ title: titleSchema }), req);

    await requireNotebook(notebookId, userId);

    // `updateMany` mit `userId` im where - dasselbe Muster wie bei Quellen und
    // Notizen: auch der schreibende Zugriff trägt seine Bedingung selbst und
    // verlässt sich nicht darauf, dass die Prüfung oben stehen bleibt. Die
    // Zeile, die es anders macht, ist die, die beim nächsten Umbau vergessen
    // wird.
    const { count } = await prisma.notebook.updateMany({
      where: { id: notebookId, userId },
      data: { title },
    });
    if (count === 0) throw notFound('Notebook nicht gefunden.');

    const notebook = await prisma.notebook.findFirstOrThrow({
      where: { id: notebookId, userId },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
    res.json({ notebook });
  }),
);

notebooksRouter.delete(
  '/:notebookId',
  asyncHandler(async (req, res) => {
    const { notebookId } = parseParams(idParams, req);
    const userId = currentUserId(req);
    await requireNotebook(notebookId, userId);

    // Wie beim Umbenennen trägt auch das Löschen seine Bedingung selbst.
    // Quellen, Abschnitte, Nachrichten und Notizen hängen per onDelete: Cascade
    // dran - die Datenbank räumt auf, nicht der Anwendungscode.
    const { count } = await prisma.notebook.deleteMany({ where: { id: notebookId, userId } });
    if (count === 0) throw notFound('Notebook nicht gefunden.');

    res.status(204).end();
  }),
);
