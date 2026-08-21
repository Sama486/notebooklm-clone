import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMissingScheme, fetchExternalUrl, pinnedLookup } from './safeFetch.js';

/**
 * Die vier Fälle, die zählen, gegen einen echten lokalen HTTP-Server:
 * IP-Literal im privaten Bereich, Hostname der intern auflöst, Weiterleitung
 * nach intern, und file://.
 *
 * Ein echter Server statt eines Mocks, weil der interessante Teil der Abwehr
 * genau im Zusammenspiel von DNS-Auflösung, Verbindungsaufbau und
 * Weiterleitungsbehandlung liegt - also in dem, was ein Mock wegabstrahiert.
 */
describe('SSRF-Abwehr beim Abruf externer URLs', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect-to-internal') {
        // Sieht harmlos aus, zeigt aber nach innen. Ohne erneute Prüfung bei
        // jeder Weiterleitung wäre das der bequemste Weg an der Abwehr vorbei.
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }
      if (req.url === '/redirect-to-loopback') {
        res.writeHead(302, { Location: 'http://127.0.0.1:1/' });
        res.end();
        return;
      }
      if (req.url === '/endless') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        // Deutlich mehr als die erlaubten 5 MB.
        const block = Buffer.alloc(256 * 1024, 0x61);
        const timer = setInterval(() => res.write(block), 1);
        res.on('close', () => clearInterval(timer));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>geheim</body></html>');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('Fall 1: IP-Literal im privaten Bereich wird abgelehnt', async () => {
    await expect(fetchExternalUrl(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({
      code: 'blocked_address',
    });
    await expect(fetchExternalUrl('http://10.0.0.1/')).rejects.toMatchObject({
      code: 'blocked_address',
    });
    await expect(fetchExternalUrl('http://169.254.169.254/latest/meta-data/')).rejects.toMatchObject(
      { code: 'blocked_address' },
    );
    await expect(fetchExternalUrl('http://[::1]/')).rejects.toMatchObject({
      code: 'blocked_address',
    });
  });

  it('Fall 2: ein Hostname, der intern auflöst, wird abgelehnt', async () => {
    // "localhost" ist ein Name, keine IP - die Sperre greift erst nach der
    // DNS-Auflösung. Genau deshalb wird aufgelöst und dann geprüft, statt
    // die Zeichenkette der URL zu mustern.
    await expect(fetchExternalUrl(`http://localhost:${port}/`)).rejects.toMatchObject({
      code: 'blocked_address',
    });
  });

  it('Fall 3: eine Weiterleitung nach intern wird abgelehnt', async () => {
    // Der erste Abruf geht an einen erlaubten Host und ist erfolgreich; erst
    // das Ziel der Weiterleitung ist intern. Wer nur die Eingabe-URL prüft,
    // lässt das durch.
    await expect(
      fetchExternalUrl(`http://127.0.0.1:${port}/redirect-to-internal`),
    ).rejects.toBeTruthy();
  });

  it('Fall 4: file:// und andere Schemata werden abgelehnt', async () => {
    for (const url of [
      'file:///etc/passwd',
      'file://C:/Windows/win.ini',
      'gopher://127.0.0.1:11211/',
      'ftp://example.com/datei.txt',
      'data:text/html,<h1>hi</h1>',
    ]) {
      await expect(fetchExternalUrl(url), url).rejects.toMatchObject({
        code: 'unsupported_scheme',
      });
    }
  });

  it('lehnt URLs mit eingebetteten Zugangsdaten ab', async () => {
    await expect(fetchExternalUrl('http://nutzer:geheim@example.com/')).rejects.toMatchObject({
      code: 'credentials_in_url',
    });
  });

  it('ergänzt ein fehlendes https:// und prüft danach genauso', async () => {
    // "beispiel.de" abzuweisen ist keine Sicherheitsmaßnahme, sondern eine
    // Fehlbedienung. Die Prüfung greift trotzdem: der Hostname löst intern auf.
    // Ohne Schema eingegeben - ergänzt wird https://, und die Adresspruefung
    // greift danach unveraendert.
    await expect(fetchExternalUrl('127.0.0.1')).rejects.toMatchObject({
      code: 'blocked_address',
    });
    await expect(fetchExternalUrl('169.254.169.254/latest/meta-data/')).rejects.toMatchObject({
      code: 'blocked_address',
    });
  });

  it('lehnt kaputte URLs ab', async () => {
    // Ohne Punkt im Adressteil wird nichts ergänzt - der Vertipper bekommt
    // sofort eine klare Antwort statt einer fehlgeschlagenen Namensauflösung.
    for (const url of ['keine-url', 'localhost', 'https://', 'http://[']) {
      await expect(fetchExternalUrl(url), url).rejects.toMatchObject({ status: 400 });
    }
  });

  it('gibt in der Fehlermeldung nichts über das Ziel preis', async () => {
    // Die Meldung geht an den Client. Sie darf nicht verraten, ob ein interner
    // Host existiert, antwortet oder welchen Fehler er liefert.
    const error = await fetchExternalUrl('http://192.168.13.37/admin').catch((e) => e);
    expect(error.message).not.toContain('192.168');
    expect(error.message).not.toContain('admin');
  });
});

