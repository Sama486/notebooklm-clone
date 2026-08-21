import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchExternalUrl } from './safeFetch.js';

/**
 * Die vier Faelle, die zaehlen, gegen einen echten lokalen HTTP-Server:
 * IP-Literal im privaten Bereich, Hostname der intern aufloest, Weiterleitung
 * nach intern, und file://.
 *
 * Ein echter Server statt eines Mocks, weil der interessante Teil der Abwehr
 * genau im Zusammenspiel von DNS-Aufloesung, Verbindungsaufbau und
 * Weiterleitungsbehandlung liegt - also in dem, was ein Mock wegabstrahiert.
 */
describe('SSRF-Abwehr beim Abruf externer URLs', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect-to-internal') {
        // Sieht harmlos aus, zeigt aber nach innen. Ohne erneute Pruefung bei
        // jeder Weiterleitung waere das der bequemste Weg an der Abwehr vorbei.
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

  it('Fall 2: ein Hostname, der intern aufloest, wird abgelehnt', async () => {
    // "localhost" ist ein Name, keine IP - die Sperre greift erst nach der
    // DNS-Aufloesung. Genau deshalb wird aufgeloest und dann geprueft, statt
    // die Zeichenkette der URL zu mustern.
    await expect(fetchExternalUrl(`http://localhost:${port}/`)).rejects.toMatchObject({
      code: 'blocked_address',
    });
  });

  it('Fall 3: eine Weiterleitung nach intern wird abgelehnt', async () => {
    // Der erste Abruf geht an einen erlaubten Host und ist erfolgreich; erst
    // das Ziel der Weiterleitung ist intern. Wer nur die Eingabe-URL prueft,
    // laesst das durch.
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

  it('lehnt kaputte URLs ab', async () => {
    await expect(fetchExternalUrl('keine-url')).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('gibt in der Fehlermeldung nichts ueber das Ziel preis', async () => {
    // Die Meldung geht an den Client. Sie darf nicht verraten, ob ein interner
    // Host existiert, antwortet oder welchen Fehler er liefert.
    const error = await fetchExternalUrl('http://192.168.13.37/admin').catch((e) => e);
    expect(error.message).not.toContain('192.168');
    expect(error.message).not.toContain('admin');
  });
});
