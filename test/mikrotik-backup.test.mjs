// © 2026 Fabian Hammer – FAH-Extraktor. Tests für den MikroTik-Decoder (src/mikrotik-backup.js) und
// die Hülle src/mikrotik.js. Läuft ohne DOM. Das Mini-Backup wird hier SYNTHETISCH nach der
// Formatanalyse gebaut (Kopf, Einträge, Index, M2-Felder); das echte Kunden-Backup kommt nie ins
// Repo und wird nur gelesen, wenn MIKROTIK_TESTBACKUP auf die Datei zeigt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseBackup, versionErkennen, RUBRIKEN, rubrikFuer, alsIp, alsMac, feld, MAGIC_KLARTEXT, MAGIC_RC4, MAGIC_AES } from '../src/mikrotik-backup.js';
import { mikrotikAusBytes, hexDump } from '../src/mikrotik.js';

const te = new TextEncoder();

// --- Kodierung nach SPEZIFIKATION.md (alles little-endian) ---------------------------------
const u16 = (n) => [n & 255, (n >>> 8) & 255];
const u24 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
// Feldkopf = Kennung (u24) + Typ (u8), danach der Wert je Typ.
const fString = (id, text) => { const b = [...te.encode(text)]; return [...u24(id), 0x21, b.length, ...b]; }; // 0x21: Zeichenkette, u8-Länge
const fU32 = (id, bytes) => [...u24(id), 0x08, ...bytes];                                               // 0x08: 4 Byte (IPv4 in Netzwerk-Reihenfolge)
const fRoh = (id, bytes) => [...u24(id), 0x31, bytes.length, ...bytes];                                 // 0x31: Rohbytes, u8-Länge
const fBool = (id, wert) => [...u24(id), wert ? 0x01 : 0x00];                                           // bool: Wert steckt im Typ-Bit
// Datensatz = u16-Längenpräfix (inklusive der 2 Byte) + 'M2' + Felder.
function satz(...felder) {
  const body = [0x4D, 0x32, ...felder.flat()];
  return { bytes: [...u16(body.length + 2), ...body], groesse: body.length + 2 };
}
// Eintrag = nlen + Name + ilen + Index (12 Byte je Satz: anzeige, groesse, reserviert) + dlen + Daten.
function eintrag(name, saetze) {
  const n = [...te.encode(name)];
  const index = saetze.flatMap((s, i) => [...u32(i), ...u32(s.groesse), ...u32(0)]);
  const daten = saetze.flatMap((s) => s.bytes);
  return [...u32(n.length), ...n, ...u32(index.length), ...index, ...u32(daten.length), ...daten];
}
// Kopf = Magic + Gesamtlänge, danach die Einträge bis zum Dateiende.
function backupBauen(eintraege, magic = MAGIC_KLARTEXT) {
  const koerper = eintraege.flat();
  return new Uint8Array([...u32(magic), ...u32(8 + koerper.length), ...koerper]);
}

const MAC = [0xd0, 0xea, 0x11, 0x3b, 0xa1, 0xb7];
// Zwei Adressen: die 192.168.250.x-Adresse steht bewusst an ZWEITER Stelle (Vorrang-Regel).
const ADDRS = eintrag('net/addrs', [
  satz(fU32(1, [10, 10, 0, 1]), fU32(2, [10, 10, 0, 0]), fU32(3, [255, 255, 0, 0]), fU32(4, [10, 10, 255, 255]), fString(0xFE0009, 'uplink'), fBool(0xFE000A, false)),
  satz(fU32(1, [192, 168, 250, 1]), fU32(2, [192, 168, 250, 0]), fU32(3, [255, 255, 255, 0]), fU32(4, [192, 168, 250, 255]), fString(0xFE0009, 'main-local'), fBool(0xFE000A, false))
]);
const DEVICES = eintrag('net/devices', [
  satz(fString(0x010006, 'ether1'), fString(0x010009, 'd0:ea:11:00:00:01'), fRoh(0x000404, MAC)),
  satz(fString(0x010006, 'ether2'), fRoh(0x000404, [...MAC.slice(0, 5), 0xb8]))
]);
const SYSTEM_HW = eintrag('system-hw', [satz(fString(0x000001, 'Linux 5.6.3 xhci-hcd'))]);
const REVERSE_PROXY = eintrag('reverse-proxy/rules', []); // leer – dient nur als Versionsmerkmal (≥ 7.22)
const MINI = backupBauen([ADDRS, DEVICES, SYSTEM_HW]);
const MINI_722 = backupBauen([ADDRS, DEVICES, SYSTEM_HW, REVERSE_PROXY]);
const VERSCHLUESSELT = (magic) => new Uint8Array([...u32(magic), ...u32(96), ...new Array(88).fill(7)]);
const FREMD = new Uint8Array([...u32(0x11223344), ...u32(8)]);

