import { useRef, useState, type FormEvent } from 'react';
import { apiRequest, ApiError, rawRequest } from '../lib/api.js';
import type { Source } from '../lib/types.js';

/** Müssen zu den Grenzen in server/src/config.ts passen. */
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARS = 400_000;

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
  const [umbenannt, setUmbenannt] = useState<{ id: string; titel: string } | null>(null);

  const alleAusgewaehlt = sources.length > 0 && sources.every((quelle) => quelle.selected);

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
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Quellen</h2>
        {sources.length > 1 && (
          <button
            type="button"
            onClick={() =>
              void run(() =>
                // Eine Anfrage für alle Quellen statt einer je Quelle.
                apiRequest(`/api/notebooks/${notebookId}/sources/selection`, {
                  method: 'PATCH',
                  body: { selected: !alleAusgewaehlt },
                }),
              )
            }
            className="rounded px-2 py-1 text-xs text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
          >
            {alleAusgewaehlt ? 'Alle abwählen' : 'Alle auswählen'}
          </button>
        )}
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
          // Der Fehler steht hier oft allein da - eine Quelle wird ja gerade
          // nicht angelegt. Deshalb ein eigener Kasten mit Rahmen statt einer
          // kleinen Zeile, die zwischen den Formularfeldern untergeht.
          <div
            role="alert"
            className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-800"
          >
            <p className="text-xs font-semibold">Das hat nicht geklappt</p>
            <p className="mt-0.5 text-xs leading-relaxed">{error}</p>
          </div>
        )}
      </div>

      <ul className="flex-1 overflow-y-auto p-3">
        {sources.length === 0 ? (
          <li className="px-1 py-4 text-sm text-slate-500">
            Noch keine Quelle. Ohne Quelle kann der Chat nichts beantworten - er antwortet
            ausschließlich aus dem, was hier steht.
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
                {/* Nur ausgewählte Quellen werden durchsucht. */}
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
                  title="Bei Fragen berücksichtigen"
                  className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 text-sky-600 focus:ring-sky-500 disabled:opacity-40"
                />

                {umbenannt?.id === source.id ? (
                  <input
                    autoFocus
                    value={umbenannt.titel}
                    onChange={(event) => setUmbenannt({ id: source.id, titel: event.target.value })}
                    onBlur={async () => {
                      const neu = umbenannt.titel.trim();
                      setUmbenannt(null);
                      if (neu && neu !== source.title) {
                        await run(() =>
                          apiRequest(`/api/notebooks/${notebookId}/sources/${source.id}`, {
                            method: 'PATCH',
                            body: { title: neu },
                          }),
                        );
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                      if (event.key === 'Escape') setUmbenannt(null);
                    }}
                    maxLength={200}
                    className="min-w-0 flex-1 rounded border border-sky-400 px-1 py-0.5 text-sm focus:outline-none"
                  />
                ) : (
                <button
                  type="button"
                  onClick={() => onOpenSource(source.id)}
                  onDoubleClick={() => setUmbenannt({ id: source.id, titel: source.title })}
                  title="Klicken zum Öffnen, Doppelklick zum Umbenennen"
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
                )}

                <button
                  type="button"
                  onClick={() =>
                    void run(() =>
                      apiRequest(`/api/notebooks/${notebookId}/sources/${source.id}`, {
                        method: 'DELETE',
                      }),
                    )
                  }
                  title="Quelle löschen"
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
  const [fortschritt, setFortschritt] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const dateien = [...(inputRef.current?.files ?? [])];
    if (dateien.length === 0) return;

    // Vorabprüfung im Browser: erspart dem Nutzer, 20 MB hochzuladen und dann
    // ein 413 zu bekommen. Die verbindliche Grenze steht trotzdem auf dem
    // Server - diese hier lässt sich umgehen.
    const zuGross = dateien.find((datei) => datei.size > MAX_PDF_BYTES);
    if (zuGross) {
      setLocalError(`"${zuGross.name}" ist größer als 15 MB.`);
      return;
    }
    setLocalError(null);

    await run(async () => {
      const fehlgeschlagen: string[] = [];

      // Nacheinander, nicht gleichzeitig. Zehn PDFs parallel hochzuladen würde
      // das Rate-Limit auslösen und auf einer Instanz mit 512 MB alle Dateien
      // gleichzeitig in den Speicher holen.
      for (const [index, datei] of dateien.entries()) {
        setFortschritt(`${index + 1} von ${dateien.length}: ${datei.name}`);

        // Der Dateiname wird als Titel vorgeschlagen, mehr nicht - er berührt
        // serverseitig keinen Pfad.
        const title = datei.name.replace(/\.pdf$/i, '').slice(0, 200) || 'Dokument';
        try {
          await rawRequest(
            `/api/notebooks/${notebookId}/sources/pdf?title=${encodeURIComponent(title)}`,
            { method: 'POST', raw: { data: datei, contentType: 'application/pdf' } },
          );
        } catch {
          // Eine kaputte Datei soll die übrigen nicht aufhalten - gemeldet
          // wird sie am Ende gesammelt.
          fehlgeschlagen.push(datei.name);
        }
      }

      setFortschritt(null);
      if (inputRef.current) inputRef.current.value = '';
      if (fehlgeschlagen.length > 0) {
        setLocalError(`Nicht eingelesen: ${fehlgeschlagen.join(', ')}`);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        multiple
        required
        className="block w-full text-xs text-slate-600 file:mr-2 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-xs file:font-medium"
      />
      {fortschritt && <p className="text-xs text-slate-500">{fortschritt}</p>}
      {localError && <p className="text-xs text-red-700">{localError}</p>}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-700 disabled:opacity-50"
      >
        {busy ? 'Wird hochgeladen…' : 'Hochladen'}
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
        placeholder="Text einfügen"
        required
        rows={4}
        // Wie bei der Dateigröße: die verbindliche Grenze steht auf dem Server,
        // diese hier erspart dem Nutzer nur, erst beim Absenden davon zu
        // erfahren. Muss zu limits.body.pastedText passen.
        maxLength={MAX_TEXT_CHARS}
        className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs focus:border-sky-500 focus:outline-none"
      />
      <p className="text-right text-[11px] text-slate-400">
        {content.length.toLocaleString('de-DE')} / {MAX_TEXT_CHARS.toLocaleString('de-DE')} Zeichen
      </p>
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-700 disabled:opacity-50"
      >
        Hinzufügen
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
        placeholder="beispiel.de oder https://beispiel.de"
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
