import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { limits } from '../config.js';
import { describeError, logger } from '../logger.js';
import { asyncHandler } from '../http/asyncHandler.js';
import { parseBody, parseParams, parseQuery, uuidParam } from '../http/validate.js';
import { chatLimiter } from '../http/rateLimit.js';
import { sendEvent, setStreamingHeaders } from '../http/streaming.js';
import { currentUserId } from '../auth/middleware.js';
import { requireNotebook } from '../data/notebookAccess.js';
import { getAiClient } from '../ai/index.js';
import { AiError, type ChatMessage } from '../ai/types.js';
import { rankBySimilarity } from './similarity.js';
import { buildSystemPrompt, buildUserMessage, numberPassages } from './prompt.js';
import { MarkerScrubber } from './markerScrubber.js';

export const chatRouter = Router();

const notebookParams = uuidParam('notebookId');

/** Ein Beleg, wie ihn das Frontend zum Springen ins Dokument braucht. */
export interface Citation {
  marker: number;
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  charStart: number;
  charEnd: number;
  page: number | null;
  snippet: string;
}

// ---------------------------------------------------------------------------
// Verlauf
// ---------------------------------------------------------------------------

chatRouter.get(
  '/:notebookId/messages',
  asyncHandler(async (req, res) => {
    const { notebookId } = parseParams(notebookParams, req);
    const notebook = await requireNotebook(notebookId, currentUserId(req));

    const { take } = parseQuery(
      z.object({
        take: z.coerce.number().int().min(1).max(limits.pagination.maxTake).default(50),
      }),
      req,
    );

    const messages = await prisma.message.findMany({
      where: { notebookId: notebook.id },
      orderBy: { createdAt: 'desc' },
      take,
    });

    // Absteigend geholt (die neuesten), aufsteigend ausgeliefert (Lesereihenfolge).
    res.json({ messages: messages.reverse() });
  }),
);

// ---------------------------------------------------------------------------
// Frage stellen
// ---------------------------------------------------------------------------

