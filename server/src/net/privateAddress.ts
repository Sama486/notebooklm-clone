import net from 'node:net';

/**
 * Entscheidet, ob eine IP-Adresse für ausgehende Abrufe gesperrt ist.
 *
 * Reine Funktion ohne Netz und ohne Datenbank - deshalb vollständig und billig
 * testbar (privateAddress.test.ts).
 *
 * Die Sperrlisten sind mit `net.BlockList` gebaut statt mit einem selbst
 * geschriebenen CIDR-Vergleich: die Bitrechnerei für IPv6 ist genau die Sorte
 * Code, die man falsch schreibt und in der ein Fehler still bleibt.
 */

const v4 = new net.BlockList();
// "Dieses Netz"; 0.0.0.0 erreicht auf manchen Systemen localhost.
v4.addSubnet('0.0.0.0', 8, 'ipv4');
v4.addSubnet('10.0.0.0', 8, 'ipv4'); // privat
v4.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT
v4.addSubnet('127.0.0.0', 8, 'ipv4'); // Loopback - nicht nur 127.0.0.1
v4.addSubnet('169.254.0.0', 16, 'ipv4'); // Link-Local; enthält 169.254.169.254 (Cloud-Metadaten)
v4.addSubnet('172.16.0.0', 12, 'ipv4'); // privat
v4.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF-Protokollzuweisungen
v4.addSubnet('192.0.2.0', 24, 'ipv4'); // TEST-NET-1
v4.addSubnet('192.88.99.0', 24, 'ipv4'); // 6to4-Relay-Anycast
v4.addSubnet('192.168.0.0', 16, 'ipv4'); // privat
v4.addSubnet('198.18.0.0', 15, 'ipv4'); // Benchmarking
v4.addSubnet('198.51.100.0', 24, 'ipv4'); // TEST-NET-2
v4.addSubnet('203.0.113.0', 24, 'ipv4'); // TEST-NET-3
v4.addSubnet('224.0.0.0', 4, 'ipv4'); // Multicast
v4.addSubnet('240.0.0.0', 4, 'ipv4'); // reserviert, inkl. 255.255.255.255

const v6 = new net.BlockList();
v6.addAddress('::', 'ipv6'); // unspezifiziert
v6.addAddress('::1', 'ipv6'); // Loopback
v6.addSubnet('100::', 64, 'ipv6'); // Discard-Only
v6.addSubnet('2001::', 23, 'ipv6'); // IETF-Protokollzuweisungen (inkl. Teredo)
v6.addSubnet('2001:db8::', 32, 'ipv6'); // Dokumentation
v6.addSubnet('fc00::', 7, 'ipv6'); // Unique Local
v6.addSubnet('fe80::', 10, 'ipv6'); // Link-Local
v6.addSubnet('ff00::', 8, 'ipv6'); // Multicast

/**
 * Holt eine in IPv6 eingebettete IPv4-Adresse heraus.
 *
 * Ohne diesen Schritt lässt sich jede IPv4-Sperre umgehen: `::ffff:127.0.0.1`
 * ist dieselbe Maschine wie `127.0.0.1`, steht aber in keiner IPv6-Sperrliste.
 * Dasselbe gilt für NAT64 (64:ff9b::/96) und 6to4 (2002::/16).
 */
export function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();

  // IPv4-gemappt und IPv4-kompatibel: ::ffff:a.b.c.d bzw. ::a.b.c.d
  const dotted = lower.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted?.[1] && net.isIPv4(dotted[1])) return dotted[1];

  const groups = expandIpv6(lower);
  if (!groups) return null;

  // NAT64: die letzten 32 Bit sind die IPv4-Adresse.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b) {
    return fromWords(groups[6], groups[7]);
  }
  // 6to4: die IPv4-Adresse steht in den Bits 16-48.
  if (groups[0] === 0x2002) {
    return fromWords(groups[1], groups[2]);
  }
  // ::ffff:xxxx:xxxx in Hex-Schreibweise statt mit Punkten.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return fromWords(groups[6], groups[7]);
  }
  return null;
}

function fromWords(high: number | undefined, low: number | undefined): string | null {
  if (high === undefined || low === undefined) return null;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** Zerlegt eine IPv6-Adresse in acht 16-Bit-Wörter; `null`, wenn unlesbar. */
function expandIpv6(address: string): number[] | null {
  if (!net.isIPv6(address)) return null;

  // Eine angehängte Zone (fe80::1%eth0) gehört nicht zur Adresse.
  const bare = address.split('%')[0] ?? address;
  const [headPart = '', tailPart] = bare.split('::');
  const split = (part: string) => (part === '' ? [] : part.split(':'));

  const head = split(headPart);
  const tail = tailPart === undefined ? [] : split(tailPart);
  const fill = tailPart === undefined ? [] : Array(8 - head.length - tail.length).fill('0');
  const parts = [...head, ...fill, ...tail];
  if (parts.length !== 8) return null;

  const words = parts.map((p) => Number.parseInt(p, 16));
  return words.some(Number.isNaN) ? null : words;
}

/**
 * `true`, wenn die Adresse NICHT abgerufen werden darf.
 *
 * Der Standardwert ist bewusst "gesperrt": eine Adresse, die weder als IPv4
 * noch als IPv6 lesbar ist, wird abgelehnt statt durchgelassen. Der sichere Weg
 * ist der, den man bekommt, wenn man nichts weiß.
 */
export function isBlockedAddress(address: string): boolean {
  const embedded = embeddedIpv4(address);
  if (embedded) return isBlockedAddress(embedded);

  if (net.isIPv4(address)) return v4.check(address, 'ipv4');
  if (net.isIPv6(address)) return v6.check(address, 'ipv6');
  return true;
}
