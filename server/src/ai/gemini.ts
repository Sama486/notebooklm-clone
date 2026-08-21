import { limits } from '../config.js';
import { logger } from '../logger.js';
import { sseTextChunks } from './sse.js';
import { AiError, type AiClient, type ChatRequest } from './types.js';

/**
 * Gemini über die REST-Schnittstelle.
 *
 * Bewusst `fetch` statt des Anbieter-SDK: es geht um zwei Endpunkte, das SDK
 * wäre eine Abhängigkeit mit eigenem Versionsverlauf für etwa hundert Zeilen
 * Code. Außerdem ist das SSE-Parsing hier sichtbar - und das ist genau die
 * Stelle, an der die Marker-Erkennung ansetzt.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function createGeminiClient(apiKey: string): AiClient {
  return {
    embeddingModel: limits.embedding.model,
    chatModel: limits.chat.model,

    embedDocuments: (texts) => embed(apiKey, texts, 'RETRIEVAL_DOCUMENT'),

    async embedQuery(text) {
      const [vector] = await embed(apiKey, [text], 'RETRIEVAL_QUERY');
      if (!vector) throw new AiError('Kein Embedding für die Frage erhalten.', false);
      return vector;
    },

    streamChat: (request) => streamChat(apiKey, request),
  };
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

async function embed(
  apiKey: string,
  texts: string[],
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const results: number[][] = [];
  // In Stapeln, nicht einzeln: ein Netzaufruf je Abschnitt wäre bei einem
  // achtzigseitigen PDF ein paar hundert Anfragen hintereinander.
  for (let i = 0; i < texts.length; i += limits.embedding.batchSize) {
    const batch = texts.slice(i, i + limits.embedding.batchSize);
    results.push(...(await embedBatch(apiKey, batch, taskType)));
  }
  return results;
}

async function embedBatch(
  apiKey: string,
  texts: string[],
  taskType: string,
): Promise<number[][]> {
  const body = {
    requests: texts.map((text) => ({
      model: `models/${limits.embedding.model}`,
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality: limits.embedding.dimensions,
    })),
  };

  const data = await withRetry(async () => {
    const response = await fetch(
      `${API_BASE}/models/${limits.embedding.model}:batchEmbedContents`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) throw await toAiError(response);
    return (await response.json()) as { embeddings?: { values?: number[] }[] };
  });

  const embeddings = data.embeddings ?? [];
  if (embeddings.length !== texts.length) {
    throw new AiError('Unerwartete Anzahl Embeddings erhalten.', false);
  }

  return embeddings.map((entry) => {
    const values = entry.values;
    if (!values || values.length === 0) throw new AiError('Leeres Embedding erhalten.', false);
    return normalize(values);
  });
}

/**
 * Bringt den Vektor auf Länge 1.
 *
 * Notwendig, weil wir die Dimensionen von 3072 auf 768 reduzieren lassen
 * (`outputDimensionality`). Das Modell schneidet den Vektor dabei ab, und ein
 * abgeschnittener Vektor ist nicht mehr normiert. Ohne diesen Schritt hängt
 * die Kosinus-Ähnlichkeit an der Restlänge statt an der Bedeutung.
 */
function normalize(values: number[]): number[] {
  let sum = 0;
  for (const value of values) sum += value * value;
  const length = Math.sqrt(sum);
  return length === 0 ? values : values.map((value) => value / length);
}

// ---------------------------------------------------------------------------
// Chat-Stream
// ---------------------------------------------------------------------------

async function* streamChat(apiKey: string, request: ChatRequest): AsyncIterable<string> {
  const body = {
    // Der System-Prompt steht in einem eigenen Feld, nicht als erste
    // Nachricht. Damit kann Dokumentinhalt, der wie eine Nachricht aussieht,
    // ihn nicht überschreiben.
    systemInstruction: { parts: [{ text: request.system }] },
    contents: request.messages.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    })),
    generationConfig: {
      // Niedrig, aber nicht null: die Antwort soll aus den Textstellen kommen,
      // nicht aus der Fantasie des Modells.
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
  };

  const response = await fetch(
    `${API_BASE}/models/${limits.chat.model}:streamGenerateContent?alt=sse`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: request.signal,
    },
  );

  if (!response.ok) throw await toAiError(response);
  if (!response.body) throw new AiError('Keine Antwort vom Modell erhalten.', true);

  // Das Zerlegen des Ereignisstroms steckt in sse.ts - dort ist es ohne Netz
  // testbar, und genau dort sitzen die Fallen (Zeilenenden, Paketgrenzen).
  yield* sseTextChunks(response.body as unknown as AsyncIterable<Uint8Array>);
}

// ---------------------------------------------------------------------------
// Fehler und Wiederholung
// ---------------------------------------------------------------------------

async function toAiError(response: Response): Promise<AiError> {
  // Der Fehlertext des Anbieters wird geloggt, aber nie weitergereicht: er kann
  // Teile des Prompts enthalten, und der Prompt enthält Nutzerdokumente.
  const detail = await response.text().catch(() => '');
  logger.error('Fehler vom KI-Anbieter', { status: response.status, detail: detail.slice(0, 500) });

  // 429 (Kontingent) und 5xx sind vorübergehend, 4xx sonst nicht - ein
  // falscher Schlüssel wird durch Wiederholen nicht richtig.
  const retryable = response.status === 429 || response.status >= 500;
  return new AiError(`Der KI-Dienst antwortete mit Status ${response.status}.`, retryable);
}

/**
 * Wiederholung mit exponentiell wachsender Wartezeit.
 *
 * Ohne Wartezeit zwischen den Versuchen macht ein Wiederholungsmechanismus die
 * Lage schlimmer: bei einem Kontingentfehler schickt er sofort die nächste
 * Anfrage in dasselbe volle Kontingent.
 */
async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < limits.embedding.maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error instanceof AiError && !error.retryable) throw error;

      const isLast = attempt === limits.embedding.maxRetries - 1;
      if (isLast) break;

      const delay = limits.embedding.baseRetryDelayMs * 2 ** attempt;
      logger.warn('Wiederhole Anfrage an den KI-Dienst', { attempt: attempt + 1, delay });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError instanceof AiError
    ? lastError
    : new AiError('Der KI-Dienst ist nicht erreichbar.', true);
}
