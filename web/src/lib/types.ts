/** Die Formen, die die API liefert. Eine Quelle der Wahrheit fürs Frontend. */

export interface User {
  id: string;
  email: string;
}

export interface NotebookSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sourceCount: number;
}

export type SourceStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface Source {
  id: string;
  title: string;
  type: 'pdf' | 'text' | 'url';
  originalUrl: string | null;
  status: SourceStatus;
  error: string | null;
  chunkCount: number;
  selected: boolean;
  sizeBytes: number;
  createdAt: string;
}

/** Nur die Einzelansicht liefert den Volltext - Listen bewusst nicht. */
export interface SourceWithContent extends Source {
  content: string;
}

/**
 * Ein Beleg. `charStart` und `charEnd` sind Positionen im Volltext der Quelle;
 * die Dokumentansicht springt dorthin und hebt den Bereich hervor.
 */
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

/** Eine gespeicherte Notiz - meist eine Antwort, die behalten werden soll. */
export interface Note {
  id: string;
  title: string;
  /** Der reine Wortlaut, ohne die Marker. */
  content: string;
  /** Wie bei einer Nachricht: Textstücke mit den Markern dahinter. */
  segments?: { text: string; markers: number[] }[];
  citations: Citation[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  /** Der reine Wortlaut, ohne die Marker. */
  content: string;
  /**
   * Textstücke mit den Markern, die dahinter standen.
   *
   * Kommt vom Server, der den gespeicherten Text mit derselben Funktion
   * zerlegt wie beim Streamen. Dadurch stehen die Chips nach einem Neuladen
   * wieder an ihrer Stelle statt gesammelt am Ende.
   */
  segments?: { text: string; markers: number[] }[];
  citations: Citation[] | null;
  createdAt: string;
}
