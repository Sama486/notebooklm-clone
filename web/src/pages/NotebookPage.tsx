import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiRequest, ApiError } from '../lib/api.js';
import { SourcesPanel } from '../components/SourcesPanel.js';
import { ChatPanel } from '../components/ChatPanel.js';
import { DocumentPanel } from '../components/DocumentPanel.js';
import { NotesPanel } from '../components/NotesPanel.js';
import type { Citation, NotebookSummary, Note, Source } from '../lib/types.js';

/** Abstand, in dem während der Verarbeitung nach dem Status gefragt wird. */
const POLL_INTERVAL_MS = 1500;

export function NotebookPage() {
  const { notebookId = '' } = useParams();

  const [notebook, setNotebook] = useState<Pick<NotebookSummary, 'id' | 'title'> | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [openSourceId, setOpenSourceId] = useState<string | null>(null);
  const [citation, setCitation] = useState<Citation | null>(null);

  // Die rechte Spalte zeigt entweder das Dokument oder die Notizen.
  const [rechteSpalte, setRechteSpalte] = useState<'dokument' | 'notizen'>('dokument');
  const [notes, setNotes] = useState<Note[]>([]);

  const loadNotes = useCallback(async () => {
    try {
      const data = await apiRequest<{ notes: Note[] }>(`/api/notebooks/${notebookId}/notes`);
      setNotes(data.notes);
    } catch {
      // Fehlende Notizen machen die Seite nicht unbenutzbar.
      setNotes([]);
    }
  }, [notebookId]);

  /**
   * Alle schreibenden Notiz-Aktionen laufen hier durch.
   *
   * Nach jeder Änderung wird die Liste neu geladen statt lokal fortgeschrieben.
   * Das ist eine Anfrage mehr, aber der Zustand im Browser kann dadurch nicht
   * von dem in der Datenbank abweichen - bei höchstens zweihundert Notizen ist
   * das der bessere Tausch.
   */
  const notizAktion = useCallback(
    async (aktion: () => Promise<unknown>): Promise<boolean> => {
      try {
        await aktion();
        await loadNotes();
        return true;
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'Aktion fehlgeschlagen.');
        return false;
      }
    },
    [loadNotes],
  );

  const saveNote = useCallback(
    (title: string, content: string, citations: Citation[]) =>
      notizAktion(() =>
        apiRequest(`/api/notebooks/${notebookId}/notes`, {
          method: 'POST',
          body: { title, content, citations },
        }),
      ),
    [notebookId, notizAktion],
  );

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
    void loadNotes();
    return () => {
      cancelled = true;
    };
  }, [notebookId, loadNotes]);

  /**
   * Nach dem Status fragen, solange etwas verarbeitet wird - und nur dann.
   *
   * Das Einlesen läuft im Hintergrund; der Fortschritt steht in der Datenbank.
   * Die Abfrage hält an, sobald keine Quelle mehr "pending" oder "processing"
   * ist. Ein dauerhaft laufender Zeitgeber würde die API sonst rund um die
   * Uhr belasten, obwohl es nichts zu holen gibt.
   */
  const busySources = sources.some((s) => s.status === 'pending' || s.status === 'processing');

  useEffect(() => {
    if (!busySources) return;

    const timer = setInterval(() => void loadSources(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [busySources, loadSources]);

  function openCitation(next: Citation) {
    setCitation(next);
    setOpenSourceId(next.sourceId);
    // Ein Klick auf einen Beleg meint immer das Dokument, auch wenn gerade die
    // Notizen offen sind.
    setRechteSpalte('dokument');
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

      {/*
        Drei Spalten ab großen Bildschirmen, darunter untereinander.

        Der Unterschied steckt darin, WER scrollt. Ab `lg` ist die Seite so hoch
        wie das Fenster und jede Spalte scrollt für sich - so soll es am
        Schreibtisch sein. Gestapelt geht das nicht auf: drei Bereiche teilen
        sich dieselbe Fensterhöhe, jeder bekommt ein Drittel, und in ein Drittel
        passt das Quellen-Formular nicht mehr hinein. Der "Hinzufügen"-Knopf
        verschwand dabei hinter dem Chat und war nicht mehr anklickbar.

        Deshalb gilt gestapelt die umgekehrte Regel: die SEITE scrollt, jeder
        Bereich bekommt eine Mindesthöhe und darf so hoch werden, wie er muss.
      */}
      <div className="grid flex-1 grid-cols-1 overflow-y-auto lg:min-h-0 lg:grid-cols-[18rem_minmax(0,1fr)_22rem] lg:overflow-hidden">
        <div className="min-h-[32rem] border-b border-slate-200 lg:min-h-0 lg:border-b-0">
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

        <div className="min-h-[32rem] lg:min-h-0">
          <ChatPanel
            notebookId={notebookId}
            notebookTitle={notebook?.title ?? 'Notebook'}
            readySourceCount={readySourceCount}
            onCitationClick={openCitation}
            onSaveNote={saveNote}
          />
        </div>

        <div className="flex min-h-[32rem] flex-col border-l border-slate-200 bg-white lg:min-h-0">
          <div className="flex gap-1 border-b border-slate-200 px-3 py-2">
            {(['dokument', 'notizen'] as const).map((bereich) => (
              <button
                key={bereich}
                type="button"
                onClick={() => setRechteSpalte(bereich)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                  rechteSpalte === bereich
                    ? 'bg-slate-100 text-slate-900'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {bereich === 'dokument' ? 'Dokument' : `Notizen${notes.length ? ` (${notes.length})` : ''}`}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1">
            {rechteSpalte === 'dokument' ? (
              <DocumentPanel
                notebookId={notebookId}
                sourceId={openSourceId}
                citation={citation}
                onClose={() => {
                  setOpenSourceId(null);
                  setCitation(null);
                }}
              />
            ) : (
              <NotesPanel
                notes={notes}
                onCreate={(title, content) =>
                  notizAktion(() =>
                    apiRequest(`/api/notebooks/${notebookId}/notes`, {
                      method: 'POST',
                      body: { title, content },
                    }),
                  )
                }
                onRename={(noteId, title) =>
                  notizAktion(() =>
                    apiRequest(`/api/notebooks/${notebookId}/notes/${noteId}`, {
                      method: 'PATCH',
                      body: { title },
                    }),
                  )
                }
                onDelete={async (noteId) => {
                  await notizAktion(() =>
                    apiRequest(`/api/notebooks/${notebookId}/notes/${noteId}`, {
                      method: 'DELETE',
                    }),
                  );
                }}
                onCitationClick={openCitation}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
