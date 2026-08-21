import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupAddress } from 'node:dns';
import { limits } from '../config.js';
import { badRequest, unprocessable } from '../http/errors.js';
import { isBlockedAddress } from './privateAddress.js';

/**
 * Abruf einer vom Nutzer angegebenen URL - die Angriffsfläche, die bei
 * RAG-Anwendungen am häufigsten offen bleibt (SSRF).
 *
 * Ohne Schutz bestimmt ein Fremder, welche Adresse unser Server aufruft, und
 * bekommt die Antwort als Dokumentinhalt zurückgeliefert. Das Ziel ist selten
 * das offene Internet, sondern das, was nur von innen erreichbar ist: Cloud-
 * Metadaten (169.254.169.254), interne Verwaltungsoberflächen, die Datenbank.
 *
 * Fünf Maßnahmen, die einzeln jeweils umgehbar wären:
 *
 * 1. Nur http und https. Andernfalls liest "file://" lokale Dateien.
 * 2. Alle aufgelösten Adressen prüfen, nicht nur die erste. Ein Angreifer
 *    kann für denselben Namen eine öffentliche UND eine private Adresse
 *    hinterlegen; wer nur die erste prüft, fällt auf die zweite herein.
 * 3. Die geprüffte IP an die Verbindung binden (siehe "lookup" weiter unten).
 * 4. Jede Weiterleitung erneut vollständig prüfen. Eine Umleitung nach innen
 *    ist der Standardtrick, weil die erste URL harmlos aussieht.
 * 5. Zeitlimit und Grössengrenze, damit ein langsamer oder endloser Server
 *    keine Verbindung und keinen Speicher dauerhaft bindet.
 */

export interface FetchedDocument {
  finalUrl: string;
  contentType: string;
  body: Buffer;
}

export async function fetchExternalUrl(rawUrl: string): Promise<FetchedDocument> {
  // Ergänzt nur die Eingabe des Nutzers, nicht die Ziele von Weiterleitungen -
  // die sind bereits vollständig aufgelöst.
  let current = parseAndCheckScheme(addMissingScheme(rawUrl));
  const deadline = Date.now() + limits.fetchUrl.timeoutMs;

  for (let hop = 0; hop <= limits.fetchUrl.maxRedirects; hop += 1) {
    const pinned = await resolveToSafeAddress(current.hostname);
    const response = await requestOnce(current, pinned, deadline);

    const location = response.headers.location;
    const status = response.statusCode ?? 0;
    const isRedirect = status >= 300 && status < 400 && typeof location === 'string';

    if (!isRedirect) {
      if (status >= 400) {
        throw unprocessable(`Die Seite antwortete mit Status ${status}.`, 'url_http_error');
      }
      return {
        finalUrl: current.toString(),
        contentType: response.headers['content-type'] ?? '',
        body: response.body,
      };
    }

    // Relative Weiterleitungen sind erlaubt und werden gegen die aktuelle URL
    // aufgelöst. Danach beginnt die Prüfung wieder von vorn - inklusive
    // Schema-Prüfung und DNS-Auflösung.
    current = parseAndCheckScheme(new URL(location, current).toString());
  }

  throw unprocessable('Zu viele Weiterleitungen.', 'too_many_redirects');
}

/**
 * Ergänzt ein fehlendes `https://`.
 *
 * Nutzer tippen "beispiel.de", nicht "https://beispiel.de". Das abzuweisen ist
 * keine Sicherheitsmaßnahme, sondern eine Fehlbedienung - geprüft wird die
 * Adresse danach genauso streng.
 *
 * Die Unterscheidung, ob vorne schon ein Schema steht, ist der heikle Teil:
 * `new URL()` liest "data:text/html,..." und "javascript:alert(1)" als Schema,
 * "beispiel.de:8080" aber ebenfalls. Deshalb die Regel: enthält der Teil vor
 * dem ersten Doppelpunkt einen Punkt, ist es ein Hostname und kein Schema.
 * Damit bleibt "data:" ein Schema (und wird abgewiesen), während
 * "beispiel.de:8080" ergänzt wird.
 */
