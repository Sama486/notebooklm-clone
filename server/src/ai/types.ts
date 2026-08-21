/**
 * Die Schnittstelle zum KI-Anbieter.
 *
 * Der Rest der Anwendung kennt nur dieses Interface und weiss nicht, wer
 * dahintersteckt. Das ist keine Abstraktion um ihrer selbst willen, sondern hat
 * zwei konkrete Gruende:
 *
 * 1. Die Tests laufen gegen ein deterministisches Test-Double (testDouble.ts)
 *    und rufen nie eine echte API auf. Ein Test, der Geld kostet, an einem
 *    Kontingent haengt und bei jedem Lauf ein anderes Ergebnis liefert, wird
 *    nicht ausgefuehrt - und ein Test, der nicht ausgefuehrt wird, ist keiner.
 * 2. Ein Anbieterwechsel bleibt auf eine Datei begrenzt.
 */

export interface AiClient {
  readonly embeddingModel: string;
  readonly chatModel: string;

  /**
   * Bettet Dokumentabschnitte ein.
   *
   * Getrennt von `embedQuery`, weil beide Seiten unterschiedlich eingebettet
   * werden muessen: eine Frage ("Wie wird der Besitz geprueft?") und die
   * Antwortstelle im Dokument sehen sprachlich verschieden aus. Das
   * Embedding-Modell bekommt deshalb mitgeteilt, welche Rolle der Text spielt.
   * Beide Seiten gleich einzubetten kostet spuerbar Trefferqualitaet.
   */
  embedDocuments(texts: string[]): Promise<number[][]>;

  embedQuery(text: string): Promise<number[]>;

  /** Liefert die Antwort stueckweise, so wie das Modell sie erzeugt. */
  streamChat(request: ChatRequest): AsyncIterable<string>;
}

export interface ChatRequest {
  /**
   * Die Anweisung an das Modell. Enthaelt unter anderem die Abgrenzung des
   * Referenzmaterials gegen Anweisungen (siehe chat/prompt.ts).
   */
  system: string;
  messages: ChatMessage[];
  /** Bricht den Modellaufruf ab, wenn der Client die Verbindung schliesst. */
  signal?: AbortSignal;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Fehler beim Modellaufruf. Wird nie unveraendert an den Client gereicht. */
export class AiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AiError';
  }
}
