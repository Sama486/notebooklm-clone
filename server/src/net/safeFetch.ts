import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupAddress } from 'node:dns';
import { limits } from '../config.js';
import { badRequest, unprocessable } from '../http/errors.js';
import { isBlockedAddress } from './privateAddress.js';

/**
 * Abruf einer vom Nutzer angegebenen URL - die Angriffsflaeche, die bei
 * RAG-Anwendungen am haeufigsten offen bleibt (SSRF).
 *
 * Ohne Schutz bestimmt ein Fremder, welche Adresse unser Server aufruft, und
 * bekommt die Antwort als Dokumentinhalt zurueckgeliefert. Das Ziel ist selten
 * das offene Internet, sondern das, was nur von innen erreichbar ist: Cloud-
 * Metadaten (169.254.169.254), interne Verwaltungsoberflaechen, die Datenbank.
 *
 * Fuenf Massnahmen, die einzeln jeweils umgehbar waeren:
 *
 * 1. Nur http und https. Andernfalls liest "file://" lokale Dateien.
 * 2. Alle aufgeloesten Adressen pruefen, nicht nur die erste. Ein Angreifer
 *    kann fuer denselben Namen eine oeffentliche UND eine private Adresse
 *    hinterlegen; wer nur die erste prueft, faellt auf die zweite herein.
 * 3. Die geprueffte IP an die Verbindung binden (siehe "lookup" weiter unten).
 * 4. Jede Weiterleitung erneut vollstaendig pruefen. Eine Umleitung nach innen
 *    ist der Standardtrick, weil die erste URL harmlos aussieht.
 * 5. Zeitlimit und Groessengrenze, damit ein langsamer oder endloser Server
 *    keine Verbindung und keinen Speicher dauerhaft bindet.
 */

export interface FetchedDocument {
  finalUrl: string;
  contentType: string;
  body: Buffer;
}

export async function fetchExternalUrl(rawUrl: string): Promise<FetchedDocument> {
  let current = parseAndCheckScheme(rawUrl);
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
    // aufgeloest. Danach beginnt die Pruefung wieder von vorn - inklusive
    // Schema-Pruefung und DNS-Aufloesung.
    current = parseAndCheckScheme(new URL(location, current).toString());
  }

  throw unprocessable('Zu viele Weiterleitungen.', 'too_many_redirects');
}

function parseAndCheckScheme(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw badRequest('Keine gueltige URL.', 'invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('Nur http und https sind erlaubt.', 'unsupported_scheme');
  }
  // Zugangsdaten in der URL wuerden mitgeschickt; sie haben hier nichts verloren.
  if (url.username || url.password) {
    throw badRequest('URLs mit Zugangsdaten sind nicht erlaubt.', 'credentials_in_url');
  }
  return url;
}

/**
 * Loest den Hostnamen auf und gibt die Adresse zurueck, die verwendet werden
 * darf - oder wirft.
 *
 * Geprueft werden ALLE zurueckgegebenen A- und AAAA-Adressen. Eine einzige
 * gesperrte Adresse fuehrt zur Ablehnung des ganzen Namens: waere nur die
 * gewaehlte Adresse geprueft, koennte ein Angreifer ueber die Reihenfolge im
 * DNS steuern, welche wir nehmen.
 */
async function resolveToSafeAddress(hostname: string): Promise<LookupAddress> {
  let addresses: LookupAddress[];
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw unprocessable('Der Hostname liess sich nicht aufloesen.', 'dns_failed');
  }

  const first = addresses[0];
  if (!first) throw unprocessable('Der Hostname liess sich nicht aufloesen.', 'dns_failed');

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
  if (remaining <= 0) throw unprocessable('Zeitlimit ueberschritten.', 'url_timeout');

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
          // Keine Kompression: die Groessengrenze soll auf den echten Bytes
          // greifen, nicht auf der komprimierten Fassung. Ein "Zip-Bomben"-
          // Dokument waere sonst komprimiert winzig und entpackt riesig.
          'Accept-Encoding': 'identity',
        },
        /**
         * DAS ist der Kern der SSRF-Abwehr, und der Teil, den Checklisten
         * ueblicherweise auslassen.
         *
         * Ohne dieses "lookup" wuerde der HTTP-Client den Namen ein zweites Mal
         * aufloesen - nach unserer Pruefung. Zwischen "geprueft" und "verwendet"
         * liegt dann ein Zeitfenster, in dem sich die Antwort aendern kann. Ein
         * Angreifer mit sehr kurzer DNS-Lebensdauer antwortet unserer Pruefung
         * mit einer oeffentlichen Adresse und dem Verbindungsaufbau eine
         * Millisekunde spaeter mit 127.0.0.1 (DNS Rebinding).
         *
         * Hier wird stattdessen genau die Adresse verwendet, die geprueft
         * wurde. Es gibt keine zweite Aufloesung, also auch kein Zeitfenster.
         *
         * Der Hostname bleibt in der URL stehen: TLS-Zertifikatspruefung und
         * Host-Header beziehen sich weiter auf den Namen, nicht auf die IP.
         */
        lookup: ((
          _hostname: string,
          _options: unknown,
          callback: (err: null, address: string, family: number) => void,
        ) => {
          callback(null, pinned.address, pinned.family);
        }) as never,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let received = 0;

        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > limits.fetchUrl.maxResponseBytes) {
            // Abbrechen, statt weiter in den Speicher zu lesen. Ein Server, der
            // endlos sendet, wuerde den Prozess sonst umbringen.
            response.destroy();
            request.destroy();
            const mb = Math.round(limits.fetchUrl.maxResponseBytes / 1024 / 1024);
            reject(unprocessable(`Die Seite ist groesser als ${mb} MB.`, 'response_too_large'));
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
      reject(unprocessable('Zeitlimit ueberschritten.', 'url_timeout'));
    });

    request.on('error', () => {
      // Wurde die Anfrage oben schon wegen Groesse oder Zeitlimit abgewiesen,
      // meldet das erzwungene destroy() hier ein zweites Mal. Die erste
      // Ablehnung gewinnt - weitere reject-Aufrufe sind wirkungslos.
      reject(unprocessable('Die Seite war nicht erreichbar.', 'url_failed'));
    });

    request.end();
  });
}
