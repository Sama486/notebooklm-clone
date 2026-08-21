/**
 * Die Schnittstelle zum KI-Anbieter.
 *
 * Der Rest der Anwendung kennt nur dieses Interface und weiß nicht, wer
 * dahintersteckt. Das ist keine Abstraktion um ihrer selbst willen, sondern hat
 * zwei konkrete Gründe:
 *
 * 1. Die Tests laufen gegen ein deterministisches Test-Double (testDouble.ts)
 *    und rufen nie eine echte API auf. Ein Test, der Geld kostet, an einem
 *    Kontingent hängt und bei jedem Lauf ein anderes Ergebnis liefert, wird
 *    nicht ausgeführt - und ein Test, der nicht ausgeführt wird, ist keiner.
 * 2. Ein Anbieterwechsel bleibt auf eine Datei begrenzt.
 */

export interface AiClient {
  readonly embeddingModel: string;
  readonly chatModel: string;

  /**
   * Bettet Dokumentabschnitte ein.
   *
   * Getrennt von `embedQuery`, weil beide Seiten unterschiedlich eingebettet
   * werden müssen: eine Frage ("Wie wird der Besitz geprüft?") und die
   * Antwortstelle im Dokument sehen sprachlich verschieden aus. Das
   * Embedding-Modell bekommt deshalb mitgeteilt, welche Rolle der Text spielt.
   * Beide Seiten gleich einzubetten kostet spürbar Trefferqualität.
   */
  embedDocuments(texts: string[]): Promise<number[][]>;

  embedQuery(text: string): Promise<number[]>;

  /** Liefert die Antwort stückweise, so wie das Modell sie erzeugt. */
  streamChat(request: ChatRequest): AsyncIterable<string>;
}

export interface ChatRequest {
  /**
   * Die Anweisung an das Modell. Enthält unter anderem die Abgrenzung des
   * Referenzmaterials gegen Anweisungen (siehe chat/prompt.ts).
   */
  system: string;
  messages: ChatMessage[];
  /** Bricht den Modellaufruf ab, wenn der Client die Verbindung schließt. */
  signal?: AbortSignal;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Fehler beim Modellaufruf. Wird nie unverändert an den Client gereicht. */
export class AiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AiError';
  }
}
