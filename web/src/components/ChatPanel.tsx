import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiRequest, ApiError } from '../lib/api.js';
import { streamChat } from '../lib/chatStream.js';
import { AnswerText, segmentsFromStoredMessage } from './AnswerText.js';
import { buildChatMarkdown, dateiname, downloadMarkdown } from '../lib/exportChat.js';
import type { Citation, Message } from '../lib/types.js';

/** Eine Antwort, wie sie im Fenster steht - stückweise gewachsen oder geladen. */
interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant';
  segments: { text: string; markers: number[] }[];
  citations: Citation[];
  streaming: boolean;
  error?: string;
}

interface ChatPanelProps {
  notebookId: string;
  notebookTitle: string;
  readySourceCount: number;
  onCitationClick: (citation: Citation) => void;
  /** Speichert eine Antwort als Notiz; meldet zurück, ob es geklappt hat. */
  onSaveNote: (title: string, content: string, citations: Citation[]) => Promise<boolean>;
}

export function ChatPanel({
  notebookId,
  notebookTitle,
  readySourceCount,
  onCitationClick,
  onSaveNote,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Kurze Rückmeldung an genau einer Nachricht ("Kopiert", "Gespeichert").
  const [hinweis, setHinweis] = useState<{ id: string; text: string } | null>(null);

  function zeigeHinweis(id: string, text: string) {
    setHinweis({ id, text });
    setTimeout(() => setHinweis((aktuell) => (aktuell?.id === id ? null : aktuell)), 2000);
  }

  /** Der reine Text einer Nachricht, ohne die Chips. */
  const textVon = (message: DisplayMessage) => message.segments.map((s) => s.text).join('');

  async function kopieren(message: DisplayMessage) {
    try {
      await navigator.clipboard.writeText(textVon(message).trim());
      zeigeHinweis(message.id, 'Kopiert');
    } catch {
      // Die Zwischenablage ist ohne sicheren Kontext oder ohne Erlaubnis nicht
      // verfügbar. Kein Grund für eine Fehlermeldung - nur kein Erfolg melden.
      zeigeHinweis(message.id, 'Kopieren nicht möglich');
    }
  }

  async function alsNotizSpeichern(message: DisplayMessage) {
    const text = textVon(message).trim();
    // Die erste Zeile als Titel, gekürzt - der Nutzer kann sie danach ändern.
    const titel = (text.split('\n')[0] ?? 'Notiz').slice(0, 120) || 'Notiz';
    const erfolg = await onSaveNote(titel, text, message.citations);
    zeigeHinweis(message.id, erfolg ? 'Als Notiz gespeichert' : 'Speichern fehlgeschlagen');
  }

  function exportieren() {
    const inhalt = buildChatMarkdown(
      notebookTitle,
      messages.map((message) => ({
        role: message.role,
        text: textVon(message),
        citations: message.citations,
      })),
    );
    downloadMarkdown(inhalt, dateiname(notebookTitle));
  }

  // Verlauf laden, wenn das Notebook wechselt.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await apiRequest<{ messages: Message[] }>(
          `/api/notebooks/${notebookId}/messages`,
        );
        if (cancelled) return;
        setMessages(
          data.messages.map((message) => ({
            id: message.id,
            role: message.role,
            segments: segmentsFromStoredMessage(message.content, message.citations),
            citations: message.citations ?? [],
            streaming: false,
          })),
        );
      } catch {
        // Ein fehlender Verlauf ist kein Grund, die Seite unbenutzbar zu machen.
        if (!cancelled) setMessages([]);
      }
    }

    void load();
    return () => {
      cancelled = true;
      // Laufenden Stream beenden, wenn das Notebook gewechselt wird.
      abortRef.current?.abort();
    };
  }, [notebookId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function ask(event: FormEvent) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || streaming) return;

    setQuestion('');
    setError(null);
    setStreaming(true);

    const answerId = `antwort-${Date.now()}`;
    setMessages((current) => [
      ...current,
      {
        id: `frage-${Date.now()}`,
        role: 'user',
        segments: [{ text: trimmed, markers: [] }],
        citations: [],
        streaming: false,
      },
      { id: answerId, role: 'assistant', segments: [], citations: [], streaming: true },
    ]);

    const update = (change: (message: DisplayMessage) => DisplayMessage) =>
      setMessages((current) =>
        current.map((message) => (message.id === answerId ? change(message) : message)),
      );

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChat(
        notebookId,
        trimmed,
        {
          onCitations: (citations) => update((message) => ({ ...message, citations })),
          onSegments: (segments) =>
            update((message) => ({
              ...message,
              // Die Segmente kommen fertig geschnitten vom Server: jeder Chip
              // steht hinter genau der Aussage, die er belegt.
              segments: [...message.segments, ...segments],
            })),
          onError: (message) =>
            update((current) => ({ ...current, streaming: false, error: message })),
          onDone: (citations) =>
            update((message) => ({ ...message, citations, streaming: false })),
        },
        controller.signal,
      );
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
        setError(caught instanceof ApiError ? caught.message : 'Die Anfrage ist fehlgeschlagen.');
        update((message) => ({ ...message, streaming: false }));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  return (
    <section className="flex h-full flex-col bg-slate-50">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Chat</h2>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={exportieren}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 transition hover:bg-slate-100"
          >
            Als Markdown exportieren
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="mx-auto max-w-md rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center">
            <p className="text-sm text-slate-600">
              {readySourceCount === 0
                ? 'Füge links eine Quelle hinzu. Der Chat antwortet ausschließlich aus den Quellen dieses Notebooks.'
                : 'Stell eine Frage zu deinen Quellen. Jede Aussage bekommt eine Nummer, die zur belegenden Textstelle springt.'}
            </p>
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={`mb-4 flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm shadow-sm ${
                message.role === 'user'
                  ? 'bg-sky-600 text-white'
                  : 'border border-slate-200 bg-white text-slate-800'
              }`}
            >
              {message.role === 'user' ? (
                <span className="whitespace-pre-wrap break-words">
                  {message.segments[0]?.text ?? ''}
                </span>
              ) : (
                <>
                  <AnswerText
                    segments={message.segments}
                    citations={message.citations}
                    onCitationClick={onCitationClick}
                  />
                  {message.streaming && (
                    <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-slate-400 align-text-bottom" />
                  )}
                  {message.error && (
                    <p className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">
                      {message.error}
                    </p>
                  )}
                  {!message.streaming && !message.error && textVon(message).trim() !== '' && (
                    <div className="mt-2 flex items-center gap-2 border-t border-slate-100 pt-1.5">
                      <button
                        type="button"
                        onClick={() => void kopieren(message)}
                        className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
                      >
                        Kopieren
                      </button>
                      <button
                        type="button"
                        onClick={() => void alsNotizSpeichern(message)}
                        className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
                      >
                        Als Notiz speichern
                      </button>
                      {hinweis?.id === message.id && (
                        <span className="text-[11px] text-emerald-700">{hinweis.text}</span>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={ask} className="border-t border-slate-200 bg-white p-3">
        {error && (
          <p role="alert" className="mb-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={
              readySourceCount === 0 ? 'Erst eine Quelle hinzufügen' : 'Frage an deine Quellen'
            }
            disabled={streaming || readySourceCount === 0}
            maxLength={2000}
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 disabled:bg-slate-50"
          />
          <button
            type="submit"
            disabled={streaming || !question.trim() || readySourceCount === 0}
            className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-700 disabled:opacity-50"
          >
            {streaming ? '...' : 'Fragen'}
          </button>
        </div>
      </form>
    </section>
  );
}
