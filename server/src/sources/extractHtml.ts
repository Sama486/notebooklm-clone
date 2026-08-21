import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { limits } from '../config.js';
import { unprocessable } from '../http/errors.js';

/**
 * Extrahiert Titel und Fliesstext aus einer HTML-Seite.
 *
 * Kein Headless-Browser. Die API-Instanz hat 512 MB - Chrome passt da nicht
 * hinein, und der Gewinn wäre auf Seiten begrenzt, die ihren Inhalt erst per
 * JavaScript nachladen. Hier genügt der ausgelieferte HTML-Quelltext.
 */

export interface ExtractedHtml {
  title: string;
  text: string;
}

/** Enthält nur Beiwerk und würde die Suche mit Navigationstexten fluten. */
const NOISE = [
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'button',
  'template',
];

/** Wo der eigentliche Inhalt typischerweise steht, in absteigender Präzision. */
const CONTENT_SELECTORS = ['article', 'main', '[role="main"]', '#content', '.content'];

export function extractHtml(html: string, fallbackTitle: string): ExtractedHtml {
  const $ = cheerio.load(html);

  $(NOISE.join(',')).remove();
  // Kommentare können ganze verworfene Textfassungen enthalten.
  $('*')
    .contents()
    .filter((_, node) => node.type === 'comment')
    .remove();

  const title = ($('title').first().text() || $('h1').first().text() || fallbackTitle)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limits.source.titleMax);

  // `AnyNode`, weil <body> ein Document-Kind ist und die Kandidaten Elemente sind.
  let container: cheerio.Cheerio<AnyNode> = $('body');
  for (const selector of CONTENT_SELECTORS) {
    const candidate = $(selector).first();
    // Nur übernehmen, wenn wirklich Text drinsteht - manche Seiten haben ein
    // leeres <main> und den Inhalt daneben.
    if (candidate.length > 0 && candidate.text().trim().length > 200) {
      container = candidate;
      break;
    }
  }

  // Blockelemente werden zu Absätzen. Ohne das entstünde ein einziger
  // Textblock, und die Zerlegung hätte keine Absatzgrenzen zum Schneiden.
  container.find('p, div, li, tr, h1, h2, h3, h4, h5, h6, br, section').after('\n\n');

  const text = normalizeWhitespace(container.text());

  if (text.length === 0) {
    // Der häufigste Grund ist eine Seite, die ihren Inhalt erst im Browser per
    // JavaScript aufbaut. Der Hinweis gehört in die Meldung, sonst sucht der
    // Nutzer den Fehler bei sich.
    throw unprocessable(
      'Auf der Seite ließ sich kein Text finden. Seiten, die ihren Inhalt erst per JavaScript aufbauen, werden nicht unterstützt.',
      'html_no_text',
    );
  }

  return { title: title || fallbackTitle, text: text.slice(0, limits.source.extractedTextMax) };
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // Geschützte Leerzeichen sehen aus wie Leerzeichen, sind aber keine -
    // später würde die Zerlegung an ihnen keine Wortgrenze erkennen.
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Aus einer URL einen brauchbaren Anzeigetitel bauen, wenn die Seite keinen hat. */
export function titleFromUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/\/+$/, '');
    return (path ? `${url.hostname}${path}` : url.hostname).slice(0, limits.source.titleMax);
  } catch {
    return rawUrl.slice(0, limits.source.titleMax);
  }
}
