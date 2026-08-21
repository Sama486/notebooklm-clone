import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { apiRequest, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import type { NotebookSummary } from '../lib/types.js';

export function NotebookListPage() {
  const { user, logout } = useAuth();
  const [notebooks, setNotebooks] = useState<NotebookSummary[] | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiRequest<{ notebooks: NotebookSummary[] }>('/api/notebooks');
      setNotebooks(data.notebooks);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Laden fehlgeschlagen.');
      setNotebooks([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createNotebook(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest('/api/notebooks', { method: 'POST', body: { title: title.trim() } });
      setTitle('');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Anlegen fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(notebook: NotebookSummary) {
    if (!confirm(`"${notebook.title}" mit allen Quellen löschen?`)) return;
    try {
      await apiRequest(`/api/notebooks/${notebook.id}`, { method: 'DELETE' });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Löschen fehlgeschlagen.');
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Meine Notebooks</h1>
          <p className="text-sm text-slate-600">{user?.email}</p>
        </div>
        <button
          type="button"
          onClick={logout}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100"
        >
          Abmelden
        </button>
      </header>

      <form onSubmit={createNotebook} className="mt-8 flex gap-2">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Titel des neün Notebooks"
          maxLength={120}
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
        />
        <button
          type="submit"
          disabled={busy || !title.trim()}
          className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-700 disabled:opacity-50"
        >
          Anlegen
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mt-8">
        {notebooks === null ? (
          <p className="text-sm text-slate-500">Wird geladen...</p>
        ) : notebooks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center">
            <p className="text-sm text-slate-600">
              Noch kein Notebook. Leg oben eines an, füge dann Quellen hinzu und stell Fragen dazu.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {notebooks.map((notebook) => (
              <li
                key={notebook.id}
                className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm"
              >
                <Link to={`/notebooks/${notebook.id}`} className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-slate-900">{notebook.title}</span>
                  <span className="text-xs text-slate-500">
                    {notebook.sourceCount === 1 ? '1 Quelle' : `${notebook.sourceCount} Quellen`} ·
                    angelegt am {new Date(notebook.createdAt).toLocaleDateString('de-DE')}
                  </span>
                </Link>
                <button
                  type="button"
                  onClick={() => void remove(notebook)}
                  className="ml-4 shrink-0 rounded-md px-2 py-1 text-sm text-slate-500 transition hover:bg-red-50 hover:text-red-700"
                >
                  Löschen
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
