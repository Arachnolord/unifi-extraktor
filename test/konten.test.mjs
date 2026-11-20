import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kontenLaden, passwortHash, passwortPruefen } from '../server/konten.js';
import { einstellungenLaden } from '../server/einstellungen.js';
import { zielKopf } from '../server/proxy.js';

// Niedrige scrypt-Kosten, damit die Tests den Rechner kaum belasten.
const N = 1024;

async function mitKonten(prüfung) {
  const ordner = await mkdtemp(join(tmpdir(), 'konten-'));
  let zeit = Date.UTC(2026, 9, 8, 20);
  const uhr = { jetzt: () => zeit, vor: (ms) => { zeit += ms; } };
  try { await prüfung({ ordner, uhr, laden: () => kontenLaden(ordner, { n: N, jetzt: uhr.jetzt }) }); }
  finally { await rm(ordner, { recursive: true, force: true }); }
}

const status = async (versprechen) => { try { await versprechen; return 'ok'; } catch (f) { return f.status; } };

test('Passwort-Hash: scrypt, prüfbar, ohne Klartext', async () => {
  const hash = await passwortHash('geheim123');
  assert.match(hash, /^scrypt\$32768\$/);
  assert.ok(!hash.includes('geheim123'));
  assert.equal(await passwortPruefen('geheim123', hash), true);
  assert.equal(await passwortPruefen('geheim124', hash), false);
  assert.equal(await passwortPruefen('x', 'kaputt'), false);
});

test('Erststart legt admin/admin an, Anmeldung und Sitzung überstehen einen Neustart', () => mitKonten(async ({ ordner, laden }) => {
  const konten = await laden();
  const [admin] = konten.liste();
  assert.equal(admin.name, 'admin');
  assert.equal(admin.rolle, 'admin');
  assert.equal(admin.standardPasswort, true);
  assert.ok(!(await readFile(join(ordner, 'benutzer.json'), 'utf8')).includes('"admin":"admin"'));

  assert.equal(await status(konten.anmelden('admin', 'falsch', '10.0.0.1')), 401);
  assert.equal(await status(konten.anmelden('niemand', 'admin', '10.0.0.1')), 401);
  const { token, benutzer } = await konten.anmelden('ADMIN', 'admin', '10.0.0.1');
  assert.equal(benutzer.name, 'admin');
  assert.equal(konten.sitzung(token).benutzer.id, admin.id);
  assert.equal(konten.sitzung('erfunden'), null);
  await konten.fertig();

  const neu = await laden();
  assert.equal(neu.liste().length, 1);
  assert.equal(neu.sitzung(token)?.benutzer.name, 'admin');
  neu.abmelden(token);
  assert.equal(neu.sitzung(token), null);
  await neu.fertig();
}));

test('Sitzung läuft 30 Tage nach der letzten Nutzung ab', () => mitKonten(async ({ uhr, laden }) => {
  const konten = await laden();
  const { token } = await konten.anmelden('admin', 'admin');
  uhr.vor(29 * 86400e3);
  assert.ok(konten.sitzung(token), 'nach 29 Tagen noch gültig und dabei verlängert');
  uhr.vor(29 * 86400e3);
  assert.ok(konten.sitzung(token), 'Nutzung hat sie verlängert');
  uhr.vor(31 * 86400e3);
  assert.equal(konten.sitzung(token), null);
  await konten.fertig();
}));

test('Fehlversuche sperren 15 Minuten je Absender und je Name', () => mitKonten(async ({ uhr, laden }) => {
  const konten = await laden();
  for (let i = 0; i < 10; i++) assert.equal(await status(konten.anmelden('admin', 'falsch', `10.0.0.${i}`)), 401);
  assert.equal(await status(konten.anmelden('admin', 'admin', '10.0.0.99')), 429, 'Name gesperrt, auch mit richtigem Passwort');
  assert.equal(await status(konten.anmelden('anderer', 'x', '10.0.0.99')), 401, 'anderer Name von neuem Absender nicht gesperrt');
  uhr.vor(15 * 60000);
  assert.equal(await status(konten.anmelden('admin', 'admin', '10.0.0.99')), 'ok');
  await konten.fertig();
}));

