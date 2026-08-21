import { env, isTest } from '../config.js';
import { logger } from '../logger.js';
import { createGeminiClient } from './gemini.js';
import { createTestAiClient } from './testDouble.js';
import type { AiClient } from './types.js';

/**
 * Die einzige Stelle, an der entschieden wird, welcher KI-Client verwendet wird.
 *
 * Der Rest der Anwendung ruft `getAiClient()` und bekommt etwas, das dem
 * AiClient-Interface entspricht. Ein Anbieterwechsel betrifft diese Datei und
 * eine Implementierung - sonst nichts.
 */

let client: AiClient | null = null;

export function getAiClient(): AiClient {
  if (client) return client;

  // In Tests niemals ein echter Aufruf. Auch nicht versehentlich, wenn jemand
  // einen Schlüssel in der Testumgebung stehen hat.
  if (isTest) {
    client = createTestAiClient();
    return client;
  }

  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY fehlt - ohne Schlüssel gibt es keine Embeddings und keinen Chat.');
  }

  logger.info('KI-Client erzeugt', { anbieter: 'gemini' });
  client = createGeminiClient(env.GEMINI_API_KEY);
  return client;
}

/** Nur für Tests: setzt einen eigenen Client ein. */
export function setAiClient(replacement: AiClient): void {
  client = replacement;
}
