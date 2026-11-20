// © 2026 Fabian Hammer – FAH-Extraktor. Tests der Backend-Prüffunktionen für die MikroTik-Vorschau:
// server/arten/mikrotik.js (optionenPruefen + Art-Schnittstelle), server/mikrotik-versionen.js und
// server/tar.js. Ohne Docker, ohne Netz – die Module dürfen beim Import nichts anfassen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mikrotik from '../server/arten/mikrotik.js';
import * as versionen from '../server/mikrotik-versionen.js';
import { tarPacken } from '../server/tar.js';

const { optionenPruefen } = mikrotik;
const { versionZeileParsen, waehleChrVersion, istChrVersion } = versionen;
const te = new TextEncoder();
// Erste 4 Byte = Magic (little-endian), danach die Gesamtlänge – mehr braucht die Prüfung nicht.
const KLARTEXT = new Uint8Array([0x88, 0xac, 0xa1, 0xb1, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // 0xB1A1AC88
const AES = new Uint8Array([0xef, 0xa8, 0x91, 0x73, 76, 0, 0, 0]);                                // 0x7391A8EF
const RC4 = new Uint8Array([0xef, 0xa8, 0x91, 0x72, 44, 0, 0, 0]);                                // 0x7291A8EF
const RSC = te.encode('# 2026-10-10 10:00:00 by RouterOS 7.16.2\n/ip address\nadd address=192.168.250.1/24 interface=bridge-local\n');
const GUT = { dateiart: 'backup', chrVersion: '7.24.5', benutzer: 'admin', passwort: 'Geheim-1', zugang: { modus: 'lokal', ip: '192.168.250.1', prefix: 24 } };
const roh = (optionen) => encodeURIComponent(JSON.stringify(optionen));

// Ergebnis oder HTTP-Status des Fehlers – egal ob die Prüfung synchron oder asynchron wirft.
async function pruefung(optionen, eingabe = KLARTEXT) {
  try { return { ergebnis: await optionenPruefen(optionen === undefined ? undefined : roh(optionen), eingabe) }; }
  catch (f) { return { status: f.status, text: f.message }; }
}
const status = async (optionen, eingabe) => (await pruefung(optionen, eingabe)).status;

test('optionenPruefen: gültige Optionen mit Klartext-Magic gehen durch', async () => {
  const { ergebnis: r, text } = await pruefung(GUT);
  assert.ok(r, text);
  assert.equal(r.dateiart, 'backup');
  assert.equal(r.chrVersion, '7.24.5');
  assert.equal(r.benutzer, 'admin');
  assert.equal(r.passwort, 'Geheim-1');
  assert.deepEqual([r.zugang.modus, r.zugang.ip, r.zugang.prefix], ['lokal', '192.168.250.1', 24]);
  assert.equal(r.verschluesselt, false);
  assert.equal(r.magic, 0xB1A1AC88);
  // dateiart darf fehlen: sie folgt dem Magic.
  assert.equal((await pruefung({ ...GUT, dateiart: undefined })).ergebnis?.dateiart, 'backup');
  // WAN ohne Adresse = DHCP-Lease über den Uplink (Stufe 1 der einzige WAN-Weg).
  const { ergebnis: wan, text: t2 } = await pruefung({ ...GUT, zugang: { modus: 'wan', ip: '', prefix: null } });
  assert.ok(wan, t2);
  assert.equal(wan.zugang.modus, 'wan');
  assert.equal(wan.zugang.ip, '');
  for (const v of ['7.24', '7.25rc1', '7.26beta1']) assert.equal((await pruefung({ ...GUT, chrVersion: v })).ergebnis?.chrVersion, v, v);
});

test('optionenPruefen: Kritik-Fälle – admin+x, Zeilenumbruch, verschlüsselt, RouterOS 6 → 400', async () => {
  assert.equal(await status({ ...GUT, benutzer: 'admin+x' }), 400, 'Benutzer mit + (Konsolen-Login-Option)');
  assert.equal(await status({ ...GUT, passwort: 'ab\ncd' }), 400, 'Passwort mit Zeilenumbruch');
  assert.equal(await status({ ...GUT, passwort: 'ab\rcd' }), 400, 'Passwort mit Wagenrücklauf');
  assert.equal(await status(GUT, AES), 400, 'AES-verschlüsselt (Stufe 1 nicht virtualisierbar)');
  assert.equal(await status({ ...GUT, backupPasswort: 'x' }, AES), 400, 'verschlüsselt auch mit Backup-Passwort');
  assert.equal(await status(GUT, RC4), 400, 'RC4-verschlüsselt');
  assert.equal(await status({ ...GUT, chrVersion: '6.49.23' }), 400, 'RouterOS 6 in Stufe 1 gesperrt');
});

test('optionenPruefen: weitere ungültige Eingaben → 400', async () => {
  assert.equal(await status(undefined), 400, 'Optionen-Kopf fehlt');
  const kaputt = async (text) => { try { await optionenPruefen(text, KLARTEXT); return 'ok'; } catch (f) { return f.status; } };
  assert.equal(await kaputt('%7Bkaputt'), 400, 'kein JSON');
  assert.equal(await kaputt(encodeURIComponent('"nur ein string"')), 400, 'kein Objekt');
  assert.equal(await status({ ...GUT, chrVersion: '7.24.5; x' }), 400, 'chrVersion mit Anhang');
  assert.equal(await status({ ...GUT, chrVersion: '' }), 400, 'chrVersion leer');
  assert.equal(await status({ ...GUT, dateiart: 'xyz' }), 400, 'unbekannte dateiart');
  assert.equal(await status({ ...GUT, benutzer: '' }), 400, 'Benutzer leer');
  assert.equal(await status({ ...GUT, benutzer: 'a'.repeat(65) }), 400, 'Benutzer zu lang');
  assert.equal(await status({ ...GUT, benutzer: 'bär' }), 400, 'Benutzer mit Umlaut');
  assert.equal(await status({ ...GUT, benutzer: 'zwei worte' }), 400, 'Benutzer mit Leerzeichen');
  assert.equal(await status({ ...GUT, passwort: 'p'.repeat(129) }), 400, 'Passwort zu lang');
  assert.equal(await status({ ...GUT, passwort: 'tab\there' }), 400, 'Passwort mit Steuerzeichen');
  assert.equal(await status({ ...GUT, zugang: { modus: 'foo', ip: '', prefix: null } }), 400, 'unbekannter Zugangsweg');
  assert.equal(await status({ ...GUT, zugang: { modus: 'lokal', ip: 'abc', prefix: 24 } }), 400, 'lokal: keine IPv4');
  assert.equal(await status({ ...GUT, zugang: { modus: 'lokal', ip: '', prefix: 24 } }), 400, 'lokal: Adresse Pflicht');
  assert.equal(await status({ ...GUT, zugang: { modus: 'lokal', ip: '192.168.250.1', prefix: 31 } }), 400, 'Prefix über 30');
  assert.equal(await status({ ...GUT, zugang: { modus: 'lokal', ip: '192.168.250.1', prefix: 7 } }), 400, 'Prefix unter 8');
  assert.equal(await status({ ...GUT, zugang: { modus: 'wan', ip: 'nicht-ip', prefix: 29 } }), 400, 'wan: Adresse muss IPv4 sein');
  assert.equal(await status({ ...GUT, zugang: null }), 400, 'zugang fehlt');
  assert.equal(await status(GUT, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), 400, 'weder Backup-Magic noch Export-Text');
});

test('optionenPruefen: .rsc erzwingt admin ohne Passwort und prüft die Port-Liste', async () => {
  const { ergebnis: r, text } = await pruefung({ ...GUT, dateiart: 'rsc', benutzer: 'kunde', passwort: 'x' }, RSC);
  assert.ok(r, text);
  assert.equal(r.dateiart, 'rsc');
  assert.equal(r.benutzer, 'admin');
  assert.equal(r.passwort, '');
  assert.equal(r.verschluesselt, false);
  // dateiart aus dem Inhalt: Text, der mit '#' oder '/' beginnt, ist ein Export.
  assert.equal((await pruefung({ ...GUT, dateiart: undefined }, RSC)).ergebnis?.dateiart, 'rsc');
  assert.equal((await pruefung({ ...GUT, dateiart: undefined }, te.encode('/ip address\n'))).ergebnis?.dateiart, 'rsc');
  // Kritik 13: Port-Liste (default-name je Ethernet-Port) – Namen /^[a-z0-9-]{1,30}$/, höchstens 32.
  const ports = [{ defaultName: 'ether1' }, { defaultName: 'ether2' }, { defaultName: 'sfp-sfpplus1' }];
  const { ergebnis: mitPorts, text: t2 } = await pruefung({ ...GUT, dateiart: 'rsc', ports }, RSC);
  assert.ok(mitPorts, t2);
  assert.equal(await status({ ...GUT, dateiart: 'rsc', ports: [{ defaultName: 'Bad Name' }] }, RSC), 400, 'Portname mit Leerzeichen/Großbuchstaben');
  assert.equal(await status({ ...GUT, dateiart: 'rsc', ports: [{ defaultName: 'ether1; reboot' }] }, RSC), 400, 'Portname mit Befehlsanhang');
  assert.equal(await status({ ...GUT, dateiart: 'rsc', ports: Array.from({ length: 33 }, (_, i) => ({ defaultName: `ether${i + 1}` })) }, RSC), 400, 'höchstens 32 Ports');
});

test('Art „mikrotik“: feste Schnittstelle für vorschau.js und server.js', async () => {
  assert.equal(mikrotik.art, 'mikrotik');
  assert.deepEqual(mikrotik.SCHRITTE.map(([key]) => key), ['vorbereiten', 'laden', 'starten', 'einspielen', 'anmelden'], 'Schritt-Keys wie bei UniFi (CSS/Frontend)');
  assert.deepEqual(mikrotik.zielFuer({ app: 'unifi-vorschau-chr-ab12' }), { host: 'unifi-vorschau-chr-ab12', port: 80, schema: 'http' });
  const ziel = await mikrotik.oeffnenZiel({ phase: 'bereit', mikrotik: {} });
  assert.equal(ziel.location, '/webfig/');
  assert.ok(!ziel.cookie, 'WebFig bekommt kein Sitzungs-Cookie vom Backend');
  assert.equal(mikrotik.istHuelle({ method: 'GET', url: '/webfig/', headers: { accept: 'text/html' } }), false);
  assert.equal(mikrotik.banner, null);
  const z = mikrotik.zugang({ zugangsdaten: { benutzer: 'kunde', passwort: 'Geheim-1' } });
  assert.equal(z.benutzer, 'kunde');
  assert.equal(z.passwort, 'Geheim-1');
  assert.ok(typeof z.hinweis === 'string' && z.hinweis.length > 0);
  const lauf = { mikrotik: { benutzer: 'kunde', passwort: 'Geheim-1', identitaet: 'R1', routerosVersion: '7.24.5', chrVersion: '7.24.5', modus: 'lokal', zugangIp: '192.168.250.1', wwwPort: 80, traeger: 'bridge-local', kvm: true, hinweise: ['Scheduler angehalten'] } };
  const extra = mikrotik.statusExtra(lauf);
  assert.equal(extra.mikrotik.identitaet, 'R1');
  assert.equal(extra.mikrotik.wwwPort, 80);
  assert.deepEqual(extra.mikrotik.hinweise, ['Scheduler angehalten']);
  assert.ok(!JSON.stringify(extra).includes('Geheim-1'), 'statusExtra trägt kein Passwort (zugang() ist der einzige Weg)');
  assert.equal(typeof mikrotik.ablauf, 'function');
  assert.equal(mikrotik.logAuszug(Array.from({ length: 60 }, (_, i) => `zeile ${i}`).join('\n')).split('\n').length, 40, 'letzte 40 Zeilen (Konsole)');
});

test('versionZeileParsen: „<version> <unixzeit>“ von upgrade.mikrotik.com', () => {
  assert.deepEqual(versionZeileParsen('7.24.5 1790691687'), { version: '7.24.5', zeit: 1790691687 });
  assert.deepEqual(versionZeileParsen('7.24.5 1790691687\n'), { version: '7.24.5', zeit: 1790691687 });
  assert.equal(versionZeileParsen('7.25rc1 1790000000')?.version, '7.25rc1');
  assert.equal(versionZeileParsen(''), null);
  assert.equal(versionZeileParsen('kaputt'), null);
  assert.equal(versionZeileParsen('<html>'), null);
  if (versionen.KANAELE) assert.ok(['stable', 'long-term', 'testing'].every((k) => versionen.KANAELE.includes(k)));
});

test('waehleChrVersion: stabile Hauptversion, Mindestversion, lokale Rückfälle', () => {
  const K = [{ kanal: 'stable', version: '7.24.5', zeit: 1 }, { kanal: 'long-term', version: '7.23.8', zeit: 1 }, { kanal: 'testing', version: '7.25rc1', zeit: 1 }, { kanal: 'development', version: '7.26beta1', zeit: 1 }];
  assert.equal(waehleChrVersion(K, ['7.16.2'], '7', '7.22').vorschlag, '7.24.5');
  assert.ok(!waehleChrVersion(K, ['7.16.2'], '7', '7.22').hinweis, 'kein Hinweis, wenn stable reicht');
  assert.equal(waehleChrVersion(K, ['7.16.2'], '7', null).vorschlag, '7.24.5');
  const t = waehleChrVersion(K, [], '7', '7.25');
  assert.equal(t.vorschlag, '7.25rc1');
  assert.ok(t.hinweis, 'Hinweis, wenn testing nötig ist');
  const d = waehleChrVersion(K, [], '7', '7.26');
  assert.equal(d.vorschlag, '7.26beta1');
  assert.ok(d.hinweis);
  const zuNeu = waehleChrVersion(K, [], '7', '7.30');
  assert.equal(zuNeu.vorschlag, '7.24.5');
  assert.match(zuNeu.hinweis || '', /neuer/i, 'Backup ist neuer als die stabile Version');
  const offline = waehleChrVersion([], ['7.16.2', '6.49.23'], '7', null);
  assert.equal(offline.vorschlag, '7.16.2', 'ohne Kanäle die neueste lokale der Hauptversion');
  assert.equal(waehleChrVersion([], ['7.16.2', '7.24.5'], '7', null).vorschlag, '7.24.5');
  const nichts = waehleChrVersion([], [], '7', null);
  assert.equal(nichts.vorschlag, '7.24.5', 'bekannte Version als letzter Rückfall');
  assert.ok(nichts.hinweis);
});

test('istChrVersion: nur echte Versionsangaben', () => {
  for (const v of ['7.24.5', '7.24', '7.25rc1', '7.26beta1']) assert.equal(istChrVersion(v), true, v);
  for (const v of ['7', '7.24.5; rm', '', 'v7.24.5', '7.24.5rc', '7..1', '7.24.5\n', undefined, null]) {
    let r; try { r = istChrVersion(v); } catch { r = false; }
    assert.equal(r, false, String(v));
  }
});

test('tarPacken: ustar-Köpfe, Prüfsumme, 512er-Blöcke, Abschluss', () => {
  const klein = te.encode('{"a":1}');
  const gross = new Uint8Array(600).map((_, i) => i & 255);
  const tar = tarPacken([{ name: 'auftrag.json', daten: klein, mode: 0o600 }, { name: 'kunde.backup', daten: gross }]);
  assert.ok(tar instanceof Uint8Array, 'Buffer/Uint8Array');
  const b = Buffer.from(tar.buffer, tar.byteOffset, tar.byteLength);
  const lies = (buf, start, len) => buf.subarray(start, start + len).toString('latin1').replace(/\0[\s\S]*$/, '');
  const oktal = (buf, start, len) => parseInt(lies(buf, start, len).trim() || '0', 8);
  const summe = (kopf) => { let s = 0; for (let i = 0; i < 512; i++) s += i >= 148 && i < 156 ? 32 : kopf[i]; return s; };
  assert.equal(b.length % 512, 0, 'Vielfaches von 512');
  let offset = 0;
  for (const [name, daten, mode] of [['auftrag.json', klein, 0o600], ['kunde.backup', gross, null]]) {
    const kopf = b.subarray(offset, offset + 512);
    assert.equal(lies(kopf, 0, 100), name, 'Name an 0..99');
    if (mode !== null) assert.equal(oktal(kopf, 100, 8), mode, 'mode oktal an 100..107');
    else assert.ok(Number.isInteger(oktal(kopf, 100, 8)));
    assert.equal(oktal(kopf, 108, 8), 0, 'uid');
    assert.equal(oktal(kopf, 116, 8), 0, 'gid');
    assert.equal(oktal(kopf, 124, 12), daten.length, 'Größe oktal an 124..135');
    assert.ok(Number.isInteger(oktal(kopf, 136, 12)), 'mtime');
    assert.equal(oktal(kopf, 148, 8), summe(kopf), 'Prüfsumme (Feld als Leerzeichen gezählt)');
    assert.equal(kopf[156], 0x30, 'typeflag „0“');
    assert.equal(lies(kopf, 257, 6), 'ustar', 'magic ustar\\0');
    assert.equal(b.subarray(offset + 263, offset + 265).toString('latin1'), '00', 'version 00');
    assert.deepEqual([...b.subarray(offset + 512, offset + 512 + daten.length)], [...daten], 'Daten direkt nach dem Kopf');
    const bloecke = Math.ceil(daten.length / 512) * 512;
    assert.ok(b.subarray(offset + 512 + daten.length, offset + 512 + bloecke).every((x) => x === 0), 'Auffüllung mit Nullen');
    offset += 512 + bloecke;
  }
  assert.equal(b.length, offset + 1024, 'zwei Nullblöcke am Ende');
  assert.ok(b.subarray(offset).every((x) => x === 0));
  // Buffer als Eingabe und Standard-Modus funktionieren ebenfalls.
  const einfach = tarPacken([{ name: 'x', daten: Buffer.from('abc') }]);
  assert.equal(einfach.length, 512 + 512 + 1024);
  assert.equal(Buffer.from(einfach.buffer, einfach.byteOffset, 3 + 512).subarray(512).toString('utf8'), 'abc');
});
