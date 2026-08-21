import { useRef, useState, type FormEvent } from 'react';
import { apiRequest, ApiError, rawRequest } from '../lib/api.js';
import type { Source } from '../lib/types.js';

/** Muss zur Grenze in server/src/config.ts passen. */
const MAX_PDF_BYTES = 15 * 1024 * 1024;

const STATUS_LABEL: Record<Source['status'], string> = {
  pending: 'wartet',
  processing: 'wird gelesen',
  ready: 'bereit',
  failed: 'fehlgeschlagen',
};

const STATUS_STYLE: Record<Source['status'], string> = {
  pending: 'bg-slate-100 text-slate-600',
  processing: 'bg-sky-100 text-sky-700',
  ready: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
};

interface SourcesPanelProps {
  notebookId: string;
  sources: Source[];
  onChanged: () => void;
  onOpenSource: (sourceId: string) => void;
  openSourceId: string | null;
}

export function SourcesPanel({
  notebookId,
  sources,
  onChanged,
  onOpenSource,
  openSourceId,
}: SourcesPanelProps) {
  const [tab, setTab] = useState<'pdf' | 'text' | 'url'>('pdf');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Es ist ein Fehler aufgetreten.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex h-full flex-col border-r border-slate-200 bg-white">
      <header className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Quellen</h2>
      </header>

      <div className="border-b border-slate-200 px-4 py-3">
        <div className="mb-3 flex gap-1 rounded-md bg-slate-100 p-1 text-xs">
          {(['pdf', 'text', 'url'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setTab(value);
                setError(null);
              }}
              className={`flex-1 rounded px-2 py-1 font-medium transition ${
                tab === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              {value === 'pdf' ? 'PDF' : value === 'text' ? 'Text' : 'Website'}
            </button>
          ))}
        </div>

        {tab === 'pdf' && <PdfForm notebookId={notebookId} busy={busy} run={run} />}
        {tab === 'text' && <TextForm notebookId={notebookId} busy={busy} run={run} />}
        {tab === 'url' && <UrlForm notebookId={notebookId} busy={busy} run={run} />}

        {error && (
          <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}
      </div>

      <ul className="flex-1 overflow-y-auto p-3">
        {sources.length === 0 ? (
          <li className="px-1 py-4 text-sm text-slate-500">
            Noch keine Quelle. Ohne Quelle kann der Chat nichts beantworten - er antwortet
            ausschliesslich aus dem, was hier steht.
          </li>
        ) : (
          sources.map((source) => (
            <li
              key={source.id}
              className={`mb-2 rounded-lg border p-3 transition ${
                openSourceId === source.id
                  ? 'border-sky-300 bg-sky-50'
                  : 'border-slate-200 bg-white'
              }`}
            >
              <div className="flex items-start gap-2">
                {/* Nur ausgewaehlte Quellen werden durchsucht. */}
                <input
                  type="checkbox"
                  checked={source.selected}
                  disabled={source.status !== 'ready'}
                  onChange={(event) =>
                    void run(() =>
                      apiRequest(`/api/notebooks/${notebookId}/sources/${source.id}`, {
                        method: 'PATCH',
                        body: { selected: event.target.checked },
                      }),
                    )
                  }
                  title="Bei Fragen beruecksichtigen"
                  className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 text-sky-600 focus:ring-sky-500 disabled:opacity-40"
                />

                <button
                  type="button"
                  onClick={() => onOpenSource(source.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-sm font-medium text-slate-900">
                    {source.title}
                  </span>
                  <span
                    className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_STYLE[source.status]}`}
                  >
                    {STATUS_LABEL[source.status]}
                    {source.status === 'ready' && ` · ${source.chunkCount} Abschnitte`}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    void run(() =>
                      apiRequest(`/api/notebooks/${notebookId}/sources/${source.id}`, {
                        method: 'DELETE',
                      }),
                    )
                  }
                  title="Quelle loeschen"
                  className="shrink-0 rounded px-1.5 py-0.5 text-xs text-slate-400 transition hover:bg-red-50 hover:text-red-700"
                >
                  ✕
                </button>
              </div>

              {source.status === 'failed' && (
                <div className="mt-2 rounded bg-red-50 p-2">
                  <p className="text-xs text-red-700">{source.error}</p>
                  <button
                    type="button"
                    onClick={() =>
                      void run(() =>
                        apiRequest(
                          `/api/notebooks/${notebookId}/sources/${source.id}/reingest`,
                          { method: 'POST' },
                        ),
                      )
                    }
                    className="mt-1 text-xs font-medium text-red-800 underline"
                  >
                    Erneut versuchen
                  </button>
                </div>
              )}
            </li>
          ))
        )}
      </ul>
    </section>
  );
}

interface FormProps {
  notebookId: string;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}

function PdfForm({ notebookId, busy, run }: FormProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) return;

    // Vorabpruefung im Browser: erspart dem Nutzer, 20 MB hochzuladen und dann
    // ein 413 zu bekommen. Die verbindliche Grenze steht trotzdem auf dem
    // Server - diese hier laesst sich umgehen.
    if (file.size > MAX_PDF_BYTES) {
      setLocalError('Die Datei ist groesser als 15 MB.');
      return;
    }
    setLocalError(null);

    // Der Dateiname wird als Titel vorgeschlagen, mehr nicht - er beruehrt
    // serverseitig keinen Pfad.
    const title = file.name.replace(/\.pdf$/i, '').slice(0, 200) || 'Dokument';

    await run(async () => {
      await rawRequest(
        `/api/notebooks/${notebookId}/sources/pdf?title=${encodeURIComponent(title)}`,
        { method: 'POST', raw: { data: file, contentType: 'application/pdf' } },
      );
      if (inputRef.current) inputRef.current.value = '';
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        required
        className="block w-full text-xs text-slate-600 file:mr-2 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-xs file:font-medium"
      />
      {localError && <p className="text-xs text-red-700">{localError}</p>}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-700 disabled:opacity-50"
      >
        Hochladen
      </button>
    </form>
  );
}

function TextForm({ notebookId, busy, run }: FormProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        await run(async () => {
          await apiRequest(`/api/notebooks/${notebookId}/sources/text`, {
            method: 'POST',
            body: { title: title.trim(), content },
          });
          setTitle('');
          setContent('');
        });
      }}
      className="space-y-2"
    >
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Titel"
        required
        maxLength={200}
        className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs focus:border-sky-500 focus:outline-none"
      />
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder="Text einfuegen"
        required
        rows={4}
        className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs focus:border-sky-500 focus:outline-none"
      />
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-700 disabled:opacity-50"
      >
        Hinzufuegen
      </button>
    </form>
  );
}

function UrlForm({ notebookId, busy, run }: FormProps) {
  const [url, setUrl] = useState('');

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        await run(async () => {
          await apiRequest(`/api/notebooks/${notebookId}/sources/url`, {
            method: 'POST',
            body: { url: url.trim() },
          });
          setUrl('');
        });
      }}
      className="space-y-2"
    >
      <input
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://..."
        required
        maxLength={2000}
        className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs focus:border-sky-500 focus:outline-none"
      />
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-700 disabled:opacity-50"
      >
        Seite laden
      </button>
    </form>
  );
}
