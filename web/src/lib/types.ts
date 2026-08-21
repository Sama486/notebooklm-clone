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
  content: string;
  citations: Citation[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[] | null;
  createdAt: string;
}
