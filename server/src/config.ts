import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Die .env liegt im Repo-Wurzelverzeichnis, damit Server und Frontend sich eine
// einzige Datei teilen. In der Produktion (Render) gibt es keine Datei - dort
// kommen die Werte aus der Umgebung und dotenv findet schlicht nichts.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4310),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL fehlt'),
  // Kurze Geheimnisse sind der häufigste Auth-Fehler - deshalb erzwungen.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET muss mindestens 32 Zeichen haben'),
  GEMINI_API_KEY: z.string().default(''),
  CORS_ORIGIN: z.string().default('http://localhost:5310'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Ungültige Umgebungskonfiguration:\n${details}`);
}
export const env = parsed.data;

/**
 * EINE Quelle der Wahrheit für alle Grenzwerte des Systems.
 *
 * Jede Zahl, die eine Regel ausdrückt, steht hier - nicht verstreut im Code.
 * Wer eine Grenze ändern will, ändert sie an genau einer Stelle.
 */
export const limits = {
  auth: {
    bcryptRounds: 12, // bewusst 12, nicht der verbreitete Standardwert 10
    tokenLifetime: '12h',
    jwtAlgorithm: 'HS256', // beim Verifizieren explizit gesetzt -> kein Algorithm Confusion
    passwordMin: 10,
    passwordMax: 200,
    emailMax: 254, // RFC 5321
  },

  body: {
    // Global klein. Nur der Upload-Endpunkt bekommt eine eigene, größere Grenze.
    json: '128kb',
    pdfUpload: 15 * 1024 * 1024,
    pastedText: 400_000, // Zeichen, entspricht grob einem 150-Seiten-Dokument
  },

  source: {
    titleMax: 200,
    // Obergrenze für extrahierten Text je Quelle. Schützt Speicher und Kosten,
    // wenn jemand ein präpariertes Dokument mit Millionen Zeichen hochlädt.
    extractedTextMax: 1_000_000,
    maxPerNotebook: 50,
  },

  chunking: {
    // Zielgrösse in Token; die Umrechnung Token->Zeichen steht in ingest/chunk.ts.
    targetTokens: 1200,
    overlapTokens: 180,
    minTokens: 40, // kleinere Reste werden an den Vorgänger angehängt
  },

  embedding: {
    model: 'gemini-embedding-001',
    dimensions: 768, // bewusst reduziert von 3072, siehe README (Skalierbarkeit)
    batchSize: 32,
    maxRetries: 4,
    baseRetryDelayMs: 500,
  },

  chat: {
    // Ausgewählt über scripts/compare-models.mjs - zwanzig Fragen gegen zwei
    // Modelle, gezählt wurde, wie oft ein Zitat-Marker fehlt, eine erfundene
    // Nummer trägt oder mitten im Wort steht. Ergebnis im README.
    //
    // Nicht gemini-3-flash: dort erlaubt die kostenlose Stufe nur zwanzig
    // Anfragen am Tag, was für eine Demo nicht reicht.
    model: 'gemini-3.5-flash-lite',
    topK: 8, // Anzahl der Textstellen, die in den Prompt gehen
    questionMax: 2000,
    historyMessages: 6, // wie viel Gesprächsverlauf in den Prompt geht
    snippetChars: 300, // Länge der im Zitat mitgelieferten Vorschau
  },

  fetchUrl: {
    timeoutMs: 10_000,
    maxRedirects: 3,
    maxResponseBytes: 5 * 1024 * 1024,
  },

  pagination: {
    defaultTake: 20,
    maxTake: 100,
  },

  rateLimit: {
    // Fenster in Millisekunden und erlaubte Anfragen darin.
    auth: { windowMs: 15 * 60_000, max: 10 },
    ingest: { windowMs: 60_000, max: 10 },
    chat: { windowMs: 60_000, max: 20 },
    global: { windowMs: 60_000, max: 300 },
  },
} as const;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Erlaubte Frontend-Herkünfte für CORS, aus der kommagetrennten Variable. */
export const corsOrigins = env.CORS_ORIGIN.split(',')
  .map((o) => o.trim())
  .filter((o) => o.length > 0);
