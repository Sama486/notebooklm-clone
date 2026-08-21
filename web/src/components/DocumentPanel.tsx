import { useEffect, useState } from 'react';
import { apiRequest, ApiError } from '../lib/api.js';
import { HighlightedText } from './HighlightedText.js';
import type { Citation, SourceWithContent } from '../lib/types.js';

/**
 * Die rechte Spalte: zeigt eine Quelle im Volltext und hebt die zitierte
 * Stelle hervor.
 *
 * Der Volltext kommt unveraendert aus der Datenbank - genau der Text, auf den
 * sich `charStart` und `charEnd` beziehen. Wuerde er hier noch bereinigt oder
 * umgebrochen, zeigte die Hervorhebung an die falsche Stelle.
 */

interface DocumentPanelProps {
  notebookId: string;
  sourceId: string | null;
  citation: Citation | null;
  onClose: () => void;
}

export function DocumentPanel({ notebookId, sourceId, citation, onClose }: DocumentPanelProps) {
  const [source, setSource] = useState<SourceWithContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sourceId) {
      setSource(null);
      return;
    }

    let cancelled = false;
    setSource(null);
    setError(null);

    async function load() {
      try {
        const data = await apiRequest<{ source: SourceWithContent }>(
          `/api/notebooks/${notebookId}/sources/${sourceId}`,
        );
        if (!cancelled) setSource(data.source);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof ApiError ? caught.message : 'Laden fehlgeschlagen.');
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [notebookId, sourceId]);

  if (!sourceId) {
    return (
      <aside className="hidden h-full flex-col border-l border-slate-200 bg-white lg:flex">
        <header className="border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Dokument</h2>
        </header>
        <div className="flex flex-1 items-center justify-center px-6">
          <p className="text-center text-sm text-slate-500">
            Klick auf eine Belegnummer in einer Antwort - die zitierte Stelle wird hier
            hervorgehoben.
          </p>
        </div>
      </aside>
    );
  }

  // Nur hervorheben, wenn der Beleg auch zu der Quelle gehoert, die gerade
  // offen ist. Sonst zeigte eine alte Position in ein anderes Dokument.
  const highlight = citation && citation.sourceId === sourceId ? citation : null;

  return (
    <aside className="flex h-full flex-col border-l border-slate-200 bg-white">
      <header className="flex items-start justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-slate-900">
            {source?.title ?? 'Wird geladen...'}
          </h2>
          {highlight && (
            <p className="text-xs text-slate-500">
              Beleg [{highlight.marker}]
              {highlight.page !== null && ` · Seite ${highlight.page}`}
            </p>
          )}
          {source?.originalUrl && (
            <a
              href={source.originalUrl}
              target="_blank"
              // noopener/noreferrer: ohne das bekaeme die geoeffnete Seite ueber
              // window.opener Zugriff auf unseren Tab.
              rel="noopener noreferrer"
              className="text-xs text-sky-700 hover:underline"
            >
              Original oeffnen
            </a>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded px-2 py-1 text-sm text-slate-400 transition hover:bg-slate-100"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 text-sm leading-relaxed text-slate-800">
        {error ? (
          <p className="rounded-md bg-red-50 px-3 py-2 text-red-700">{error}</p>
        ) : !source ? (
          <p className="text-slate-500">Wird geladen...</p>
        ) : (
          <HighlightedText
            text={source.content}
            charStart={highlight?.charStart ?? null}
            charEnd={highlight?.charEnd ?? null}
          />
        )}
      </div>
    </aside>
  );
}
