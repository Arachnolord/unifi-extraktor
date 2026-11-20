// FAH-Extraktor · Urheber: Fabian Hammer
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import * as docker from '../docker.js';
import { setze, pruefe, warte, bisBereit, labels, hostKonfig } from '../lauf.js';

// Omada-Vorschau: frischer Omada Software Controller (mbentley/omada-controller) im
// abgeschotteten Vorschau-Netz. Ablauf wie im Einrichtungsassistenten: Wegwerf-Admin
// anlegen (ohne ihn verweigert der Controller das Wiederherstellen: „Local MasterAdmin
// not exist“), Backup über die anonyme Restore-Schnittstelle einspielen, warten bis 100 %.
// Der Wegwerf-Admin bleibt danach Hauptadmin – darüber meldet die App automatisch an.
// Ältere Backups gehen in den neueren Controller (von TP-Link unterstützter Upgrade-Weg).
export const art = 'omada';
export const bezeichnung = 'Der Omada-Controller';
const IMAGE = process.env.OMADA_IMAGE || 'mbentley/omada-controller:6.2.14.11-openj9';
const IMAGE_VERSION = (IMAGE.match(/:(\d+\.\d+\.\d+(?:\.\d+)?)/) || [])[1] || null;
const BENUTZER = 'fah-vorschau';
const PORT = 8043;
// Ein Controller braucht ~1,1 GB im Leerlauf – mehr als zwei gleichzeitig verdrängen andere Dienste.
export const MAX_GLEICHZEITIG = Math.max(1, Number(process.env.OMADA_MAX) || 2);

export const SCHRITTE = [
  ['vorbereiten', 'Backup prüfen'],
  ['laden', 'Omada-Controller bereitstellen'],
  ['starten', 'Controller starten'],
  ['einspielen', 'Backup einspielen'],
  ['anmelden', 'Anmeldung vorbereiten']
];

export const zielFuer = (l) => ({ host: l.app, port: PORT, schema: 'https' });
export const zugang = (l) => ({ benutzer: l.benutzer || BENUTZER, passwort: l.passwort, hinweis: 'Automatische Anmeldung; sonst diese Daten.' });
export const statusExtra = (l) => ({ omada: l.omada || null });
export const istHuelle = () => false;
export const banner = null;

export function logAuszug(log) {
  return log.split('\n').map((z) => z.trimEnd()).filter((z) => /WARN|ERROR|restore|Caused by/i.test(z) && !/^\s+at /.test(z)).slice(-25).join('\n');
}