chatRouter.post(
  '/:notebookId/chat',
  chatLimiter,
  asyncHandler(async (req, res) => {
    const { notebookId } = parseParams(notebookParams, req);
    const notebook = await requireNotebook(notebookId, currentUserId(req));
    const { question } = parseBody(
      z.object({ question: z.string().trim().min(1).max(limits.chat.questionMax) }),
      req,
    );

    const ai = getAiClient();

    // 1. Frage einbetten und gegen die Abschnitte der AUSGEWAEHLTEN Quellen
    //    dieses Notebooks vergleichen.
    const queryEmbedding = await ai.embedQuery(question);

    const candidates = await prisma.chunk.findMany({
      // Der Filter geht ueber notebookId (am Chunk denormalisiert) UND ueber
      // den Status und die Auswahl der Quelle. Abschnitte einer abgewaehlten
      // oder noch nicht fertigen Quelle duerfen nicht in die Antwort.
      where: { notebookId: notebook.id, source: { selected: true, status: 'ready' } },
      select: {
        id: true,
        content: true,
        charStart: true,
        charEnd: true,
        page: true,
        embedding: true,
        sourceId: true,
        source: { select: { title: true } },
      },
      // Bewusst ohne `take`: die Aehnlichkeitssuche ist ein exakter Durchlauf
      // ueber alle Abschnitte des Notebooks. Das ist die einzige unbegrenzte
      // Abfrage im Projekt, und sie ist es mit Absicht - Messung, Rechnung und
      // benannter Kipppunkt stehen im README.
    });

    const ranked = rankBySimilarity(
      queryEmbedding,
      candidates,
      (chunk) => chunk.embedding,
      limits.chat.topK,
    );

    // 2. Treffer fortlaufend ab 1 nummerieren.
    const passages = numberPassages(
      ranked.map(({ chunk }) => ({
        chunkId: chunk.id,
        sourceTitle: chunk.source.title,
        content: chunk.content,
        page: chunk.page,
      })),
    );

    const citations: Citation[] = ranked.map(({ chunk }, index) => ({
      marker: index + 1,
      chunkId: chunk.id,
      sourceId: chunk.sourceId,
      sourceTitle: chunk.source.title,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      page: chunk.page,
      snippet: chunk.content.slice(0, limits.chat.snippetChars),
    }));

    // 3. Prompt bauen. Die Injection-Abgrenzung steckt in prompt.ts.
    const history = await recentHistory(notebook.id);
    const messages: ChatMessage[] = [
      ...history,
      { role: 'user', content: buildUserMessage(question, passages) },
    ];

    // Die Frage wird gespeichert, bevor gestreamt wird - bricht der Stream ab,
    // steht sie trotzdem im Verlauf.
    await prisma.message.create({
      data: { notebookId: notebook.id, role: 'user', content: question },
    });

    // 4. Streamen und die Marker aus dem Textstrom fischen.
    setStreamingHeaders(res);
    // Die Belege gehen zuerst raus: das Frontend kann die Chips schon
    // vorbereiten, waehrend die Antwort noch laeuft.
    sendEvent(res, 'citations', { citations });

    const controller = new AbortController();
    res.on('close', () => controller.abort());

    const scrubber = new MarkerScrubber();
    const used = new Set<number>();
    let answer = '';

    try {
      for await (const part of ai.streamChat({
        system: buildSystemPrompt(),
        messages,
        signal: controller.signal,
      })) {
        const { text, markers } = scrubber.push(part);
        for (const marker of markers) used.add(marker);
        if (text) {
          answer += text;
          sendEvent(res, 'token', { text, markers });
        } else if (markers.length > 0) {
          sendEvent(res, 'token', { text: '', markers });
        }
      }

      // Was zurueckgehalten wurde, war doch kein Marker.
      const rest = scrubber.flush();
      for (const marker of rest.markers) used.add(marker);
      if (rest.text || rest.markers.length > 0) {
        answer += rest.text;
        sendEvent(res, 'token', { text: rest.text, markers: rest.markers });
      }
    } catch (error) {
      logger.error('Modellaufruf fehlgeschlagen', {
        notebookId: notebook.id,
        ...describeError(error),
      });
      // Header sind laengst raus - ein HTTP-Status geht nicht mehr. Der Fehler
      // kommt deshalb als Ereignis, und das Frontend zeigt ihn im Chatfenster.
      //
      // Bei einem voruebergehenden Fehler (Kontingent, Ueberlastung) bekommt
      // der Nutzer einen Hinweis, der ihm sagt, was zu tun ist. Die Meldung des
      // Anbieters selbst wird nicht weitergereicht - sie kann Teile des Prompts
      // enthalten, und der Prompt enthaelt Nutzerdokumente.
      const temporary = error instanceof AiError && error.retryable;
      sendEvent(res, 'error', {
        message: temporary
          ? 'Der KI-Dienst ist gerade ausgelastet. Bitte in einer Minute erneut fragen.'
          : 'Die Antwort konnte nicht erzeugt werden. Bitte erneut versuchen.',
      });
      res.end();
      return;
    }

    // 5. Antwort samt der tatsaechlich verwendeten Belege speichern.
    //    Nur die verwendeten: haette das Modell [3] nie geschrieben, waere ein
    //    gespeicherter Beleg 3 eine Behauptung ohne Grundlage.
    const usedCitations = citations.filter((citation) => used.has(citation.marker));

    await prisma.message.create({
      data: {
        notebookId: notebook.id,
        role: 'assistant',
        content: answer,
        // Prisma verlangt fuer Json-Felder einen strukturellen JSON-Typ. Ein
        // benanntes Interface erfuellt dessen Index-Signatur nicht, obwohl der
        // Wert JSON-tauglich ist - deshalb hier die Umdeutung.
        citations: usedCitations as unknown as Prisma.InputJsonValue,
      },
    });

    sendEvent(res, 'done', { citations: usedCitations });
    res.end();
  }),
);

/**
 * Die letzten Nachrichten als Gespraechsverlauf.
 *
 * Begrenzt, weil sonst jede weitere Frage den Prompt waechst laesst - bei
 * einem langen Gespraech waere irgendwann mehr Verlauf als Textstelle im
 * Kontext, und die Kosten je Frage stiegen ohne Ende.
 */
async function recentHistory(notebookId: string): Promise<ChatMessage[]> {
  const rows = await prisma.message.findMany({
    where: { notebookId },
    orderBy: { createdAt: 'desc' },
    take: limits.chat.historyMessages,
    select: { role: true, content: true },
  });

  return rows
    .reverse()
    .map((row) => ({ role: row.role === 'assistant' ? 'assistant' : 'user', content: row.content }));
}
