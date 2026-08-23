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
import { MarkerScrubber, splitMarkers, type Segment } from './markerScrubber.js';

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

    const rows = await prisma.message.findMany({
      where: { notebookId: notebook.id },
      orderBy: { createdAt: 'desc' },
      take,
    });

    /**
     * Die Marker stecken im gespeicherten Text und werden hier wieder
     * herausgelöst.
     *
     * Anfangs wurde die Antwort ohne Marker gespeichert und die Belege
     * daneben. Damit war nach einem Neuladen nicht mehr bekannt, hinter
     * welcher Aussage ein Beleg stand - alle Chips rutschten ans Ende. Die
     * Position gehört zur Aussage, also gehört sie in den gespeicherten Text.
     *
     * Zerlegt wird auf dem Server, mit derselben Funktion wie beim Streamen:
     * es soll genau eine Stelle geben, die versteht, was ein Marker ist.
     */
    const messages = rows.reverse().map((message) => {
      const segments = splitMarkers(message.content);
      return {
        ...message,
        // Der Text ohne Marker - für Kopieren, Notizen und alles, was den
        // reinen Wortlaut braucht.
        content: segments.map((segment) => segment.text).join(''),
        segments,
      };
    });

    res.json({ messages });
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
      // Der Filter geht über notebookId (am Chunk denormalisiert) UND über
      // den Status und die Auswahl der Quelle. Abschnitte einer abgewählten
      // oder noch nicht fertigen Quelle dürfen nicht in die Antwort.
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
      // Bewusst ohne `take`: die Ähnlichkeitssuche ist ein exakter Durchlauf
      // über alle Abschnitte des Notebooks. Das ist die einzige unbegrenzte
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
    // vorbereiten, während die Antwort noch läuft.
    sendEvent(res, 'citations', { citations });

    const controller = new AbortController();
    res.on('close', () => controller.abort());

    const scrubber = new MarkerScrubber();
    const used = new Set<number>();
    let gespeicherterText = '';

    try {
      const emit = (segments: Segment[]) => {
        if (segments.length === 0) return;
        for (const segment of segments) {
          // Die Marker wandern normalisiert in den gespeicherten Text: "[2][3]"
          // statt "[2, 3]". Beim Laden entsteht daraus wieder dieselbe
          // Segmentfolge - und die Chips stehen wieder an ihrer Stelle.
          gespeicherterText += segment.text + segment.markers.map((m) => `[${m}]`).join('');
          for (const marker of segment.markers) used.add(marker);
        }
        // Segmente statt Text plus Nummernliste: nur so weiß die Oberfläche,
        // hinter welcher Aussage ein Chip steht.
        sendEvent(res, 'token', { segments });
      };

      for await (const part of ai.streamChat({
        system: buildSystemPrompt(),
        messages,
        signal: controller.signal,
      })) {
        emit(scrubber.push(part).segments);
      }

      // Was zurückgehalten wurde, war doch kein Marker.
      emit(scrubber.flush().segments);
    } catch (error) {
      logger.error('Modellaufruf fehlgeschlagen', {
        notebookId: notebook.id,
        ...describeError(error),
      });
      // Header sind längst raus - ein HTTP-Status geht nicht mehr. Der Fehler
      // kommt deshalb als Ereignis, und das Frontend zeigt ihn im Chatfenster.
      //
      // Bei einem vorübergehenden Fehler (Kontingent, Überlastung) bekommt
      // der Nutzer einen Hinweis, der ihm sagt, was zu tun ist. Die Meldung des
      // Anbieters selbst wird nicht weitergereicht - sie kann Teile des Prompts
      // enthalten, und der Prompt enthält Nutzerdokumente.
      const temporary = error instanceof AiError && error.retryable;
      sendEvent(res, 'error', {
        message: temporary
          ? 'Der KI-Dienst ist gerade ausgelastet. Bitte in einer Minute erneut fragen.'
          : 'Die Antwort konnte nicht erzeugt werden. Bitte erneut versuchen.',
      });
      res.end();
      return;
    }

    // 5. Antwort samt der tatsächlich verwendeten Belege speichern.
    //    Nur die verwendeten: hätte das Modell [3] nie geschrieben, wäre ein
    //    gespeicherter Beleg 3 eine Behauptung ohne Grundlage.
    const usedCitations = citations.filter((citation) => used.has(citation.marker));

    await prisma.message.create({
      data: {
        notebookId: notebook.id,
        role: 'assistant',
        content: gespeicherterText,
        // Prisma verlangt für Json-Felder einen strukturellen JSON-Typ. Ein
        // benanntes Interface erfüllt dessen Index-Signatur nicht, obwohl der
        // Wert JSON-tauglich ist - deshalb hier die Umdeutung.
        citations: usedCitations as unknown as Prisma.InputJsonValue,
      },
    });

    sendEvent(res, 'done', { citations: usedCitations });
    res.end();
  }),
);

/**
 * Die letzten Nachrichten als Gesprächsverlauf.
 *
 * Begrenzt, weil sonst jede weitere Frage den Prompt wächst lässt - bei
 * einem langen Gespräch wäre irgendwann mehr Verlauf als Textstelle im
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
