import { createHash } from 'node:crypto';
import { limits } from '../config.js';
import type { AiClient, ChatRequest } from './types.js';

/**
 * Deterministisches Test-Double des KI-Clients.
 *
 * Ruft nie eine echte API auf. Die Tests sollen die Anwendung prüfen - nicht
 * die Tagesform eines Sprachmodells und nicht die Netzverbindung. Ein Test, der
 * Geld kostet und gelegentlich anders ausgeht, wird abgeschaltet, und ein
 * abgeschalteter Test schützt niemanden.
 *
 * Die Embeddings sind ein Hash über den Text: gleicher Text ergibt immer
 * denselben Vektor, ähnlicher Text ergibt keinen ähnlichen Vektor. Für alles
 * außer der Trefferqualität reicht das - und die Trefferqualität wird nicht
 * im Testlauf gemessen, sondern im Modellvergleich von Hand.
 */

export interface TestDoubleOptions {
  /**
   * Antwort des Modells, in Paketen. Die Aufteilung ist Absicht: damit lässt
   * sich ein über zwei Pakete zerrissener Zitat-Marker gezielt erzeugen.
   */
  reply?: string[];
  /** Wird statt einer Antwort geworfen. */
  failWith?: Error;
  /** Verzögerung je Paket in Millisekunden. */
  delayMs?: number;
}

export interface TestAiClient extends AiClient {
  /** Alle bisher gestellten Chat-Anfragen - für Zusicherungen über den Prompt. */
  readonly requests: ChatRequest[];
  setReply(parts: string[]): void;
}

export function createTestAiClient(options: TestDoubleOptions = {}): TestAiClient {
  const requests: ChatRequest[] = [];
  let reply = options.reply ?? ['Eine Antwort aus den Quellen [1].'];

  return {
    embeddingModel: 'test-embedding',
    chatModel: 'test-chat',
    requests,

    setReply(parts) {
      reply = parts;
    },

    async embedDocuments(texts) {
      return texts.map(deterministicEmbedding);
    },

    async embedQuery(text) {
      return deterministicEmbedding(text);
    },

    async *streamChat(request) {
      requests.push(request);
      if (options.failWith) throw options.failWith;

      for (const part of reply) {
        if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
        yield part;
      }
    },
  };
}

/**
 * Vektor aus einem Hash des Textes. Gleicher Text, gleicher Vektor - über
 * Prozessgrenzen und Testläufe hinweg.
 */
export function deterministicEmbedding(text: string): number[] {
  const values: number[] = [];
  let counter = 0;

  while (values.length < limits.embedding.dimensions) {
    const digest = createHash('sha256').update(`${counter}:${text}`).digest();
    for (const byte of digest) {
      if (values.length >= limits.embedding.dimensions) break;
      values.push(byte / 255 - 0.5);
    }
    counter += 1;
  }

  // Auf Länge 1 bringen, wie es der echte Client auch tut.
  let sum = 0;
  for (const value of values) sum += value * value;
  const length = Math.sqrt(sum);
  return length === 0 ? values : values.map((value) => value / length);
}