test('Mini-Backup: Kopf, Einträge, Index und M2-Felder werden byte-genau gelesen', () => {
  const b = parseBackup(MINI);
  assert.equal(b.verschluesselt, false);
  assert.equal(b.magic, MAGIC_KLARTEXT);
  assert.equal(b.gesamtLautKopf, MINI.length);
  assert.equal(b.endeOk, true);
  assert.deepEqual(b.eintraege.map((e) => e.name), ['net/addrs', 'net/devices', 'system-hw']);
  assert.equal(b.eintraege.flatMap((e) => e.saetze).filter((s) => s.fehler).length, 0, 'kein Satz mit Parserfehler');
  const [uplink, lokal] = b.eintraege[0].saetze;
  assert.deepEqual([uplink.anzeige, lokal.anzeige], [0, 1]);
  assert.equal(lokal.groesse, b.eintraege[0].index[1].groesse);
  assert.equal(feld(lokal, 1).typ, 0x08);
  assert.equal(alsIp(feld(lokal, 1).roh), '192.168.250.1');
  assert.equal(alsIp(feld(lokal, 3).roh), '255.255.255.0');
  assert.equal(feld(lokal, 0xFE0009).wert, 'main-local');
  assert.equal(feld(lokal, 0xFE000A).wert, false);
  const ether1 = b.eintraege[1].saetze[0];
  assert.equal(feld(ether1, 0x010006).wert, 'ether1');
  assert.equal(feld(ether1, 0x000404).typ, 0x31);
  assert.equal(alsMac(feld(ether1, 0x000404).roh), 'd0:ea:11:00:00:01');
  assert.equal(b.eintraege[2].saetze[0].felder[0].wert, 'Linux 5.6.3 xhci-hcd');
});

test('Leerer Eintrag, Rubriken-Namen und Versions-Erkennung', () => {
  const b = parseBackup(MINI_722);
  assert.equal(b.endeOk, true);
  assert.equal(b.eintraege.length, 4);
  assert.equal(b.eintraege[3].saetze.length, 0);
  assert.match(RUBRIKEN['net/addrs'], /Addresses/);
  assert.equal(rubrikFuer('net/devices'), 'Interfaces');
  assert.equal(rubrikFuer('hotspot/iface'), 'IP › Hotspot');
  assert.equal(rubrikFuer('gibt/es/nicht'), 'Sonstiges');
  assert.ok(Object.keys(RUBRIKEN).length > 300);
  const v7 = versionErkennen(parseBackup(MINI));
  assert.equal(v7.hauptversion, '7');
  assert.equal(v7.mindestversion, undefined, 'ohne Merkmals-Einträge keine Mindestversion');
  const v722 = versionErkennen(b);
  assert.equal(v722.hauptversion, '7');
  assert.match(v722.mindestversion, /≥\s*7\.22/);
  assert.ok(v722.hinweise.some((h) => /Reverse Proxy/.test(h)));
});

test('Verschlüsselte und unbekannte Dateien werden erkannt statt geparst', () => {
  for (const magic of [MAGIC_RC4, MAGIC_AES]) {
    const b = parseBackup(VERSCHLUESSELT(magic));
    assert.equal(b.verschluesselt, true);
    assert.equal(b.magic, magic);
    assert.deepEqual(b.eintraege, []);
    assert.match(b.hinweis, /verschlüsselt/);
    assert.equal(versionErkennen(b).hauptversion, 'unbekannt');
  }
  const fremd = parseBackup(FREMD);
  assert.equal(fremd.verschluesselt, false);
  assert.deepEqual(fremd.eintraege, []);
  assert.match(fremd.hinweis, /unbekannt/i);
});

