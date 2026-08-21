import { useState } from 'react';
import type { Citation } from '../lib/types.js';

/**
 * Eine anklickbare Belegnummer mit Vorschau der zitierten Stelle.
 *
 * Die Vorschau kostet keine zusätzliche Anfrage: der Textausschnitt liegt dem
 * Beleg bereits bei (`snippet`) und wurde bisher nur nicht angezeigt.
 *
 * Der Ausschnitt stammt aus einem fremden Dokument. Er wird deshalb genauso
 * behandelt wie der Dokumenttext selbst - als Zeichenkette in einem React-Kind,
 * nie als zusammengesetztes Markup. Ein `title`-Attribut würde es auch tun, ist
 * aber auf 1-2 Zeilen beschränkt und lässt sich nicht formatieren.
 */
export function CitationChip({
  citation,
  onOpen,
}: {
  citation: Citation;
  onOpen: (citation: Citation) => void;
}) {
  const [zeigeVorschau, setZeigeVorschau] = useState(false);

  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => onOpen(citation)}
        onMouseEnter={() => setZeigeVorschau(true)}
        onMouseLeave={() => setZeigeVorschau(false)}
        // Auch per Tastatur erreichbar: wer sich durchtabbt, sieht dieselbe
        // Vorschau wie mit der Maus.
        onFocus={() => setZeigeVorschau(true)}
        onBlur={() => setZeigeVorschau(false)}
        aria-label={`Beleg ${citation.marker}: ${citation.sourceTitle}`}
        className="mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-sky-100 px-1.5 align-baseline text-xs font-semibold text-sky-800 transition hover:bg-sky-200 focus:outline-none focus:ring-2 focus:ring-sky-500"
      >
        {citation.marker}
      </button>

      {zeigeVorschau && (
        <span
          role="tooltip"
          // `pointer-events-none`: die Vorschau soll den Klick auf den Chip
          // nicht abfangen, wenn sie unter dem Mauszeiger aufgeht.
          className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 w-72 -translate-x-1/2 rounded-lg border border-slate-200 bg-white p-3 text-left shadow-lg"
        >
          <span className="block truncate text-xs font-semibold text-slate-900">
            {citation.sourceTitle}
          </span>
          {citation.page !== null && (
            <span className="block text-[11px] text-slate-500">Seite {citation.page}</span>
          )}
          <span className="mt-1.5 block whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-700">
            {citation.snippet}
          </span>
          <span className="mt-1.5 block text-[11px] text-sky-700">
            Klicken, um die Stelle im Dokument zu öffnen
          </span>
        </span>
      )}
    </span>
  );
}