test('Registrierung nur wenn eingeschaltet, mit Benutzerrechten und sofortiger Sitzung', () => mitKonten(async ({ laden }) => {
  const konten = await laden();
  assert.equal(await status(konten.registrieren('gast', 'sicher123')), 403);
  await konten.einstellungenSetzen({ registrierung: true });
  assert.equal(await status(konten.registrieren('g', 'sicher123')), 400, 'Name zu kurz');
  assert.equal(await status(konten.registrieren('gast', 'kurz')), 400, 'Passwort zu kurz');
  assert.equal(await status(konten.registrieren('Admin', 'sicher123')), 409, 'Name vergeben (Groß/klein egal)');
  const { benutzer, token } = await konten.registrieren('Gäste-Konto', 'sicher123');
  assert.equal(benutzer.rolle, 'benutzer');
  assert.equal(benutzer.herkunft, 'registrierung');
  assert.equal(konten.sitzung(token).benutzer.name, 'Gäste-Konto');
  assert.equal(konten.einstellungen().registrierung, true);
  await konten.fertig();
  assert.equal((await laden()).einstellungen().registrierung, true);
}));

test('Eigenes Konto: nur mit aktuellem Passwort, neuer Name und neues Passwort, andere Geräte abgemeldet', () => mitKonten(async ({ laden }) => {
  const konten = await laden();
  const hier = await konten.anmelden('admin', 'admin');
  const dort = await konten.anmelden('admin', 'admin');
  const id = hier.benutzer.id;
  assert.equal(await status(konten.kontoAendern(id, { name: 'fabian', passwortAlt: 'falsch' }, hier.token)), 403);
  assert.equal(await status(konten.kontoAendern(id, { passwortAlt: 'admin', passwortNeu: 'kurz' }, hier.token)), 400);
  const geaendert = await konten.kontoAendern(id, { name: 'fabian', passwortAlt: 'admin', passwortNeu: 'NeuesPasswort1' }, hier.token);
  assert.equal(geaendert.name, 'fabian');
  assert.equal(geaendert.standardPasswort, false);
  assert.ok(konten.sitzung(hier.token), 'eigene Sitzung bleibt');
  assert.equal(konten.sitzung(dort.token), null, 'anderes Gerät abgemeldet');
  assert.equal(await status(konten.anmelden('admin', 'admin')), 401);
  assert.equal(await status(konten.anmelden('fabian', 'NeuesPasswort1')), 'ok');
  await konten.fertig();
}));

test('Verwaltung: anlegen, bearbeiten, löschen – der letzte Admin bleibt', () => mitKonten(async ({ laden }) => {
  const konten = await laden();
  const admin = konten.liste()[0];
  const ich = await konten.anmelden('admin', 'admin');
  assert.equal(await status(konten.bearbeiten(admin.id, { rolle: 'benutzer' })), 409, 'letzten Admin nicht herabstufen');
  assert.equal(await status(konten.loeschen(admin.id, 'jemand-anderes')), 409, 'letzten Admin nicht löschen');
  assert.equal(await status(konten.anlegen({ name: 'admin', passwort: 'sicher123' })), 409);

  const technik = await konten.anlegen({ name: 'technik', passwort: 'sicher123', rolle: 'benutzer' });
  assert.equal(technik.herkunft, 'verwaltung');
  const sitzung = await konten.anmelden('technik', 'sicher123');
  await konten.bearbeiten(technik.id, { name: 'technik2', rolle: 'admin', passwort: 'anders1234' });
  assert.equal(konten.sitzung(sitzung.token), null, 'neues Passwort meldet ab');
  assert.equal(konten.liste().find((b) => b.id === technik.id).rolle, 'admin');

  await konten.bearbeiten(admin.id, { passwort: 'selbst1234' }, ich.token);
  assert.ok(konten.sitzung(ich.token), 'eigene Sitzung bleibt bei Selbstbearbeitung');
  await konten.bearbeiten(admin.id, { rolle: 'benutzer' });
  assert.equal(konten.sitzung(ich.token).benutzer.rolle, 'benutzer', 'Rolle wirkt sofort');

  assert.equal(await status(konten.loeschen(technik.id, technik.id)), 409, 'nicht sich selbst');
  assert.equal(await status(konten.loeschen(technik.id, admin.id)), 409, 'technik2 ist jetzt der letzte Admin');
  await konten.bearbeiten(admin.id, { rolle: 'admin' });
  const zweite = await konten.anmelden('technik2', 'anders1234');
  await konten.loeschen(technik.id, admin.id);
  assert.equal(konten.sitzung(zweite.token), null, 'Löschen beendet die Sitzungen');
  assert.deepEqual(konten.liste().map((b) => b.name), ['admin']);
  await konten.fertig();
}));

