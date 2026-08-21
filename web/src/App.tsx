import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './lib/auth.js';
import { AuthPage } from './pages/AuthPage.js';
import { NotebookListPage } from './pages/NotebookListPage.js';
import { NotebookPage } from './pages/NotebookPage.js';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route
        path="/notebooks"
        element={
          <RequireAuth>
            <NotebookListPage />
          </RequireAuth>
        }
      />
      <Route
        path="/notebooks/:notebookId"
        element={
          <RequireAuth>
            <NotebookPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/notebooks" replace />} />
    </Routes>
  );
}

/**
 * Schuetzt eine Route.
 *
 * Das ist Bequemlichkeit, keine Sicherheit: die eigentliche Pruefung macht der
 * Server bei jeder Anfrage. Ohne diese Huelle saehe ein abgemeldeter Nutzer
 * das Grundgeruest der Seite und danach lauter Fehlermeldungen.
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  // Solange der gespeicherte Token noch geprueft wird, ist nicht entschieden,
  // ob jemand angemeldet ist. Hier schon weiterzuleiten wuerde bei jedem
  // Neuladen kurz die Anmeldeseite aufblitzen lassen.
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-slate-500">Wird geladen...</p>
      </div>
    );
  }

  if (!user) {
    // Das Ziel mitgeben, damit es nach der Anmeldung direkt dorthin geht.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
