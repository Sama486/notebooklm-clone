import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { apiRequest, getToken, setToken, setUnauthorizedHandler } from './api.js';
import type { User } from './types.js';

/**
 * Anmeldezustand fuer die gesamte Oberflaeche.
 *
 * Der Token liegt im localStorage, damit ein Neuladen der Seite nicht abmeldet.
 * Beim Start wird er einmal gegen /api/auth/me geprueft: ein abgelaufener Token
 * fuehrt so sofort zur Anmeldeseite statt erst beim naechsten Klick.
 */

interface AuthState {
  user: User | null;
  /** Solange `true`, ist noch nicht entschieden, ob jemand angemeldet ist. */
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  // Jede 401-Antwort aus dem API-Modul meldet ab. Damit gibt es genau einen
  // Weg aus dem angemeldeten Zustand heraus.
  useEffect(() => {
    setUnauthorizedHandler(logout);
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      if (!getToken()) {
        setLoading(false);
        return;
      }
      try {
        const { user: me } = await apiRequest<{ user: User }>('/api/auth/me');
        if (!cancelled) setUser(me);
      } catch {
        // Token ungueltig oder Server nicht erreichbar - in beiden Faellen
        // gilt: nicht angemeldet. Die Anmeldeseite ist die sichere Variante.
        if (!cancelled) logout();
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void restoreSession();
    return () => {
      cancelled = true;
    };
  }, [logout]);

  const authenticate = useCallback(async (path: string, email: string, password: string) => {
    const result = await apiRequest<{ token: string; user: User }>(path, {
      method: 'POST',
      body: { email, password },
    });
    setToken(result.token);
    setUser(result.user);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      login: (email, password) => authenticate('/api/auth/login', email, password),
      register: (email, password) => authenticate('/api/auth/register', email, password),
      logout,
    }),
    [user, loading, authenticate, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth ausserhalb von AuthProvider verwendet');
  return context;
}