test('mikrotikAusBytes (.backup): Rubriken, Datensätze, Felder, Adressen, Zugangsvorschlag', () => {
  const m = mikrotikAusBytes('k.backup', MINI);
  assert.equal(m.name, 'k.backup');
  assert.equal(m.size, MINI.length);
  assert.equal(m.art, 'mikrotik');
  assert.equal(m.dateiart, 'backup');
  assert.equal(m.type, 'RouterOS-Backup (.backup)');
  assert.equal(m.verschluesselt, false);
  assert.equal(m.magic, MAGIC_KLARTEXT);
  assert.ok(m.files instanceof Map && m.files.get('k.backup') instanceof Uint8Array, 'files-Map wie bei UniFi');
  assert.equal(m.roh.length, MINI.length);
  assert.equal(m.version.hauptversion, '7');
  assert.equal(m.version.mindestens, null);
  assert.equal(m.version.genau, null);
  assert.match(m.version.anzeige, /RouterOS 7/);
  assert.ok(Array.isArray(m.version.hinweise));
  assert.equal(m.identitaet, null, 'ohne Eintrag „system“ keine Identität');
  assert.equal(m.rubriken.length, 3);
  const pfade = m.rubriken.map((r) => r.pfad);
  assert.deepEqual(pfade, [...pfade].sort((a, b) => a.localeCompare(b)), 'nach Pfad sortiert');
  const addrs = m.rubriken.find((r) => r.schluessel === 'net/addrs');
  assert.equal(addrs.pfad, RUBRIKEN['net/addrs']);
  assert.equal(addrs.saetze.length, 2);
  const [uplink, lokal] = addrs.saetze;
  assert.equal(uplink.nr, 1, 'Datensatz-Nummern beginnen bei 1 (Anzeige „Datensatz 1“)');
  assert.equal(uplink.titel, '10.10.0.1/16 · uplink', 'Adressen: IP/Präfix vorn, Name dahinter');
  assert.equal(lokal.titel, '192.168.250.1/24 · main-local', 'Name aus Feld 0xFE0009');
  const ip = lokal.felder.find((f) => f.id === 1);
  assert.equal(ip.idHex, '0x000001');
  assert.equal(ip.typ, 0x08);
  assert.equal(ip.typName, 'ganzzahl');
  assert.equal(ip.anzeige, '192.168.250.1', 'IPv4-Felder in net/addrs werden als Adresse gezeigt');
  assert.ok(ip.roh instanceof Uint8Array && ip.roh.length === 4);
  const name = lokal.felder.find((f) => f.id === 0xFE0009);
  assert.equal(name.idHex, '0xfe0009');
  assert.equal(name.typName, 'string');
  assert.equal(name.anzeige, 'main-local');
  assert.equal(lokal.felder.find((f) => f.id === 0xFE000A).typName, 'bool');
  assert.ok(lokal.roh instanceof Uint8Array && lokal.roh.length > 0, 'Rohbytes je Satz für die Hex-Ansicht');
  assert.ok(lokal.text.includes('192.168.250.1') && lokal.text.includes('main-local'), 'Volltext aus Titel und Anzeigewerten');
  assert.equal(lokal.text, lokal.text.toLowerCase(), 'Volltext in Kleinbuchstaben');
  const devices = m.rubriken.find((r) => r.schluessel === 'net/devices');
  assert.equal(devices.saetze[0].titel, 'ether1', 'ohne 0xFE0009 zählt das erste String-Feld');
  const mac = devices.saetze[0].felder.find((f) => f.id === 0x000404);
  assert.equal(mac.typName, 'rohbytes');
  assert.equal(mac.anzeige, 'd0:ea:11:00:00:01', '6 Rohbytes werden als MAC gezeigt');
  assert.deepEqual(m.adressen.map((a) => [a.adresse, a.prefix, a.name, a.schnittstelle]),
    [['10.10.0.1', 16, 'uplink', null], ['192.168.250.1', 24, 'main-local', null]]);
  assert.deepEqual([m.zugangVorschlag.modus, m.zugangVorschlag.ip, m.zugangVorschlag.prefix], ['lokal', '192.168.250.1', 24], '192.168.250.x hat Vorrang vor der ersten Adresse');
  assert.ok(Array.isArray(m.bridges));
  // Mindestversion aus den Store-Namen (Kritik 19: aus „7.x (≥ 7.22)“ wird „7.22“)
  const m722 = mikrotikAusBytes('k.backup', MINI_722);
  assert.equal(m722.version.mindestens, '7.22');
  assert.equal(m722.version.anzeige, 'RouterOS 7 (mindestens 7.22)');
  assert.ok(m722.rubriken.length >= 3);
});

