import { useState, type FormEvent } from 'react';
import { AnswerText, segmentsFromStoredMessage } from './AnswerText.js';
import type { Citation, Note } from '../lib/types.js';

/**
 * Die Notizen eines Notebooks.
 *
 * Notizinhalt ist Text, den ein Nutzer geschrieben oder aus einer Antwort
 * übernommen hat - er wird deshalb genauso behandelt wie Dokumenttext: als
 * React-Kind, nie als zusammengesetztes Markup. Für gespeicherte Antworten
 * wird dieselbe Darstellung verwendet wie im Chat, damit die Belege auch in
 * der Notiz anklickbar bleiben.
 */

interface NotesPanelProps {
  notes: Note[];
  onCreate: (title: string, content: string) => Promise<boolean>;
  onRename: (noteId: string, title: string) => Promise<boolean>;
  onDelete: (noteId: string) => Promise<void>;
  onCitationClick: (citation: Citation) => void;
}

export function NotesPanel({
  notes,
  onCreate,
  onRename,
  onDelete,
  onCitationClick,
}: NotesPanelProps) {
  const [titel, setTitel] = useState('');
  const [inhalt, setInhalt] = useState('');
  const [busy, setBusy] = useState(false);
  const [bearbeitet, setBearbeitet] = useState<{ id: string; titel: string } | null>(null);

  async function anlegen(event: FormEvent) {
    event.preventDefault();
    if (!titel.trim() || !inhalt.trim()) return;
    setBusy(true);
    if (await onCreate(titel.trim(), inhalt.trim())) {
      setTitel('');
      setInhalt('');
    }
    setBusy(false);
  }

  return (
    <div className="flex h-full flex-col">
      <form onSubmit={anlegen} className="space-y-2 border-b border-slate-200 p-3">
        <input
          value={titel}
          onChange={(event) => setTitel(event.target.value)}
          placeholder="Titel der Notiz"
          maxLength={200}
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs focus:border-sky-500 focus:outline-none"
        />
        <textarea
          value={inhalt}
          onChange={(event) => setInhalt(event.target.value)}
          placeholder="Notiz"
          rows={3}
          maxLength={20000}
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs focus:border-sky-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || !titel.trim() || !inhalt.trim()}
          className="w-full rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-700 disabled:opacity-50"
        >
          Notiz anlegen
        </button>
      </form>

      <ul className="flex-1 overflow-y-auto p-3">
        {notes.length === 0 ? (
          <li className="px-1 py-4 text-sm text-slate-500">
            Noch keine Notiz. Antworten aus dem Chat lassen sich über „Als Notiz speichern"
            hierher übernehmen — samt ihrer Belege.
          </li>
        ) : (
          notes.map((note) => (
            <li key={note.id} className="mb-2 rounded-lg border border-slate-200 bg-white p-3">
              <div className="flex items-start justify-between gap-2">
                {bearbeitet?.id === note.id ? (
                  <input
                    autoFocus
                    value={bearbeitet.titel}
                    onChange={(event) => setBearbeitet({ id: note.id, titel: event.target.value })}
                    onBlur={async () => {
                      const neu = bearbeitet.titel.trim();
                      if (neu && neu !== note.title) await onRename(note.id, neu);
                      setBearbeitet(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                      if (event.key === 'Escape') setBearbeitet(null);
                    }}
                    maxLength={200}
                    className="min-w-0 flex-1 rounded border border-sky-400 px-1 py-0.5 text-sm font-medium focus:outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setBearbeitet({ id: note.id, titel: note.title })}
                    title="Zum Umbenennen klicken"
                    className="min-w-0 flex-1 truncate text-left text-sm font-medium text-slate-900 hover:text-sky-700"
                  >
                    {note.title}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void onDelete(note.id)}
                  title="Notiz löschen"
                  className="shrink-0 rounded px-1.5 py-0.5 text-xs text-slate-400 transition hover:bg-red-50 hover:text-red-700"
                >
                  ✕
                </button>
              </div>

              <div className="mt-1.5 text-xs leading-relaxed text-slate-700">
                {note.citations && note.citations.length > 0 ? (
                  // Eine gespeicherte Antwort behält ihre Belege an der Stelle,
                  // an der sie standen - dieselbe Zerlegung wie beim Chatverlauf,
                  // gerechnet auf dem Server.
                  <AnswerText
                    segments={segmentsFromStoredMessage(note)}
                    citations={note.citations}
                    onCitationClick={onCitationClick}
                  />
                ) : (
                  <span className="whitespace-pre-wrap break-words">{note.content}</span>
                )}
              </div>

              <p className="mt-1.5 text-[11px] text-slate-400">
                {new Date(note.createdAt).toLocaleString('de-DE')}
              </p>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
