// FAH-Extraktor · test/uebergabe.test.mjs — Urheber: Fabian Hammer © 2026
// Kundenübergabe: Aus einem Site-Export wird ein einspielbares Backup ohne Zugänge des Betreibers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { serialize, ObjectId, Double, Binary } from 'bson';
import { gzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { openBackup, encryptUnf } from '../src/backup.js';
import { istGeheim } from '../src/ansicht.js';
import { netzwerkPaket, verbleibendeGeheimnisse, UEBERGABE_OPTIONEN } from '../src/vorschau-paket.js';
import { sha512crypt } from '../server/sha512crypt.js';
import { md5crypt } from '../server/md5crypt.js';
import { optionenPruefen, uebergabeDatei } from '../server/uebergabe.js';

const ALT = ['AltesGeheim1', '$1$altmd5', '$6$altsha', 'altes-token-123', 'firma-key', 'firmenkonto'];
const PASSWORT = 'NeuesPasswort9';
const site = new ObjectId();
const siteId = site.toHexString();

function datenbank(zusatz = [], altesPasswort = 'AltesGeheim1') {
  return gzipSync(Buffer.concat([
    { __cmd: 'select', collection: 'site' },
    { _id: site, name: 'abc123xy', desc: 'Kunde' },
    { __cmd: 'select', collection: 'setting' },
    { _id: new ObjectId(), site_id: siteId, key: 'locale', timezone: 'Europe/Berlin' },
    {
      _id: new ObjectId(), site_id: siteId, key: 'mgmt', x_ssh_username: 'firmenkonto', x_ssh_password: altesPasswort,
      x_ssh_md5passwd: '$1$altmd5', x_ssh_sha512passwd: '$6$altsha', x_ssh_keys: [{ name: 'firma-key' }],
      x_api_token: 'altes-token-123', x_mgmt_key: 'bleibt32', x_ssh_enabled: true, n_double: new Double(2)
    },
    { __cmd: 'select', collection: 'device' },
    { _id: new ObjectId(), site_id: siteId, type: 'udm', model: 'UDMPRO', x_authkey: 'geraetekey' },
    { __cmd: 'select', collection: 'wlanconf' },
    { _id: new ObjectId(), site_id: siteId, name: 'Gast', x_passphrase: 'wlanbleibt' },
    { __cmd: 'select', collection: 'radiusprofile' },
    { _id: new ObjectId(), site_id: siteId, auth_servers: [{ ip: '10.0.0.1', x_secret: 'radiusbleibt' }] },
    ...zusatz
  ].map((d) => serialize(d))));
}

const angaben = (o = {}) => JSON.stringify({ benutzer: 'kunde.neu', passwort: PASSWORT, email: 'it@kunde.de', ...o });
const paket = (o = {}, dateien = {}, db = datenbank()) => zipSync({
  'db.gz': db, version: strToU8('9.5.21'), timestamp: strToU8('1'), [UEBERGABE_OPTIONEN]: strToU8(angaben(o)), ...dateien
}, { level: 0 });
const oeffnen = async (r) => openBackup(new File([r.unf], 'kunde.unf'));
const rohDb = (b) => Buffer.from(gunzipSync(b.files.get('db.gz'))).toString('latin1');
const istUebergabeFehler = (muster) => (f) => f.status === 400 && muster.test(f.message);

test('Mitschau: Das Übergabe-Passwort bleibt geheim, auch wenn es sichtbar ist', () => {
  assert.equal(istGeheim({ type: 'password', dataset: {} }), true);
  assert.equal(istGeheim({ type: 'text', dataset: { geheim: '' } }), true);
  assert.equal(istGeheim({ type: 'text', dataset: {} }), false);
  assert.equal(istGeheim({ type: 'text' }), false);
  const quelle = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(quelle, /<input id="kunde-passwort" type="password" data-geheim/);
});

test('md5crypt entspricht den Referenzwerten von openssl passwd -1', () => {
  assert.equal(md5crypt('password', 'xxxxxxxx'), '$1$xxxxxxxx$UYCIxa628.9qXjpQCjM4a.');
  assert.equal(md5crypt('Überg@be1', '3azHgidD'), '$1$3azHgidD$A0uC602kWZp/blMog/m1Q1');
  assert.match(md5crypt('zufall'), /^\$1\$[./0-9A-Za-z]{8}\$[./0-9A-Za-z]{22}$/);
});

test('Übergabe: neuer Admin auf allen Sites, keine anderen Konten', async () => {
  const r = await uebergabeDatei(paket());
  assert.deepEqual(r.sites, ['abc123xy', 'super']);
  assert.deepEqual(r.ausgelassen, []);
  const b = await oeffnen(r);
  assert.deepEqual(b.collections.get('admin').map((a) => a.name), ['kunde.neu']);
  const admin = b.collections.get('admin')[0];
  assert.equal(admin.email, 'it@kunde.de');
  assert.equal(admin.x_shadow, sha512crypt(PASSWORT, admin.x_shadow.split('$')[2]));
  const rechte = b.collections.get('privilege');
  assert.deepEqual(rechte.map((p) => p.site_id).sort(), b.sites.map((s) => s.id).sort());
  assert.ok(rechte.every((p) => p.role === 'admin' && p.admin_id === String(admin._id)));
  assert.equal(strFromU8(b.files.get('format')), 'bson');
  assert.equal(b.properties.values.is_default, 'false');
  assert.equal(strFromU8(b.files.get('version')), '9.5.21');
  assert.equal(b.files.has(UEBERGABE_OPTIONEN), false);
});

test('Übergabe: Admin-Passwort nur als Hash, Geräte-SSH bekommt ein eigenes Zufallspasswort', async () => {
  const eins = await oeffnen(await uebergabeDatei(paket()));
  const zwei = await oeffnen(await uebergabeDatei(paket()));
  const mgmt = eins.collections.get('setting').find((s) => s.key === 'mgmt');
  assert.equal(mgmt.x_ssh_username, 'kunde.neu');
  assert.notEqual(mgmt.x_ssh_password, PASSWORT);
  assert.ok(mgmt.x_ssh_password.length >= 20);
  assert.notEqual(mgmt.x_ssh_password, zwei.collections.get('setting').find((s) => s.key === 'mgmt').x_ssh_password);
  assert.equal(mgmt.x_ssh_sha512passwd, sha512crypt(mgmt.x_ssh_password, mgmt.x_ssh_sha512passwd.split('$')[2]));
  assert.equal(mgmt.x_ssh_md5passwd, md5crypt(mgmt.x_ssh_password, mgmt.x_ssh_md5passwd.split('$')[2]));
  for (const inhalt of eins.files.values()) assert.equal(Buffer.from(inhalt).includes(PASSWORT), false);
  assert.equal(rohDb(eins).includes(PASSWORT), false);
});

test('Übergabe: API-Token und SSH-Schlüssel entfernt, nichts Altes in der Datei', async () => {
  const b = await oeffnen(await uebergabeDatei(paket()));
  const mgmt = b.collections.get('setting').find((s) => s.key === 'mgmt');
  assert.deepEqual(mgmt.x_ssh_keys, []);
  assert.equal('x_api_token' in mgmt, false);
  for (const wert of ALT) assert.equal(rohDb(b).includes(wert), false, wert);
});

test('Übergabe: Site-Daten bleiben unverändert, Konsolen bleiben Konsolen', async () => {
  const b = await oeffnen(await uebergabeDatei(paket()));
  const mgmt = b.collections.get('setting').find((s) => s.key === 'mgmt');
  assert.equal(mgmt.x_mgmt_key, 'bleibt32');
  assert.equal(mgmt.x_ssh_enabled, true);
  assert.ok(rohDb(b).includes('\x01n_double\0'), 'Zahltyp bleibt erhalten');
  assert.equal(b.collections.get('setting').find((s) => s.key === 'locale').timezone, 'Europe/Berlin');
  const geraet = b.collections.get('device')[0];
  assert.equal(geraet.type, 'udm');
  assert.equal(geraet.x_authkey, 'geraetekey');
  assert.equal(b.collections.get('wlanconf')[0].x_passphrase, 'wlanbleibt');
});

test('Übergabe ohne E-Mail nutzt eine Platzhalter-Adresse', async () => {
  const b = await oeffnen(await uebergabeDatei(paket({ email: '' })));
  assert.equal(b.collections.get('admin')[0].email, 'kunde.neu@kunde.invalid');
});

test('Übergabe lehnt Komplett-Backups und fremde Konten ab', async () => {
  const fehler = istUebergabeFehler(/Site-Export/);
  await assert.rejects(uebergabeDatei(paket({}, { 'system.properties': strToU8('uuid=x') })), fehler);
  const db = (sammlung, doc) => datenbank([{ __cmd: 'select', collection: sammlung }, doc]);
  await assert.rejects(uebergabeDatei(paket({}, {}, db('admin', { _id: new ObjectId(), name: 'superadmin' }))), fehler);
  await assert.rejects(uebergabeDatei(paket({}, {}, db('privilege', { _id: new ObjectId(), admin_id: 'x', site_id: siteId }))), fehler);
  const mitSuper = gzipSync(Buffer.concat([{ __cmd: 'select', collection: 'site' }, { _id: site, name: 'a' }, { _id: new ObjectId(), name: 'super' }].map((d) => serialize(d))));
  await assert.rejects(uebergabeDatei(paket({}, {}, mitSuper)), fehler);
});

test('Übergabe lehnt mehr als eine Site ab', async () => {
  const zweiSites = gzipSync(Buffer.concat([
    { __cmd: 'select', collection: 'site' }, { _id: site, name: 'a' }, { _id: new ObjectId(), name: 'b' }
  ].map((d) => serialize(d))));
  await assert.rejects(uebergabeDatei(paket({}, {}, zweiSites)), istUebergabeFehler(/genau eine Site/));
});

test('Übergabe: unbekannte Sammlungen bleiben draußen und werden gemeldet', async () => {
  const db = datenbank([
    { __cmd: 'select', collection: 'teleport_token' }, { _id: new ObjectId(), geheim: 'TELEPORT-WERT' },
    { __cmd: 'select', collection: 'Admin' }, { _id: new ObjectId(), name: 'versteckt', x_shadow: 'HASH-WERT' },
    { __cmd: 'select' }, { _id: new ObjectId(), name: 'ohne-sammlung', x_shadow: 'NAMENLOS-WERT' }
  ]);
  const r = await uebergabeDatei(paket({}, {}, db));
  assert.deepEqual(r.ausgelassen.sort(), ['Admin', 'teleport_token', 'undefined']);
  const b = await oeffnen(r);
  for (const wert of ['TELEPORT-WERT', 'HASH-WERT', 'NAMENLOS-WERT']) assert.equal(rohDb(b).includes(wert), false, wert);
  assert.deepEqual(b.collections.get('admin').map((a) => a.name), ['kunde.neu']);
});

test('Übergabe: nur bekannte Dateien, Karten und Portaldateien der eigenen Site bleiben', async () => {
  const r = await uebergabeDatei(paket({}, {
    'sites/': new Uint8Array(0), 'sites/abc123xy/': new Uint8Array(0),
    'sites/abc123xy/map/683d': strToU8('KARTE'), 'sites/abc123xy/portalfile/logo': strToU8('LOGO'),
    'notiz.txt': strToU8('NOTIZ'), './system.properties': strToU8('uuid=fremd'), 'db_stat.gz': strToU8('STAT'),
    'sites/abc123xy/config.properties': strToU8('KONFIG'), 'sites/fremd/portalfile/x': strToU8('FREMD'),
    'sites/abc123xy/portalfile/../geheim': strToU8('RAUS')
  }));
  assert.deepEqual(r.ausgelassen.sort(), ['./system.properties', 'db_stat.gz', 'notiz.txt', 'sites/abc123xy/config.properties', 'sites/abc123xy/portalfile/../geheim', 'sites/fremd/portalfile/x']);
  const b = await oeffnen(r);
  assert.equal(strFromU8(b.files.get('sites/abc123xy/map/683d')), 'KARTE');
  assert.equal(strFromU8(b.files.get('sites/abc123xy/portalfile/logo')), 'LOGO');
  for (const pfad of ['notiz.txt', './system.properties', 'db_stat.gz', 'sites/abc123xy/config.properties', 'sites/fremd/portalfile/x']) assert.equal(b.files.has(pfad), false, pfad);
  assert.notEqual(b.properties.values.uuid, 'fremd');
});

test('Übergabe bricht ab, wenn das alte Geräte-Geheimnis noch woanders steht', async () => {
  const db = datenbank([{ __cmd: 'select', collection: 'account' }, { _id: new ObjectId(), name: 'techniker', x_password: 'AltesGeheim1' }]);
  await assert.rejects(uebergabeDatei(paket({}, {}, db)), istUebergabeFehler(/account/));
  const token = datenbank([{ __cmd: 'select', collection: 'portconf' }, { _id: new ObjectId(), name: 'altes-token-123' }]);
  await assert.rejects(uebergabeDatei(paket({}, {}, token)), istUebergabeFehler(/portconf/));
});

test('Altes Geheimnis: auch mit Umlauten, kurz und in Portaldateien, aber kein Fehlalarm durch Feldnamen', async () => {
  const fehler = istUebergabeFehler(/steht auch in/);
  const konto = (wert) => [{ __cmd: 'select', collection: 'account' }, { _id: new ObjectId(), x_password: wert }];
  await assert.rejects(uebergabeDatei(paket({}, {}, datenbank(konto('Größe§Geheim1€'), 'Größe§Geheim1€'))), fehler);
  await assert.rejects(uebergabeDatei(paket({}, {}, datenbank(konto('Kurz123'), 'Kurz123'))), fehler);
  await assert.rejects(uebergabeDatei(paket({}, { 'sites/abc123xy/portalfile/index.html': strToU8('<!-- AltesGeheim1 -->') })), (f) => f.status === 400 && /portalfile/.test(f.message));
  const r = await uebergabeDatei(paket({}, {}, datenbank([], 'password')));
  assert.equal(rohDb(await oeffnen(r)).includes('\0password\0'), false);
});

test('Übergabe: präparierte Sitenamen und andere Befehle werden abgelehnt', async () => {
  const mitName = (name) => gzipSync(Buffer.concat([{ __cmd: 'select', collection: 'site' }, { _id: site, name }].map((d) => serialize(d))));
  await assert.rejects(uebergabeDatei(paket({}, {}, mitName('..'))), istUebergabeFehler(/Name der Site/));
  await assert.rejects(uebergabeDatei(paket({}, {}, mitName('a/b'))), istUebergabeFehler(/Name der Site/));
  await assert.rejects(uebergabeDatei(paket({}, {}, mitName(['super']))), istUebergabeFehler(/Name der Site/));
  const andererBefehl = datenbank([{ __cmd: 'SELECT', collection: 'admin' }, { _id: new ObjectId(), x_shadow: 'x' }]);
  await assert.rejects(uebergabeDatei(paket({}, {}, andererBefehl)), istUebergabeFehler(/Site-Export/));
  const superEinstellung = datenbank([{ __cmd: 'select', collection: 'setting' }, { _id: new ObjectId(), key: 'super_smtp', host: 'mail.firma' }]);
  await assert.rejects(uebergabeDatei(paket({}, {}, superEinstellung)), istUebergabeFehler(/Site-Export/));
});

test('Übergabe: fremde Site-Daten, Admin-Ereignisse und Pfade mit Rückstrich bleiben draußen', async () => {
  const fremd = new ObjectId().toHexString();
  const db = datenbank([
    { __cmd: 'select', collection: 'portconf' }, { _id: new ObjectId(), site_id: fremd, name: 'FREMDER-WERT' }, { _id: new ObjectId(), site_id: siteId, name: 'Eigener' },
    { __cmd: 'select', collection: 'event' },
    { _id: new ObjectId(), site_id: siteId, key: 'EVT_AD_Login', msg: 'Admin[firmenkonto] log in' },
    { _id: new ObjectId(), site_id: siteId, key: 'EVT_X', admin: 'firmenkonto2' },
    { _id: new ObjectId(), site_id: siteId, key: 'EVT_AP_Connected', msg: 'AP online' }
  ]);
  const r = await uebergabeDatei(paket({}, { 'sites/abc123xy/portalfile/..\\..\\boese': strToU8('RAUS') }, db));
  assert.deepEqual(r.ausgelassen.sort(), ['event: Admin-Ereignisse', 'portconf: fremde Site', 'sites/abc123xy/portalfile/..\\..\\boese']);
  const b = await oeffnen(r);
  assert.deepEqual(b.collections.get('portconf').map((p) => p.name), ['Eigener']);
  assert.deepEqual(b.collections.get('event').map((e) => e.key), ['EVT_AP_Connected']);
  assert.equal(rohDb(b).includes('firmenkonto'), false);
});

test('verbleibendeGeheimnisse findet auch Felder ohne x_ und Binärwerte, aber keine öffentlichen Schlüssel', () => {
  const liste = verbleibendeGeheimnisse({ collections: new Map([
    ['setting', [{ key: 'snmp', community: 'firma' }, { key: 'locale', timezone: 'x' }]],
    ['networkconf', [{ preshared_key: 'a', private_key: 'b', public_key: 'c', ipsec_key: 'd' }]],
    ['wireguard_user', [{ wg_key: new Binary(Buffer.from('x')) }]]
  ]) });
  assert.deepEqual(liste.map((g) => g.feld), ['networkconf.ipsec_key', 'networkconf.preshared_key', 'networkconf.private_key', 'setting.snmp.community', 'wireguard_user.wg_key']);
});

test('verbleibendeGeheimnisse nennt Felder mit Anzahl, nie Werte, ohne Geräte und Ersetztes', async () => {
  const b = await oeffnen(await uebergabeDatei(paket()));
  const liste = verbleibendeGeheimnisse(b);
  assert.deepEqual(liste, [
    { feld: 'radiusprofile.auth_servers.x_secret', anzahl: 1 },
    { feld: 'wlanconf.x_passphrase', anzahl: 1 }
  ]);
  assert.equal(JSON.stringify(liste).includes('wlanbleibt'), false);
});

test('netzwerkPaket nimmt zusätzliche Einträge auf', async () => {
  const b = await openBackup(new File([await encryptUnf(paket())], 'x.unf'));
  const zip = netzwerkPaket(b, { [UEBERGABE_OPTIONEN]: strToU8(angaben({ benutzer: 'anders.neu' })) });
  const r = await uebergabeDatei(zip);
  assert.deepEqual((await oeffnen(r)).collections.get('admin').map((a) => a.name), ['anders.neu']);
});

test('optionenPruefen: klare Fehler für unbrauchbare Angaben', async () => {
  assert.deepEqual(optionenPruefen(angaben()), { benutzer: 'kunde.neu', passwort: PASSWORT, email: 'it@kunde.de' });
  for (const [falsch, muster] of [
    [{ benutzer: 'ab' }, /Benutzername/], [{ benutzer: 'mit leerzeichen' }, /Benutzername/], [{ benutzer: 'root' }, /Benutzername/],
    [{ passwort: 'kurz1A' }, /Passwort/], [{ passwort: 'nurkleinbuchstaben1' }, /Passwort/], [{ passwort: 'Mit Leerzeichen12' }, /Passwort/],
    [{ email: 'keine-adresse' }, /E-Mail/], [{ email: `a@${'.'.repeat(300)}@` }, /E-Mail/]
  ]) assert.throws(() => optionenPruefen(angaben(falsch)), istUebergabeFehler(muster), JSON.stringify(falsch));
  assert.throws(() => optionenPruefen('kein json'), (f) => f.status === 400);
  assert.throws(() => optionenPruefen(''), (f) => f.status === 400);
  await assert.rejects(uebergabeDatei(new Uint8Array([1, 2, 3])), (f) => f.status === 400);
  await assert.rejects(uebergabeDatei(zipSync({ 'db.gz': datenbank() })), (f) => f.status === 400);
});
