import { describe, expect, it } from 'vitest';
import { embeddedIpv4, isBlockedAddress } from './privateAddress.js';

describe('Sperrliste für ausgehende Adressen', () => {
  it('sperrt Loopback in allen Schreibweisen', () => {
    // Nicht nur 127.0.0.1: das ganze /8 gehört dazu, und die Dezimalform
    // 2130706433 löst der URL-Parser ebenfalls nach 127.0.0.1 auf.
    for (const address of ['127.0.0.1', '127.1.2.3', '127.255.255.254', '::1']) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('sperrt die privaten Bereiche', () => {
    for (const address of [
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '192.168.255.255',
      '100.64.0.1', // CGNAT
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('sperrt den Cloud-Metadaten-Bereich', () => {
    // 169.254.169.254 ist bei AWS, GCP und Azure der Endpunkt, über den sich
    // Instanz-Zugangsdaten abholen lassen. Das ganze /16 ist gesperrt, nicht
    // nur diese eine Adresse.
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('169.254.0.1')).toBe(true);
    expect(isBlockedAddress('fd00:ec2::254')).toBe(true); // IPv6-Variante bei AWS
  });

  it('sperrt Multicast, reservierte und Test-Bereiche', () => {
    for (const address of [
      '0.0.0.0',
      '224.0.0.1',
      '239.255.255.255',
      '240.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '192.0.2.1',
      '203.0.113.1',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('sperrt die IPv6-Entsprechungen', () => {
    for (const address of [
      '::',
      'fe80::1', // Link-Local
      'fc00::1', // Unique Local
      'fd12:3456:789a::1',
      'ff02::1', // Multicast
      '2001:db8::1', // Dokumentation
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('sperrt IPv4-Adressen, die in IPv6 versteckt sind', () => {
    // Der häufigste Umgehungsversuch: dieselbe Maschine, andere Schreibweise.
    // Ohne das Auspacken stünde keine dieser Adressen in einer IPv6-Sperrliste.
    expect(embeddedIpv4('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(embeddedIpv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(embeddedIpv4('64:ff9b::a00:1')).toBe('10.0.0.1'); // NAT64
    expect(embeddedIpv4('2002:c0a8:1::1')).toBe('192.168.0.1'); // 6to4

    for (const address of [
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      '::ffff:7f00:1',
      '64:ff9b::a00:1',
      '2002:c0a8:1::1',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('lässt öffentliche Adressen durch', () => {
    for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
    // Eine öffentliche IPv4 in IPv6-Verpackung bleibt öffentlich.
    expect(isBlockedAddress('::ffff:1.1.1.1')).toBe(false);
  });

  it('sperrt alles, was sich nicht als Adresse lesen lässt', () => {
    // Der Standardwert ist "gesperrt", nicht "erlaubt". Was wir nicht
    // einordnen können, rufen wir nicht ab.
    for (const value of ['', 'localhost', 'nicht-eine-ip', '999.999.999.999', '0x7f000001']) {
      expect(isBlockedAddress(value), value).toBe(true);
    }
  });
});
