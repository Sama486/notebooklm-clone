import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiRequest, ApiError } from '../lib/api.js';
import { SourcesPanel } from '../components/SourcesPanel.js';
import { ChatPanel } from '../components/ChatPanel.js';
import { DocumentPanel } from '../components/DocumentPanel.js';
import type { Citation, NotebookSummary, Source } from '../lib/types.js';

/** Abstand, in dem während der Verarbeitung nach dem Status gefragt wird. */
const POLL_INTERVAL_MS = 1500;

export function NotebookPage() {
  const { notebookId = '' } = useParams();

  const [notebook, setNotebook] = useState<Pick<NotebookSummary, 'id' | 'title'> | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [openSourceId, setOpenSourceId] = useState<string | null>(null);
  const [citation, setCitation] = useState<Citation | null>(null);

  const loadSources = useCallback(async () => {
    try {
      const data = await apiRequest<{ sources: Source[] }>(
        `/api/notebooks/${notebookId}/sources`,
      );
      setSources(data.sources);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Laden fehlgeschlagen.');
    }
  }, [notebookId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await apiRequest<{
          notebook: Pick<NotebookSummary, 'id' | 'title'>;
          sources: Source[];
        }>(`/api/notebooks/${notebookId}`);
        if (cancelled) return;
        setNotebook(data.notebook);
        setSources(data.sources);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof ApiError ? caught.message : 'Notebook nicht gefunden.');
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [notebookId]);

  /**
   * Nach dem Status fragen, solange etwas verarbeitet wird - und nur dann.
   *
   * Das Einlesen läuft im Hintergrund; der Fortschritt steht in der Datenbank.
   * Die Abfrage hält an, sobald keine Quelle mehr "pending" oder "processing"
   * ist. Ein daürhaft laufender Zeitgeber würde die API sonst rund um die
   * Uhr belasten, obwohl es nichts zu holen gibt.
   */
  const pollingRef = useRef(false);
  const busySources = sources.some((s) => s.status === 'pending' || s.status === 'processing');

  useEffect(() => {
    if (!busySources || pollingRef.current) return;

    pollingRef.current = true;
    const timer = setInterval(() => void loadSources(), POLL_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      pollingRef.current = false;
    };
  }, [busySources, loadSources]);

  function openCitation(next: Citation) {
    setCitation(next);
    setOpenSourceId(next.sourceId);
  }

  const readySourceCount = sources.filter((s) => s.status === 'ready' && s.selected).length;

  if (error && !notebook) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4">
        <p className="text-sm text-slate-700">{error}</p>
        <Link to="/notebooks" className="text-sm font-medium text-sky-700 hover:underline">
          Zurück zur Übersicht
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
        <Link
          to="/notebooks"
          className="rounded px-2 py-1 text-sm text-slate-500 transition hover:bg-slate-100"
        >
          ← Notebooks
        </Link>
        <h1 className="truncate text-sm font-semibold text-slate-900">{notebook?.title ?? ''}</h1>
      </header>

      {/* Drei Spalten ab großen Bildschirmen; darunter untereinander, damit
          die Ansicht auf dem Telefon wenigstens benutzbar bleibt. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)_22rem]">
        <div className="min-h-0 border-b border-slate-200 lg:border-b-0">
          <SourcesPanel
            notebookId={notebookId}
            sources={sources}
            onChanged={() => void loadSources()}
            onOpenSource={(sourceId) => {
              setOpenSourceId(sourceId);
              setCitation(null);
            }}
            openSourceId={openSourceId}
          />
        </div>

        <div className="min-h-0">
          <ChatPanel
            notebookId={notebookId}
            readySourceCount={readySourceCount}
            onCitationClick={openCitation}
          />
        </div>

        <div className="min-h-0">
          <DocumentPanel
            notebookId={notebookId}
            sourceId={openSourceId}
            citation={citation}
            onClose={() => {
              setOpenSourceId(null);
              setCitation(null);
            }}
          />
        </div>
      </div>
    </div>
  );
}