describe('Ergänzen eines fehlenden Schemas', () => {
  it('ergänzt https:// bei einem blossen Hostnamen', () => {
    expect(addMissingScheme('beispiel.de')).toBe('https://beispiel.de');
    expect(addMissingScheme('beispiel.de/pfad?a=1')).toBe('https://beispiel.de/pfad?a=1');
    expect(addMissingScheme('  beispiel.de  ')).toBe('https://beispiel.de');
  });

  it('erkennt einen Hostnamen mit Port als Hostnamen', () => {
    // Der Teil vor dem Doppelpunkt enthält einen Punkt - also ein Hostname
    // und kein Schema.
    expect(addMissingScheme('beispiel.de:8080')).toBe('https://beispiel.de:8080');
  });

  it('lässt ein vorhandenes Schema unverändert', () => {
    for (const url of [
      'http://beispiel.de',
      'https://beispiel.de',
      'HTTPS://beispiel.de',
      'file:///etc/passwd',
      'ftp://beispiel.de',
    ]) {
      expect(addMissingScheme(url), url).toBe(url);
    }
  });

  it('ergänzt nichts ohne Punkt im Adressteil', () => {
    // Sonst wuerde jeder Vertipper zu einer Namensauflösung.
    expect(addMissingScheme('keine-url')).toBe('keine-url');
    expect(addMissingScheme('localhost')).toBe('localhost');
  });

  it('ergänzt nichts bei schema-artigen Eingaben ohne Punkt', () => {
    // Sonst würde aus "data:..." ein "https://data:..." und die Ablehnung
    // käme mit der falschen Begründung - oder gar nicht.
    for (const url of ['data:text/html,<h1>hi</h1>', 'javascript:alert(1)', 'gopher://x']) {
      expect(addMissingScheme(url), url).toBe(url);
    }
  });

  it('kommt mit leerer Eingabe zurecht', () => {
    expect(addMissingScheme('')).toBe('');
    expect(addMissingScheme('   ')).toBe('');
  });
});

describe('An die Verbindung gebundene Namensauflösung', () => {
  const pinned = { address: '93.184.216.34', family: 4 as const };

  it('antwortet auf die Einzelform mit Adresse und Familie', () => {
    let result: unknown[] = [];
    pinnedLookup(pinned)('example.com', { all: false }, (...args) => {
      result = args;
    });
    expect(result).toEqual([null, '93.184.216.34', 4]);
  });

  it('antwortet auf die Listenform mit einem Array', () => {
    // GENAU DIESER FALL hatte die URL-Quelle stillgelegt. Seit Node 20 ist
    // autoSelectFamily voreingestellt, also fragt net.connect mit all: true
    // und erwartet ein Array. Wer nur die Einzelform bedient, bekommt
    // "Invalid IP address: undefined" - und das sieht aus wie ein
    // unerreichbarer Server, nicht wie ein Programmierfehler.
    let result: unknown[] = [];
    pinnedLookup(pinned)('example.com', { all: true }, (...args) => {
      result = args;
    });
    expect(result).toEqual([null, [{ address: '93.184.216.34', family: 4 }]]);
  });

  it('behandelt fehlende Optionen wie die Einzelform', () => {
    let result: unknown[] = [];
    pinnedLookup(pinned)('example.com', undefined, (...args) => {
      result = args;
    });
    expect(result).toEqual([null, '93.184.216.34', 4]);
  });

  it('gibt fuer IPv6 die Familie 6 zurueck', () => {
    let result: unknown[] = [];
    pinnedLookup({ address: '2606:4700::1', family: 6 })('example.com', { all: true }, (...a) => {
      result = a;
    });
    expect(result).toEqual([null, [{ address: '2606:4700::1', family: 6 }]]);
  });
});
