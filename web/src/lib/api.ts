/**
 * Der einzige Weg, auf dem das Frontend mit der API spricht.
 *
 * Alles läuft hier durch, damit es genau eine Stelle gibt für: den Token
 * anhängen, Fehler in etwas Anzeigbares übersetzen und auf 401 reagieren.
 * Verstreute `fetch`-Aufrufe wären drei Stellen, an denen eines davon fehlt.
 */

// Leer im Entwicklungsbetrieb: dann läuft alles über den Vite-Proxy und
// damit über denselben Ursprung.
const BASE_URL = import.meta.env.VITE_API_URL ?? '';

const TOKEN_KEY = 'notebooklm-clone.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/**
 * Fehler mit einer Meldung, die angezeigt werden darf.
 *
 * Die Meldung kommt aus der API und ist dort bereits daraufhin gefiltert, dass
 * sie keine internen Details enthält.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Wird gesetzt, sobald der AuthProvider steht - Reaktion auf abgelaufene Token. */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Roh-Body für den PDF-Upload; umgeht die JSON-Serialisierung. */
  raw?: { data: Blob | ArrayBuffer; contentType: string };
  signal?: AbortSignal;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await rawRequest(path, options);
  if (response.status === 204) return undefined as T;

  // Antwort auf JSON prüfen, statt blind zu parsen.
  //
  // Zeigt VITE_API_URL versehentlich auf das Frontend statt auf die API, dann
  // beantwortet der Static-Host jeden Pfad mit index.html - und zwar mit
  // Status 200. Ohne diese Prüfung scheitert erst `response.json()` an einem
  // "<", und der Nutzer bekäme "Es ist ein Fehler aufgetreten" für einen
  // reinen Konfigurationsfehler. Genau das ist beim ersten Deployment passiert.
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new ApiError(
      response.status,
      'unexpected_response',
      'Der Server hat keine gültige Antwort geliefert. Ist die API-Adresse richtig konfiguriert?',
    );
  }

  return (await response.json()) as T;
}

export async function rawRequest(path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};

  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let body: BodyInit | undefined;
  if (options.raw) {
    headers['Content-Type'] = options.raw.contentType;
    body = options.raw.data;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
      signal: options.signal,
    });
  } catch (error) {
    // Abbruch durch den Aufrufer ist kein Fehler, sondern eine Entscheidung.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network', 'Keine Verbindung zum Server.');
  }

  if (response.ok) return response;

  // 401 heißt: Token fehlt oder ist abgelaufen. Der Nutzer landet auf der
  // Anmeldeseite, statt auf einer Seite voller Fehlermeldungen zu sitzen.
  if (response.status === 401) {
    setToken(null);
    onUnauthorized?.();
  }

  throw await toApiError(response);
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const payload = (await response.json()) as { error?: { code?: string; message?: string } };
    return new ApiError(
      response.status,
      payload.error?.code ?? 'unknown',
      payload.error?.message ?? 'Unbekannter Fehler.',
    );
  } catch {
    // Antwort ohne lesbares JSON - etwa ein Fehler aus einer Zwischenschicht.
    return new ApiError(response.status, 'unknown', `Fehler ${response.status}.`);
  }
}