test('mikrotikAusBytes: verschlüsseltes oder fremdes .backup liefert keine Rubriken, aber eine klare Anzeige', () => {
  const m = mikrotikAusBytes('geheim.backup', VERSCHLUESSELT(MAGIC_AES));
  assert.equal(m.verschluesselt, true);
  assert.equal(m.magic, MAGIC_AES);
  assert.deepEqual(m.rubriken, []);
  assert.deepEqual(m.adressen, []);
  assert.equal(m.zugangVorschlag, null);
  assert.match(m.version.anzeige, /verschlüsselt/);
  const fremd = mikrotikAusBytes('x.backup', FREMD);
  assert.equal(fremd.verschluesselt, false);
  assert.deepEqual(fremd.rubriken, []);
  assert.ok(typeof fremd.version.anzeige === 'string' && fremd.version.anzeige.length > 0);
});

const RSC = '# 2026-10-10 10:00:00 by RouterOS 7.16.2\n# software id = ABCD-1234\n#\n/interface bridge\nadd name=bridge-local\n'
  + '/ip address\nadd address=192.168.250.1/24 interface=bridge-local comment="main local"\nadd address=10.0.0.1/24 interface=ether1\n'
  + '/ip dhcp-client\nadd interface=ether1\n/system identity\nset name=Test\n';
// Pfade wie „/ip address“, „ip address“ oder „IP › Address“ gleich behandeln.
const norm = (t) => String(t || '').toLowerCase().replace(/[›/]/g, ' ').replace(/\s+/g, ' ').trim();
const rubrik = (m, suche) => m.rubriken.find((r) => norm(r.schluessel).includes(suche) || norm(r.pfad).includes(suche));

test('mikrotikAusBytes (.rsc): Version, Abschnitte, Felder, Adressen, Bridges, WAN, Identität', () => {
  const m = mikrotikAusBytes('k.rsc', te.encode(RSC));
  assert.equal(m.dateiart, 'rsc');
  assert.equal(m.type, 'RouterOS-Export (.rsc)');
  assert.equal(m.art, 'mikrotik');
  assert.equal(m.verschluesselt, false);
  assert.equal(m.version.genau, '7.16.2');
  assert.equal(m.version.hauptversion, '7');
  assert.equal(m.version.anzeige, 'RouterOS 7.16.2');
  assert.equal(m.identitaet, 'Test');
  assert.deepEqual(m.bridges, ['bridge-local']);
  assert.deepEqual(m.adressen.map((a) => [a.adresse, a.prefix, a.schnittstelle]), [['192.168.250.1', 24, 'bridge-local'], ['10.0.0.1', 24, 'ether1']]);
  assert.equal(m.adressen[0].name, 'main local', 'Kommentar wird zum Namen der Adresse');
  assert.equal(m.wan?.schnittstelle, 'ether1', 'WAN aus /ip dhcp-client');
  assert.deepEqual([m.zugangVorschlag.modus, m.zugangVorschlag.ip, m.zugangVorschlag.prefix], ['lokal', '192.168.250.1', 24]);
  const addr = rubrik(m, 'ip address');
  assert.ok(addr, 'Rubrik für /ip address');
  assert.equal(addr.saetze.length, 2);
  const s = addr.saetze[0];
  const wert = (n) => s.felder.find((f) => f.name === n)?.anzeige;
  assert.equal(wert('address'), '192.168.250.1/24');
  assert.equal(wert('interface'), 'bridge-local');
  assert.equal(wert('comment'), 'main local', 'Anführungszeichen werden beachtet');
  assert.ok(s.roh instanceof Uint8Array && s.roh.length > 0, 'Zeilenbytes als Rohdaten');
  assert.ok(s.text.includes('192.168.250.1'));
  assert.ok(rubrik(m, 'system identity'), 'Rubrik für /system identity');
  // Fortsetzungszeilen mit abschließendem Backslash werden zusammengezogen.
  const m2 = mikrotikAusBytes('f.rsc', te.encode('# by RouterOS 7.16.2\n/ip firewall filter\nadd action=accept chain=input \\\n    comment="zwei zeilen" protocol=icmp\n'));
  const fw = rubrik(m2, 'firewall');
  assert.ok(fw, 'Rubrik für /ip firewall filter');
  assert.equal(fw.saetze.length, 1);
  assert.equal(fw.saetze[0].felder.find((f) => f.name === 'comment')?.anzeige, 'zwei zeilen');
  assert.equal(fw.saetze[0].felder.find((f) => f.name === 'protocol')?.anzeige, 'icmp');
  // Ohne Versionszeile: keine genaue Version, Identität trotzdem lesbar.
  const m3 = mikrotikAusBytes('o.rsc', te.encode('/system identity\nset name=X\n'));
  assert.equal(m3.version.genau, null);
  assert.equal(m3.identitaet, 'X');
});