test('Notfall-Reset stellt admin/admin als Administrator wieder her', () => mitKonten(async ({ laden }) => {
  const konten = await laden();
  const { token, benutzer } = await konten.anmelden('admin', 'admin');
  await konten.kontoAendern(benutzer.id, { passwortAlt: 'admin', passwortNeu: 'vergessen99' }, token);
  await konten.fertig();
  const notfall = await laden();
  const zurueck = await notfall.adminZuruecksetzen();
  assert.equal(zurueck.standardPasswort, true);
  await notfall.fertig();
  const danach = await laden();
  assert.equal(danach.sitzung(token), null, 'alte Sitzungen beendet');
  assert.equal(await status(danach.anmelden('admin', 'admin')), 'ok');
  await danach.fertig();
}));

test('Einstellungen (Standard-Zugang MikroTik): leerer Standard, atomar mit 0600, Validierung, Neustart', async () => {
  const ordner = await mkdtemp(join(tmpdir(), 'einstellungen-'));
  try {
    // lesen() ist asynchron: die Datei wird bei jeder Anfrage frisch gelesen (Änderungen von Hand gelten ohne Neustart)
    const e = await einstellungenLaden(ordner);
    assert.deepEqual((await e.lesen()).mikrotikZugang, { benutzer: '', passwort: '' }, 'fehlende Datei = leerer Zugang');
    await e.setzen({ mikrotikZugang: { benutzer: 'admin', passwort: 'Geheim-1' } });
    assert.deepEqual((await e.lesen()).mikrotikZugang, { benutzer: 'admin', passwort: 'Geheim-1' });
    const datei = join(ordner, 'einstellungen.json');
    const inhalt = JSON.parse(await readFile(datei, 'utf8'));
    assert.equal(inhalt.version, 1);
    assert.equal(inhalt.mikrotikZugang.benutzer, 'admin');
    assert.equal((await stat(datei)).mode & 0o777, 0o600, 'nur der Besitzer liest die Datei');
    assert.deepEqual((await readdir(ordner)).filter((n) => n !== 'einstellungen.json'), [], 'keine Hilfsdatei übrig (tmp + rename)');
    const neu = await einstellungenLaden(ordner);
    assert.equal((await neu.lesen()).mikrotikZugang.passwort, 'Geheim-1', 'übersteht einen Neustart');
    for (const falsch of [{ mikrotikZugang: { benutzer: 'x'.repeat(65), passwort: '' } }, { mikrotikZugang: { benutzer: 'a', passwort: 'p'.repeat(129) } }]) {
      await assert.rejects(neu.setzen(falsch), (f) => f.status === 400, JSON.stringify(falsch).slice(0, 40));
    }
    assert.equal((await neu.lesen()).mikrotikZugang.benutzer, 'admin', 'abgelehnte Änderung lässt alles stehen');
    await neu.setzen({ mikrotikZugang: { benutzer: '', passwort: '' } });
    assert.deepEqual((await (await einstellungenLaden(ordner)).lesen()).mikrotikZugang, { benutzer: '', passwort: '' }, 'Leeren erlaubt');
  } finally { await rm(ordner, { recursive: true, force: true }); }
});

test('Weiterleitung an den Controller ohne das Explorer-Cookie', () => {
  // seit dem Umbau je Lauf ein eigenes Ziel (zweiter Parameter)
  const ziel = { host: 'unifi-vorschau-app-a1', port: 8443, schema: 'https' };
  assert.equal(zielKopf({ cookie: 'fah_explorer=geheim; unifises=abc; csrf_token=x' }, ziel).cookie, 'unifises=abc; csrf_token=x');
  assert.equal(zielKopf({ cookie: 'fah_explorer=geheim' }, ziel).cookie, undefined);
});
