import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth.js';
import { ApiError } from '../lib/api.js';

/**
 * Anmeldung und Registrierung in einer Komponente - die beiden Formulare
 * unterscheiden sich nur im aufgerufenen Endpunkt und in der Beschriftung.
 */
export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { user, login, register } = useAuth();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) {
    // Zurück dorthin, wo der Nutzer hinwollte, bevor er abgewiesen wurde.
    const target = (location.state as { from?: string } | null)?.from ?? '/notebooks';
    return <Navigate to={target} replace />;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await (mode === 'login' ? login(email, password) : register(email, password));
    } catch (caught) {
      // Nur Meldungen aus der API anzeigen; alles andere bekommt einen
      // neutralen Satz, damit nichts Internes durchsickert.
      setError(caught instanceof ApiError ? caught.message : 'Es ist ein Fehler aufgetreten.');
    } finally {
      setBusy(false);
    }
  }

  const isLogin = mode === 'login';

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold text-slate-900">Notebook-Klon</h1>
        <p className="mt-1 text-sm text-slate-600">
          Fragen an die eigenen Dokumente - mit Beleg für jede Aussage.
        </p>

        <form onSubmit={onSubmit} className="mt-8 space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-slate-700">
              E-Mail
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-slate-700">
              Passwort
            </label>
            <input
              id="password"
              type="password"
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              required
              minLength={10}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
            {!isLogin && <p className="mt-1 text-xs text-slate-500">Mindestens 10 Zeichen.</p>}
          </div>

          {error && (
            <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-2 disabled:opacity-50"
          >
            {busy ? 'Einen Moment...' : isLogin ? 'Anmelden' : 'Konto anlegen'}
          </button>
        </form>

        <p className="mt-6 text-sm text-slate-600">
          {isLogin ? 'Noch kein Konto? ' : 'Schon ein Konto? '}
          <Link
            to={isLogin ? '/register' : '/login'}
            className="font-medium text-sky-700 hover:underline"
          >
            {isLogin ? 'Registrieren' : 'Anmelden'}
          </Link>
        </p>
      </div>
    </div>
  );
}
