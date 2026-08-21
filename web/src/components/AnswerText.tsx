import type { Citation } from '../lib/types.js';

/**
 * Zeigt eine Modellantwort und macht aus den Zitat-Markern anklickbare Chips.
 *
 * Der Server hat die Marker bereits aus dem Text entfernt und liefert sie
 * getrennt mit. Hier werden sie an ihrer Position wieder eingesetzt - als
 * React-Elemente, nicht als zusammengebautes HTML. Die Modellausgabe wird
 * nirgends als Markup behandelt (siehe HighlightedText.tsx).
 */

interface AnswerTextProps {
  /** Textstücke und die Marker, die jeweils dahinter standen. */
  segments: { text: string; markers: number[] }[];
  citations: Citation[];
  onCitationClick: (citation: Citation) => void;
}

export function AnswerText({ segments, citations, onCitationClick }: AnswerTextProps) {
  const byMarker = new Map(citations.map((citation) => [citation.marker, citation]));

  return (
    <span className="whitespace-pre-wrap break-words">
      {segments.map((segment, index) => (
        // Der Index ist hier ein zulässiger Schlüssel: die Liste wächst nur
        // am Ende und wird nie umsortiert oder gefiltert.
        <span key={index}>
          {segment.text}
          {segment.markers.map((marker) => {
            const citation = byMarker.get(marker);
            // Ein Marker ohne passenden Beleg wird weggelassen. Das Modell kann
            // eine Nummer erfinden, die es nicht gibt - dann lieber nichts
            // anzeigen als einen Chip, der ins Leere führt.
            if (!citation) return null;

            return (
              <button
                key={`${index}-${marker}`}
                type="button"
                onClick={() => onCitationClick(citation)}
                title={`${citation.sourceTitle}${citation.page ? `, Seite ${citation.page}` : ''}`}
                className="mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-sky-100 px-1.5 align-baseline text-xs font-semibold text-sky-800 transition hover:bg-sky-200 focus:outline-none focus:ring-2 focus:ring-sky-500"
              >
                {marker}
              </button>
            );
          })}
        </span>
      ))}
    </span>
  );
}

/**
 * Baut aus gespeichertem Antworttext und Belegen wieder Segmente.
 *
 * Beim Streamen entstehen die Segmente Paket für Paket. Ein aus der Datenbank
 * geladener Verlauf hat sie nicht mehr - dort steht der fertige Text ohne
 * Marker. Die Chips kommen dann gesammelt ans Ende des Absatzes.
 */
export function segmentsFromStoredMessage(
  content: string,
  citations: Citation[] | null,
): { text: string; markers: number[] }[] {
  return [{ text: content, markers: (citations ?? []).map((citation) => citation.marker) }];
}
