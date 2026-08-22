import { CitationChip } from './CitationChip.js';
import type { Citation, Message } from '../lib/types.js';

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
              <CitationChip
                key={`${index}-${marker}`}
                citation={citation}
                onOpen={onCitationClick}
              />
            );
          })}
        </span>
      ))}
    </span>
  );
}

/**
 * Liefert die Segmente einer gespeicherten Nachricht.
 *
 * Der Regelfall: der Server hat den gespeicherten Text zerlegt und schickt die
 * Segmente mit - die Chips stehen dann wieder an ihrer Stelle.
 *
 * Der Rückfall gilt für Nachrichten aus der Zeit, in der die Antwort noch ohne
 * ihre Marker gespeichert wurde. Dort ist die Position dauerhaft verloren; die
 * Chips kommen gesammelt ans Ende. Besser als sie ganz wegzulassen - der Beleg
 * gehört zur Antwort, auch wenn nicht mehr bekannt ist, zu welchem Satz.
 */
export function segmentsFromStoredMessage(
  message: Pick<Message, 'content' | 'segments' | 'citations'>,
): { text: string; markers: number[] }[] {
  // Nur verwenden, wenn dort auch Marker stecken. Bei einer Nachricht aus der
  // Zeit vor dieser Speicherweise liefert der Server zwar Segmente, aber ohne
  // Marker - dann gingen die Chips ganz verloren statt nur ihre Position.
  const hatMarker = message.segments?.some((segment) => segment.markers.length > 0);
  if (message.segments && hatMarker) return message.segments;

  return [
    { text: message.content, markers: (message.citations ?? []).map((citation) => citation.marker) },
  ];
}