// --- HTTPS zum Controller (selbstsigniert) -------------------------------------
function anfrage(ziel, methode, pfad, { json, datei, cookie, token, timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    let body = null;
    const kopf = { Host: `${ziel.host}:${ziel.port}`, 'User-Agent': 'FAH-Extraktor', Accept: 'application/json' };
    if (json !== undefined) { body = Buffer.from(JSON.stringify(json)); kopf['Content-Type'] = 'application/json'; }
    if (datei) {
      const grenze = `----fah${randomBytes(8).toString('hex')}`;
      body = Buffer.concat([
        Buffer.from(`--${grenze}\r\nContent-Disposition: form-data; name="file"; filename="backup.cfg"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        datei, Buffer.from(`\r\n--${grenze}--\r\n`)
      ]);
      kopf['Content-Type'] = `multipart/form-data; boundary=${grenze}`;
    }
    if (body) kopf['Content-Length'] = body.length;
    if (cookie) kopf.Cookie = cookie;
    if (token) kopf['Csrf-Token'] = token;
    const req = https.request({ host: ziel.host, port: ziel.port, method: methode, path: pfad, headers: kopf, timeout, rejectUnauthorized: false }, (res) => {
      const teile = [];
      res.on('data', (t) => teile.push(t));
      res.on('end', () => {
        const text = Buffer.concat(teile).toString('utf8');
        let daten = null;
        try { daten = JSON.parse(text); } catch { /* kein JSON */ }
        resolve({ status: res.statusCode, daten, cookies: [].concat(res.headers['set-cookie'] || []).map((c) => c.split(';')[0]) });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    if (body) req.write(body);
    req.end();
  });
}

const info = async (ziel) => (await anfrage(ziel, 'GET', '/api/info', { timeout: 5000 }))?.daten?.result || null;

async function anmelden(l) {
  const r = await anfrage(l.ziel, 'POST', `/${l.omadacId}/api/v2/login`, { json: { username: l.benutzer || BENUTZER, password: l.passwort } });
  if (r?.daten?.errorCode !== 0 || !r.daten.result?.token) return null;
  l.cookieNamen = [...new Set([...(l.cookieNamen || []), ...r.cookies.map((c) => c.split('=')[0])])];
  return { cookie: r.cookies.join('; '), cookies: r.cookies, token: r.daten.result.token };
}

// Frische Sitzung für den Browser (automatische Anmeldung, wie bei UniFi). Die Oberfläche beginnt
// unter "/" (die Adresse /<omadacId>/ liefert 404). Mit eigenesKonto: Sitzungs-Cookies löschen,
// dann zeigt Omada seine Anmeldeseite für die Zugangsdaten aus dem Backup.
export async function oeffnenZiel(l, { eigenesKonto = false } = {}) {
  if (eigenesKonto) return { cookie: (l.cookieNamen?.length ? l.cookieNamen : ['TPOMADA_SESSIONID']).map((n) => `${n}=; Max-Age=0`), location: '/' };
  const s = await anmelden(l);
  return s ? { cookie: s.cookies, location: '/' } : null;
}

const vergleiche = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

const fehler400 = (text) => Object.assign(new Error(text), { status: 400 });
// Regeln wie im Omada-Assistenten: Benutzer druckbares ASCII ohne Leerzeichen, Passwort 8–64 Zeichen
// mit Groß- und Kleinbuchstaben, Ziffer und Sonderzeichen.
export function passwortOk(pw) {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 64 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw) && /^[\x21-\x7E]+$/.test(pw);
}

// Version aus dem Dateinamen („omada_backup_6.2.14.11_…“); Benutzer/Passwort optional aus dem Kopf
// X-Vorschau-Optionen (percent-kodiertes JSON). Ohne Passwort: automatisches Wegwerf-Konto.
export function optionenPruefen(eingabe, name, roh) {
  if (!(eingabe instanceof Uint8Array) || eingabe.length < 64) throw fehler400('Die Datei ist leer oder zu kurz.');
  const version = (String(name || '').match(/(\d+\.\d+\.\d+(?:\.\d+)?)/) || [])[1] || null;
  let o = {};
  if (roh) { try { o = JSON.parse(decodeURIComponent(String(roh))) || {}; } catch { throw fehler400('Vorschau-Optionen sind kein gültiges JSON.'); } }
  const passwort = String(o.passwort ?? '');
  if (!passwort) return { version, benutzer: null, passwort: null };
  const benutzer = String(o.benutzer ?? '').trim();
  if (!/^[\x21-\x7E]{1,64}$/.test(benutzer)) throw fehler400('Benutzername: 1–64 Zeichen, keine Leerzeichen.');
  if (!passwortOk(passwort)) throw fehler400('Das Passwort braucht 8–64 Zeichen mit Groß- und Kleinbuchstaben, Ziffer und Sonderzeichen (Omada-Regel), ohne Leerzeichen.');
  return { version, benutzer, passwort };
}

// Omada verlangt ein starkes Passwort (Groß-/Kleinbuchstaben, Ziffer, Sonderzeichen) – der
// allgemeine Zufallswert des Laufs erfüllt das nicht immer („Invalid password“).
export const starkesPasswort = () => `Fv!${randomBytes(12).toString('hex')}A9`;

export async function ablauf(l, eingabe, optionen, kern) {
  setze(l, 'vorbereiten', 'laeuft');
  l.benutzer = optionen.passwort ? optionen.benutzer : BENUTZER;
  l.passwort = optionen.passwort || starkesPasswort();
  const backupVersion = optionen.version;
  l.omada = { backupVersion, controllerVersion: IMAGE_VERSION, sites: null, hinweise: [] };
  if (backupVersion && IMAGE_VERSION && vergleiche(backupVersion, IMAGE_VERSION) > 0) {
    l.omada.hinweise.push(`Das Backup stammt aus Omada ${backupVersion}, der Vorschau-Controller ist ${IMAGE_VERSION} – das Einspielen kann scheitern.`);
  }
  setze(l, 'vorbereiten', 'fertig', `Omada-Backup · ${Math.max(1, Math.round(eingabe.length / 1024))} KB${backupVersion ? ` · aus Omada ${backupVersion}` : ''}`);

  setze(l, 'laden', 'laeuft', `Omada ${IMAGE_VERSION}`);
  if (!await docker.imageInfo(IMAGE)) {
    const [repo, tag] = IMAGE.split(':');
    await docker.imageLaden(repo, tag, (geladen, gesamt) => {
      setze(l, 'laden', 'laeuft', `Omada ${IMAGE_VERSION} wird einmalig geladen … ${Math.round((geladen / Math.max(gesamt, 1)) * 100)} %`);
    });
  }
  pruefe(l);
  setze(l, 'laden', 'fertig', `Omada ${IMAGE_VERSION}${backupVersion && vergleiche(backupVersion, IMAGE_VERSION) < 0 ? ` (Backup aus ${backupVersion} wird angehoben)` : ''}`);

  setze(l, 'starten', 'laeuft');
  const start = Date.now();
  const netz = await kern.netz();
  pruefe(l);
  const id = await docker.containerErstellen(l.app, {
    Image: IMAGE, Labels: labels(l, art),
    Env: [`TZ=${process.env.TZ || 'Europe/Berlin'}`, `MANAGE_HTTPS_PORT=${PORT}`],
    HostConfig: hostKonfig(netz, 2, 2.5)
  });
  await docker.containerStarten(id);
  let i = null;
  await bisBereit(l, 10 * 60000, async () => Boolean((i = await info(l.ziel))?.omadacId), bezeichnung, 4000);
  l.omadacId = i.omadacId;
  setze(l, 'starten', 'fertig', `nach ${Math.round((Date.now() - start) / 1000)} s`);

  setze(l, 'einspielen', 'laeuft', l.benutzer === BENUTZER ? 'Wegwerf-Admin wird angelegt' : `Konto „${l.benutzer}“ wird angelegt`);
  if (!i.registeredRoot) {
    const r = await anfrage(l.ziel, 'POST', '/api/v2/anon/register', { json: { username: l.benutzer, password: l.passwort, email: 'vorschau@fah-extraktor.invalid', allowRemoteBinding: false, language: 1 } });
    if (r?.daten?.errorCode !== 0) throw new Error(`Der Controller nimmt den Wegwerf-Admin nicht an: ${r?.daten?.msg || 'keine Antwort'}`);
  }
  pruefe(l);
  await anfrage(l.ziel, 'GET', `/${l.omadacId}/api/v2/anon/restore/prepare`);
  const hoch = await anfrage(l.ziel, 'POST', `/${l.omadacId}/api/v2/anon/files/restore`, { datei: Buffer.from(eingabe), timeout: 20 * 60000 });
  if (hoch?.daten?.errorCode !== 0) throw new Error(`Der Controller lehnt das Backup ab: ${hoch?.daten?.msg || 'keine Antwort'}`);
  let stand = null;
  await bisBereit(l, 20 * 60000, async () => {
    const r = await anfrage(l.ziel, 'GET', `/${l.omadacId}/api/v2/anon/restore/result`, { timeout: 8000 });
    if (r?.daten && r.daten.errorCode !== 0) throw new Error(`Einspielen fehlgeschlagen: ${r.daten.msg || r.daten.errorCode}`);
    stand = r?.daten?.result || stand;
    if (stand?.percent != null) setze(l, 'einspielen', 'laeuft', `Backup wird eingespielt … ${stand.percent} %`);
    return stand?.percent >= 100 && stand.status !== 2;
  }, bezeichnung, 3000);
  setze(l, 'einspielen', 'fertig');

  setze(l, 'anmelden', 'laeuft');
  let sitzung = null;
  await bisBereit(l, 5 * 60000, async () => (sitzung = await anmelden(l)) !== null, bezeichnung, 3000);
  const sites = await anfrage(l.ziel, 'GET', `/${l.omadacId}/api/v2/sites?currentPage=1&currentPageSize=100`, sitzung);
  l.omada.sites = (sites?.daten?.result?.data || []).map((s) => s.name).slice(0, 50);
  setze(l, 'anmelden', 'fertig', `${l.omada.sites.length} ${l.omada.sites.length === 1 ? 'Site' : 'Sites'}${l.omada.sites.length ? `: ${l.omada.sites.slice(0, 3).join(', ')}${l.omada.sites.length > 3 ? ' …' : ''}` : ''}`);
  console.log(`[vorschau] ${l.app} bereit nach ${Math.round((Date.now() - start) / 1000)} s (Omada ${IMAGE_VERSION}, ${l.omada.sites.length} Sites)`);
  await warte(0);
}
