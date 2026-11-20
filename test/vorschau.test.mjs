import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { serialize, ObjectId, Long } from 'bson';
import { gzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { openBackup } from '../src/backup.js';
import { netzwerkPaket, vorschauUnf, bereinigeProperties } from '../src/vorschau-paket.js';
import { sha512crypt } from '../server/sha512crypt.js';
import { waehleVersion } from '../server/images.js';
import { zielKopf, antwortKopf, bannerEinsetzen } from '../server/proxy.js';
import { grenzeErreicht } from '../server/vorschau.js';
import { zielFuer } from '../server/controller.js';
import { labels, hostKonfig, pruefe } from '../server/lauf.js';
import * as unifiArt from '../server/arten/unifi.js';

function beispielPaket() {
  const site = new ObjectId(), superSite = new ObjectId(), admin = new ObjectId();
  const docs = [
    { __cmd: 'select', collection: 'site' },
    { _id: site, name: 'default', desc: 'Default' },
    { _id: superSite, name: 'super', key: 'super', attr_hidden: true },
    { __cmd: 'select', collection: 'admin' },
    { _id: admin, name: 'UniFi-OS-Konto', time_created: Long.fromNumber(1) },
    { __cmd: 'select', collection: 'privilege' },
    { _id: new ObjectId(), admin_id: admin.toHexString(), site_id: site.toHexString(), role: 'admin', permissions: [] },
    { __cmd: 'select', collection: 'networkconf' },
    { _id: new ObjectId(), site_id: site.toHexString(), name: 'LAN' },
    { __cmd: 'select', collection: 'device' },
    { _id: new ObjectId(), site_id: site.toHexString(), type: 'udm', model: 'UDMPRO', mac: 'aa:bb:cc:00:00:01' },
    { _id: new ObjectId(), site_id: site.toHexString(), type: 'usw', model: 'US24PRO', mac: 'aa:bb:cc:00:00:02' }
  ];
  const db = gzipSync(Buffer.concat(docs.map((d) => serialize(d))));
  return zipSync({
    'db.gz': db, version: strToU8('10.4.57'), format: strToU8('bson'), timestamp: strToU8('1'),
    'system.properties': strToU8('is_setup_completed=true\nucore.caps=6\nunifi.ucore.message_box.token=geheim\nuuid=x'),
    'sites/default/portalfile/logo': strToU8('PNG')
  }, { level: 0 });
}

test('sha512crypt entspricht den Referenzwerten', () => {
  assert.equal(sha512crypt('Hello world!', 'saltstring'),
    '$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1');
  assert.equal(sha512crypt('Hello world!', 'saltstringsaltstring', 10000),
    '$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.');
});

test('vorschauUnf setzt den Wegwerf-Admin auf allen Sites ein und lässt den Rest unverändert', async () => {
  const r = await vorschauUnf(beispielPaket(), { benutzer: 'fah-vorschau', shadow: '$6$x$y', jetzt: 2000 });
  assert.deepEqual(r.sites, ['default', 'super']);
  assert.equal(r.startSite, 'default');
  const b = await openBackup(new File([r.unf], 'vorschau.unf'));
  const admins = b.collections.get('admin');
  assert.deepEqual(admins.map((a) => a.name), ['UniFi-OS-Konto', 'fah-vorschau']);
  const neu = admins[1];
  assert.equal(neu.x_shadow, '$6$x$y');
  assert.equal(neu.requires_new_password, false);
  const rechte = b.collections.get('privilege').filter((p) => p.admin_id === String(neu._id));
  assert.deepEqual(rechte.map((p) => p.site_id).sort(), b.sites.map((s) => s.id).sort());
  assert.ok(rechte.every((p) => p.role === 'admin'));
  assert.equal(b.collections.get('networkconf')[0].name, 'LAN');
  assert.deepEqual(b.collections.get('device').map((d) => `${d.model}:${d.type}`), ['UDMPRO:uxg', 'US24PRO:usw']);
  assert.ok(!/ucore/.test(b.properties.text));
  assert.equal(b.properties.values.is_setup_completed, 'true');
  for (const pfad of ['sites/', 'sites/default/', 'sites/default/portalfile/', 'sites/default/portalfile/logo']) assert.ok(b.files.has(pfad), pfad);
  assert.equal(strFromU8(b.files.get('version')), '10.4.57');
});

test('vorschauUnf gleicht die Version an, wenn kein passender Controller existiert', async () => {
  const r = await vorschauUnf(beispielPaket(), { benutzer: 'v', shadow: 's', zielVersion: '10.3.58' });
  const b = await openBackup(new File([r.unf], 'vorschau.unf'));
  assert.equal(strFromU8(b.files.get('version')), '10.3.58');
});

test('vorschauUnf ergänzt Single-Site-Exporte zum vollständigen Backup', async () => {
  const site = new ObjectId();
  const db = gzipSync(Buffer.concat([
    { __cmd: 'select', collection: 'site' },
    { _id: site, name: 'abc123xy', desc: 'Kunde' },
    { __cmd: 'select', collection: 'wlanconf' },
    { _id: new ObjectId(), site_id: site.toHexString(), name: 'Gast' }
  ].map((d) => serialize(d))));
  const paket = zipSync({ 'db.gz': db, version: strToU8('9.5.21'), timestamp: strToU8('1') }, { level: 0 });
  const r = await vorschauUnf(paket, { benutzer: 'fah-vorschau', shadow: '$6$x$y' });
  assert.deepEqual(r.sites, ['abc123xy', 'super']);
  assert.equal(r.startSite, 'abc123xy');
  const b = await openBackup(new File([r.unf], 'vorschau.unf'));
  assert.equal(strFromU8(b.files.get('format')), 'bson');
  assert.equal(b.properties.values.is_default, 'false');
  assert.match(b.properties.values.uuid, /^[0-9a-f-]{36}$/);
  const superSite = b.collections.get('site').find((s) => s.name === 'super');
  assert.equal(superSite.key, 'super');
  assert.equal(superSite.attr_hidden_id, 'super');
  assert.equal(superSite.attr_hidden, true);
  const admin = b.collections.get('admin').find((a) => a.name === 'fah-vorschau');
  const rechte = b.collections.get('privilege').filter((p) => p.admin_id === String(admin._id));
  assert.deepEqual(rechte.map((p) => p.site_id).sort(), b.sites.map((s) => s.id).sort());
  assert.equal(b.collections.get('wlanconf')[0].name, 'Gast');
});

test('bereinigeProperties entfernt nur UniFi-OS-Schlüssel', () => {
  assert.equal(strFromU8(bereinigeProperties(strToU8('# kommentar\nucore.caps=6\nunifi.ucore.x=1\nunifi.https.port=8443'))), '# kommentar\nunifi.https.port=8443');
});

test('waehleVersion: genau, sonst nächsthöher, sonst neueste angeglichen', () => {
  const da = ['10.3.58', '10.4.57', '10.6.106', 'latest', '10.5.67'];
  assert.deepEqual(waehleVersion(da, '10.4.57'), { version: '10.4.57', angeglichen: false });
  assert.deepEqual(waehleVersion(da, '10.4.40'), { version: '10.4.57', angeglichen: false });
  assert.deepEqual(waehleVersion(da, '10.7.1'), { version: '10.6.106', angeglichen: true });
  assert.deepEqual(waehleVersion(da, ''), { version: '10.6.106', angeglichen: true });
  assert.equal(waehleVersion([], '10.4.57'), null);
});

test('Weiterleitung schreibt Host, Origin, Referer, Location und Cookies passend um', () => {
  const ziel = { host: 'unifi-vorschau-app-a1', port: 8443 };
  const kopf = zielKopf({
    host: 'unifi-extraktor.example.org', origin: 'https://unifi-extraktor.example.org',
    referer: 'https://unifi-extraktor.example.org/manage/default/dashboard?x=1', cookie: 'unifises=abc',
    'x-forwarded-for': '192.168.1.5', connection: 'keep-alive'
  }, ziel);
  assert.equal(kopf.host, 'unifi-vorschau-app-a1:8443');
  assert.equal(kopf.origin, 'https://unifi-vorschau-app-a1:8443');
  assert.equal(kopf.referer, 'https://unifi-vorschau-app-a1:8443/manage/default/dashboard?x=1');
  assert.equal(kopf.cookie, 'unifises=abc');
  assert.equal(kopf['x-forwarded-for'], undefined);
  assert.equal(kopf.connection, undefined);

  const antwort = antwortKopf({ location: 'https://unifi-vorschau-app-a1:8443/manage/account/login', 'set-cookie': ['unifises=n; Path=/; Secure; HttpOnly'] }, { https: false, ziel });
  assert.equal(antwort.location, '/manage/account/login');
  assert.deepEqual(antwort['set-cookie'], ['unifises=n; Path=/; HttpOnly']);
  assert.deepEqual(antwortKopf({ 'set-cookie': ['a=b; Secure'] }, { https: true, ziel })['set-cookie'], ['a=b; Secure']);
  assert.equal(antwortKopf({ location: '/manage' }, { https: true, ziel }).location, '/manage');
  // Weiterleitungen eines anderen Controllers bleiben unangetastet.
  assert.equal(antwortKopf({ location: 'https://unifi-vorschau-app-b2:8443/x' }, { https: true, ziel }).location, 'https://unifi-vorschau-app-b2:8443/x');

  assert.equal(bannerEinsetzen('<html><body></body><div></div></html>', '<b>!</b>'), '<html><body></body><div></div><b>!</b></html>');
});

test('Proxy für das eingebettete Fenster: http-Ziel, Frame-Köpfe, Schema in Origin/Referer', () => {
  const chr = { host: 'unifi-vorschau-chr-a1', port: 80, schema: 'http' };
  const antwort = antwortKopf({
    'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", location: 'http://unifi-vorschau-chr-a1:80/webfig/'
  }, { https: false, ziel: chr });
  assert.equal(antwort['x-frame-options'], undefined, 'x-frame-options wird immer gestrichen');
  assert.match(antwort['content-security-policy'], /frame-ancestors 'self'/, "frame-ancestors wird auf 'self' gesetzt (Kritik 9)");
  assert.ok(!/frame-ancestors 'none'/.test(antwort['content-security-policy']), 'alte frame-ancestors-Direktive ersetzt');
  assert.match(antwort['content-security-policy'], /default-src 'self'/, 'übrige CSP bleibt');
  assert.equal(antwort.location, '/webfig/', 'http-Location des eigenen Ziels wird relativ');
  const ohne = antwortKopf({ 'content-type': 'text/html' }, { https: true, ziel: chr });
  assert.match(ohne['content-security-policy'] || '', /frame-ancestors 'self'/, 'ohne CSP wird eine gesetzt');
  assert.equal(antwortKopf({ 'x-frame-options': 'SAMEORIGIN' }, { https: true, ziel: chr })['x-frame-options'], undefined);
  assert.equal(antwortKopf({ location: 'http://unifi-vorschau-chr-b2:80/x' }, { https: false, ziel: chr }).location, 'http://unifi-vorschau-chr-b2:80/x', 'fremdes Ziel bleibt');
  // UniFi-Ziel mit ausdrücklichem Schema verhält sich wie bisher.
  const app = { host: 'unifi-vorschau-app-a1', port: 8443, schema: 'https' };
  assert.equal(antwortKopf({ location: 'https://unifi-vorschau-app-a1:8443/manage/account/login' }, { https: false, ziel: app }).location, '/manage/account/login');
  // Anfrageköpfe folgen dem Schema des Ziels.
  const kopf = zielKopf({ host: 'unifi-extraktor.example.org', origin: 'https://unifi-extraktor.example.org', referer: 'https://unifi-extraktor.example.org/webfig/?a=1', cookie: 'fah_explorer=x' }, chr);
  assert.equal(kopf.host, 'unifi-vorschau-chr-a1:80');
  assert.equal(kopf.origin, 'http://unifi-vorschau-chr-a1:80');
  assert.equal(kopf.referer, 'http://unifi-vorschau-chr-a1:80/webfig/?a=1');
  assert.equal(kopf.cookie, undefined, 'Explorer-Cookie geht auch WebFig nichts an');
});

test('Art „unifi“ und Lauf-Helfer: feste Schnittstellen', async () => {
  assert.deepEqual(zielFuer('unifi-vorschau-app-a1'), { host: 'unifi-vorschau-app-a1', port: 8443, schema: 'https' });
  assert.equal(unifiArt.art, 'unifi');
  assert.deepEqual(unifiArt.SCHRITTE.map(([k]) => k), ['vorbereiten', 'laden', 'starten', 'einspielen', 'anmelden']);
  assert.deepEqual(unifiArt.zielFuer({ app: 'unifi-vorschau-app-a1' }), { host: 'unifi-vorschau-app-a1', port: 8443, schema: 'https' });
  assert.equal(unifiArt.istHuelle({ method: 'GET', url: '/manage/default/dashboard', headers: { accept: 'text/html,*/*' } }), true);
  assert.equal(unifiArt.istHuelle({ method: 'GET', url: '/api/self', headers: { accept: 'application/json' } }), false);
  assert.equal(unifiArt.istHuelle({ method: 'POST', url: '/manage', headers: { accept: 'text/html' } }), false);
  const html = unifiArt.banner({ name: 'kunde.unifi', controllerId: 'abc' });
  assert.ok(html.includes('kunde.unifi'));
  assert.match(html, /<a\b[^>]*href="\/"[^>]*target="_top"|<a\b[^>]*target="_top"[^>]*href="\/"/, 'Explorer-Link verlässt den Frame (target=_top)');
  const z = unifiArt.zugang({ passwort: 'Geheim-1' });
  assert.equal(z.benutzer, 'fah-vorschau');
  assert.equal(z.passwort, 'Geheim-1');
  assert.deepEqual(labels({ id: 'ab12' }, 'mikrotik'), { 'fah.unifi-vorschau': '1', 'fah.unifi-vorschau.lauf': 'ab12', 'fah.unifi-vorschau.art': 'mikrotik' });
  const hk = hostKonfig('unifi-vorschau', 1, 0.75, { Binds: ['fah-chr-cache:/cache:ro'] });
  assert.equal(hk.NetworkMode, 'unifi-vorschau');
  assert.deepEqual(hk.RestartPolicy, { Name: 'no' });
  assert.equal(hk.CpuShares, 256);
  assert.equal(hk.NanoCpus, 1e9);
  assert.equal(hk.Memory, Math.round(0.75 * 1024 ** 3));
  assert.deepEqual(hk.Binds, ['fah-chr-cache:/cache:ro']);
  assert.throws(() => pruefe({ abgebrochen: true }), (f) => f.abgebrochen === true);
  assert.doesNotThrow(() => pruefe({ abgebrochen: false }));
});

test('Obergrenze: eigene Vorschau wird ersetzt, fremde laufende zählen, fehlgeschlagene nicht', () => {
  const l = (kontoId, phase = 'bereit') => ({ kontoId, phase });
  assert.equal(grenzeErreicht([l('a'), l('b')], 'c', 3), false);
  assert.equal(grenzeErreicht([l('a'), l('b'), l('d', 'starten')], 'c', 3), true);
  assert.equal(grenzeErreicht([l('a'), l('b'), l('c')], 'c', 3), false);
  assert.equal(grenzeErreicht([l('a'), l('b'), l('d', 'fehler')], 'c', 3), false);
});

test('echtes Backup aus VORSCHAU_TESTBACKUP', { skip: !process.env.VORSCHAU_TESTBACKUP }, async () => {
  const pfad = process.env.VORSCHAU_TESTBACKUP;
  const backup = await openBackup(new File([readFileSync(pfad)], basename(pfad)));
  const r = await vorschauUnf(netzwerkPaket(backup), { benutzer: 'fah-vorschau', shadow: sha512crypt('x') });
  const b = await openBackup(new File([r.unf], 'vorschau.unf'));
  assert.ok(b.collections.get('admin').some((a) => a.name === 'fah-vorschau'));
  assert.equal(b.collections.size, backup.collections.size);
  assert.ok(!b.files.has('backup/protect/devices.key') && ![...b.files.keys()].some((k) => k.startsWith('backup/')));
});