export function addMissingScheme(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed === '') return trimmed;

  // Vollständiges Schema mit Doppelschrägstrich: unverändert lassen.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) return trimmed;

  const colon = trimmed.indexOf(':');
  const looksLikeScheme = colon > 0 && !trimmed.slice(0, colon).includes('.');
  if (looksLikeScheme) return trimmed;

  // Nur ergänzen, wenn davor überhaupt etwas steht, das ein Hostname sein
  // könnte - also ein Punkt im Adressteil. Sonst würde aus dem Vertipper
  // "keineurl" ein Abruf von "https://keineurl", der erst nach einer
  // fehlgeschlagenen Namensauflösung scheitert. "Keine gültige URL" ist die
  // ehrlichere und schnellere Antwort.
  const authority = trimmed.split(/[/?#]/)[0] ?? '';
  if (!authority.includes('.')) return trimmed;

  return `https://${trimmed}`;
}

/** Signatur, wie Node sie an `lookup` uebergibt. */
type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * Baut die `lookup`-Funktion, die immer die geprüfte Adresse zurückgibt.
 *
 * ZWEI AUFRUFFORMEN, und das Übersehen der zweiten hat die URL-Quelle
 * stillgelegt: Node ruft `lookup` je nach Situation unterschiedlich auf.
 *
 * - `options.all === false`: erwartet `callback(null, adresse, familie)`.
 * - `options.all === true`: erwartet `callback(null, [{ address, family }])`.
 *
 * Seit Node 20 ist `autoSelectFamily` (Happy Eyeballs) voreingestellt, und
 * damit fragt `net.connect` mit `all: true`. Wer nur die erste Form bedient,
 * bekommt "Invalid IP address: undefined" - der Verbindungsaufbau scheitert,
 * bevor irgendein Byte fliesst. Der Fehler sieht dabei aus wie ein
 * unerreichbarer Server, nicht wie ein Programmierfehler.
 */
export function pinnedLookup(pinned: LookupAddress) {
  return (_hostname: string, options: { all?: boolean } | undefined, callback: LookupCallback) => {
    if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  };
}

function parseAndCheckScheme(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw badRequest('Keine gültige URL.', 'invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('Nur http und https sind erlaubt.', 'unsupported_scheme');
  }
  // Zugangsdaten in der URL würden mitgeschickt; sie haben hier nichts verloren.
  if (url.username || url.password) {
    throw badRequest('URLs mit Zugangsdaten sind nicht erlaubt.', 'credentials_in_url');
  }
  return url;
}

/**
 * Löst den Hostnamen auf und gibt die Adresse zurück, die verwendet werden
 * darf - oder wirft.
 *
 * Geprüft werden ALLE zurückgegebenen A- und AAAA-Adressen. Eine einzige
 * gesperrte Adresse führt zur Ablehnung des ganzen Namens: wäre nur die
 * gewählte Adresse geprüft, könnte ein Angreifer über die Reihenfolge im
 * DNS steuern, welche wir nehmen.
 */
async function resolveToSafeAddress(hostname: string): Promise<LookupAddress> {
  let addresses: LookupAddress[];
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw unprocessable('Der Hostname ließ sich nicht auflösen.', 'dns_failed');
  }

  const first = addresses[0];
  if (!first) throw unprocessable('Der Hostname ließ sich nicht auflösen.', 'dns_failed');

  for (const entry of addresses) {
    if (isBlockedAddress(entry.address)) {
      throw badRequest(
        'Diese Adresse liegt in einem internen Netzbereich und wird nicht abgerufen.',
        'blocked_address',
      );
    }
  }
  return first;
}

interface RawResponse {
  statusCode: number | undefined;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function requestOnce(url: URL, pinned: LookupAddress, deadline: number): Promise<RawResponse> {
  const transport = url.protocol === 'https:' ? https : http;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw unprocessable('Zeitlimit überschritten.', 'url_timeout');

  return new Promise<RawResponse>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: 'GET',
        timeout: remaining,
        headers: {
          // Ehrlicher Absender statt getarnter Browser-Kennung.
          'User-Agent': 'notebooklm-clone/1.0 (+Quellenimport)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
          // Keine Kompression: die Grössengrenze soll auf den echten Bytes
          // greifen, nicht auf der komprimierten Fassung. Ein "Zip-Bomben"-
          // Dokument wäre sonst komprimiert winzig und entpackt riesig.
          'Accept-Encoding': 'identity',
        },
        /**
         * DAS ist der Kern der SSRF-Abwehr, und der Teil, den Checklisten
         * üblicherweise auslassen.
         *
         * Ohne dieses "lookup" würde der HTTP-Client den Namen ein zweites Mal
         * auflösen - nach unserer Prüfung. Zwischen "geprüft" und "verwendet"
         * liegt dann ein Zeitfenster, in dem sich die Antwort ändern kann. Ein
         * Angreifer mit sehr kurzer DNS-Lebensdauer antwortet unserer Prüfung
         * mit einer öffentlichen Adresse und dem Verbindungsaufbau eine
         * Millisekunde später mit 127.0.0.1 (DNS Rebinding).
         *
         * Hier wird stattdessen genau die Adresse verwendet, die geprüft
         * wurde. Es gibt keine zweite Auflösung, also auch kein Zeitfenster.
         *
         * Der Hostname bleibt in der URL stehen: TLS-Zertifikatsprüfung und
         * Host-Header beziehen sich weiter auf den Namen, nicht auf die IP.
         */
        lookup: pinnedLookup(pinned) as never,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let received = 0;

        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > limits.fetchUrl.maxResponseBytes) {
            // Abbrechen, statt weiter in den Speicher zu lesen. Ein Server, der
            // endlos sendet, würde den Prozess sonst umbringen.
            response.destroy();
            request.destroy();
            const mb = Math.round(limits.fetchUrl.maxResponseBytes / 1024 / 1024);
            reject(unprocessable(`Die Seite ist größer als ${mb} MB.`, 'response_too_large'));
            return;
          }
          chunks.push(chunk);
        });

        response.on('end', () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
        response.on('error', () => reject(unprocessable('Abruf fehlgeschlagen.', 'url_failed')));
      },
    );

    request.on('timeout', () => {
      request.destroy();
      reject(unprocessable('Zeitlimit überschritten.', 'url_timeout'));
    });

    request.on('error', () => {
      // Wurde die Anfrage oben schon wegen Größe oder Zeitlimit abgewiesen,
      // meldet das erzwungene destroy() hier ein zweites Mal. Die erste
      // Ablehnung gewinnt - weitere reject-Aufrufe sind wirkungslos.
      reject(unprocessable('Die Seite war nicht erreichbar.', 'url_failed'));
    });

    request.end();
  });
}