test('hexDump: Offset, Hex-Spalten, ASCII und Begrenzung', () => {
  const dump = hexDump(new Uint8Array([0x41, 0x42, 0x00, 0xff]));
  const zeile = dump.split('\n')[0];
  assert.ok(zeile.startsWith('00000000'), zeile);
  assert.ok(zeile.includes('41 42 00 ff'), zeile);
  assert.ok(zeile.includes('AB..'), zeile);
  const zeilen = (text) => text.split('\n').filter((z) => /^[0-9a-f]{8}/.test(z));
  assert.equal(zeilen(hexDump(new Uint8Array(40))).length, 3, '16 Byte je Zeile');
  assert.ok(hexDump(new Uint8Array(40)).includes('00000010') && hexDump(new Uint8Array(40)).includes('00000020'));
  assert.equal(zeilen(hexDump(new Uint8Array(100), 16)).length, 1, 'maxBytes begrenzt die Ausgabe');
});

test('echtes Backup aus MIKROTIK_TESTBACKUP', { skip: !process.env.MIKROTIK_TESTBACKUP }, () => {
  const bytes = new Uint8Array(readFileSync(process.env.MIKROTIK_TESTBACKUP));
  const b = parseBackup(bytes);
  assert.equal(b.verschluesselt, false);
  assert.equal(b.endeOk, true);
  assert.ok(b.eintraege.length >= 300, `${b.eintraege.length} Einträge`);
  const saetze = b.eintraege.flatMap((e) => e.saetze);
  assert.ok(saetze.length >= 300, `${saetze.length} Datensätze`);
  assert.equal(saetze.filter((s) => s.fehler).length, 0, 'kein Satz mit Parserfehler');
  assert.equal(versionErkennen(b).hauptversion, '7');
  const m = mikrotikAusBytes('kunde.backup', bytes);
  assert.equal(m.version.hauptversion, '7');
  assert.ok(m.rubriken.length > 100, `${m.rubriken.length} Rubriken (Baumansicht erwartet > 100)`);
  assert.equal(m.rubriken.reduce((n, r) => n + r.saetze.length, 0), saetze.length, 'alle Datensätze in Rubriken');
  assert.ok(m.adressen.some((a) => a.adresse.startsWith('192.168.250.')), 'Adresse im Vorschau-Netz vorhanden');
  assert.ok(m.zugangVorschlag?.ip?.startsWith('192.168.250.'), 'Zugangsvorschlag im Vorschau-Netz');
  assert.ok(m.rubriken.some((r) => r.saetze.some((s) => s.text.includes('192.168.250'))), 'Volltextsuche findet die Adresse');
});
