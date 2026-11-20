import http from 'node:http';
import * as vorschau from './vorschau.js';
import * as docker from './docker.js';
import { leiteWeiter, leiteUpgradeWeiter } from './proxy.js';
import * as mitschau from './mitschau.js';
import * as ws from './ws.js';
import { kontenLaden, COOKIE } from './konten.js';
import { einstellungenLaden } from './einstellungen.js';
import { optionenPruefen, CHR_IMAGE } from './arten/mikrotik.js';
import { optionenPruefen as omadaOptionen } from './arten/omada.js';
import { uebergabeDatei } from './uebergabe.js';
import { versionenAbfragen, lokaleVersionen, waehleChrVersion } from './mikrotik-versionen.js';

// Backend des FAH-Extraktors. nginx schickt /_explorer/api/* und alle Pfade, die
// nicht zum Explorer gehören (UniFi: /manage, /api, /wss - MikroTik: /webfig,
// /jsproxy, /rest), hierher. Außer Anmeldeseite, Programmcode und Favicon braucht
// alles eine Sitzung.
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD = 300 * 1024 * 1024;
const MAX_JSON = 16 * 1024;
const DATEN = process.env.DATEN || '/data';
const konten = await kontenLaden(DATEN);
const einstellungen = await einstellungenLaden(DATEN);

const istHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

function json(res, status, daten, kopf = {}) {
  const inhalt = Buffer.from(JSON.stringify(daten));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': inhalt.length, 'cache-control': 'no-store', ...kopf });
  res.end(inhalt);
}

function cookieWert(req, name) {
  for (const teil of String(req.headers.cookie || '').split(';')) {
    const stelle = teil.indexOf('=');
    if (stelle > 0 && teil.slice(0, stelle).trim() === name) return teil.slice(stelle + 1).trim();
  }
  return '';
}

const sitzungVon = (req) => konten.sitzung(cookieWert(req, COOKIE));
// Die Sitzung selbst läuft serverseitig 30 Tage nach der letzten Nutzung ab; das
// Cookie darf daher lange leben.
const sitzungsCookie = (req, token) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? 400 * 86400 : 0}${istHttps(req) ? '; Secure' : ''}`;
// Hinter nginx/Proxy steht der eigentliche Absender vorn in X-Forwarded-For.
const absender = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
const suchparameter = (req) => new URL(req.url, 'http://explorer').searchParams;
// Das Vorschau-Fenster lädt /vorschau/oeffnen?eingebettet=1 in einem iframe.
const eingebettet = (req) => suchparameter(req).get('eingebettet') === '1' || req.headers['sec-fetch-dest'] === 'iframe';

function koerper(req, max) {
  return new Promise((resolve, reject) => {
    const teile = [];
    let groesse = 0;
    req.on('data', (teil) => {
      groesse += teil.length;
      if (groesse > max) { reject(Object.assign(new Error('Das Backup ist zu groß.'), { status: 413 })); req.destroy(); return; }
      teile.push(teil);
    });
    req.on('end', () => { const b = Buffer.concat(teile); resolve(new Uint8Array(b.buffer, b.byteOffset, b.length)); });
    req.on('error', reject);
  });
}

async function jsonKoerper(req) {
  const roh = Buffer.from(await koerper(req, MAX_JSON)).toString('utf8');
  try { return roh ? JSON.parse(roh) : {}; } catch { throw Object.assign(new Error('Ungültige Anfrage.'), { status: 400 }); }
}

const SEITE_KOPF = '<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keine Vorschau aktiv</title>'
  + '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#080d16;color:#dbe6f7;font-family:system-ui,sans-serif">'
  + '<div style="text-align:center;padding:24px"><h1 style="font-size:20px">Keine virtuelle Vorschau aktiv</h1>';

function keineVorschau(req, res) {
  if (req.method === 'GET' && /text\/html/.test(req.headers.accept || '')) {
    // Im Fenster des Explorers: nur der Hinweis, ohne Link (der Explorer darf nicht in einen Frame).
    const seite = eingebettet(req)
      ? `${SEITE_KOPF}<p style="color:#8da0bb">Keine virtuelle Vorschau aktiv – im FAH-Extraktor starten.</p></div></body></html>`
      : `${SEITE_KOPF}<p style="color:#8da0bb">Für dein Konto läuft gerade keine Vorschau – sie wurde beendet oder noch nicht gestartet.</p>`
        + '<a href="/" target="_top" style="color:#3b9cff">Zum FAH-Extraktor</a></div></body></html>';
    res.writeHead(eingebettet(req) ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(seite);
  }
  json(res, 503, { meta: { rc: 'error', msg: 'Keine virtuelle Vorschau aktiv.' }, data: [], fehler: 'Keine virtuelle Vorschau aktiv.' });
}

function zurAnmeldung(req, res) {
  if (req.method === 'GET' && /text\/html/.test(req.headers.accept || '')) {
    res.writeHead(302, { location: `/_explorer/anmeldung?weiter=${encodeURIComponent(req.url)}`, 'cache-control': 'no-store' });
    return res.end();
  }
  json(res, 401, { meta: { rc: 'error', msg: 'Bitte im FAH-Extraktor anmelden.' }, data: [], fehler: 'Bitte anmelden.' });
}

const alleEinstellungen = async () => ({ ...konten.einstellungen(), ...await einstellungen.lesen() });

async function api(req, res, pfad) {
  if (pfad === '/_explorer/api/gesund') return json(res, 200, { ok: true });
  const sitzung = sitzungVon(req);
  // Für nginx (auth_request vor der Explorer-Seite): 204 = angemeldet, 401 = nicht.
  if (pfad === '/_explorer/api/pruefen') { res.writeHead(sitzung ? 204 : 401, { 'cache-control': 'no-store' }); return res.end(); }
  if (pfad === '/_explorer/api/anmeldung' && req.method === 'GET') {
    return json(res, 200, { angemeldet: Boolean(sitzung), registrierung: konten.einstellungen().registrierung });
  }
  // Eigener Kopf erzwingt bei fremden Seiten eine CORS-Vorabfrage -> keine Änderungen per CSRF.
  if (req.method !== 'GET' && req.headers['x-explorer'] !== '1') return json(res, 403, { fehler: 'Anfrage ohne Explorer-Kennung.' });

  if (pfad === '/_explorer/api/anmelden' && req.method === 'POST') {
    const { name, passwort } = await jsonKoerper(req);
    const ergebnis = await konten.anmelden(name, passwort, absender(req));
    console.log(`[konten] ${ergebnis.benutzer.name} angemeldet`);
    return json(res, 200, { benutzer: ergebnis.benutzer }, { 'set-cookie': sitzungsCookie(req, ergebnis.token) });
  }
  if (pfad === '/_explorer/api/registrieren' && req.method === 'POST') {
    const { name, passwort } = await jsonKoerper(req);
    const ergebnis = await konten.registrieren(name, passwort);
    console.log(`[konten] ${ergebnis.benutzer.name} hat sich registriert`);
    return json(res, 201, { benutzer: ergebnis.benutzer }, { 'set-cookie': sitzungsCookie(req, ergebnis.token) });
  }
  if (pfad === '/_explorer/api/abmelden' && req.method === 'POST') {
    konten.abmelden(cookieWert(req, COOKIE));
    return json(res, 200, { ok: true }, { 'set-cookie': sitzungsCookie(req, '') });
  }

  if (!sitzung) {
    // "Vorschau öffnen" mit abgelaufener Sitzung: über die Anmeldung zurück.
    if (pfad === '/_explorer/api/vorschau/oeffnen' || pfad === '/_explorer/api/vorschau/tab') return zurAnmeldung(req, res);
    return json(res, 401, { fehler: 'Bitte anmelden.' });
  }
  const ich = sitzung.benutzer;

  if (pfad === '/_explorer/api/konto') {
    if (req.method === 'GET') return json(res, 200, { benutzer: ich });
    if (req.method === 'PUT') return json(res, 200, { benutzer: await konten.kontoAendern(ich.id, await jsonKoerper(req), sitzung.token) });
    return json(res, 405, { fehler: 'Methode nicht erlaubt.' });
  }

  const verwaltung = pfad.match(/^\/_explorer\/api\/benutzer(?:\/([0-9a-f]{16}))?$/);
  if (verwaltung || pfad === '/_explorer/api/einstellungen') {
    if (ich.rolle !== 'admin') return json(res, 403, { fehler: 'Nur für Administratoren.' });
    if (pfad === '/_explorer/api/einstellungen') {
      if (req.method === 'GET') return json(res, 200, await alleEinstellungen());
      if (req.method === 'PUT') {
        // Teilweise erlaubt: nur die mitgeschickten Felder ändern sich (ein fehlendes
        // "registrierung" schaltet die Registrierung nicht ab).
        const daten = await jsonKoerper(req);
        if (daten.registrierung !== undefined) await konten.einstellungenSetzen({ registrierung: daten.registrierung });
        if (daten.mikrotikZugang !== undefined) await einstellungen.setzen({ mikrotikZugang: daten.mikrotikZugang });
        console.log(`[einstellungen] ${ich.name} hat geändert: ${Object.keys(daten).join(', ') || 'nichts'}`);
        return json(res, 200, await alleEinstellungen());
      }
      return json(res, 405, { fehler: 'Methode nicht erlaubt.' });
    }
    const id = verwaltung[1];
    if (!id && req.method === 'GET') return json(res, 200, { benutzer: konten.liste(), ...await alleEinstellungen() });
    if (!id && req.method === 'POST') {
      const konto = await konten.anlegen(await jsonKoerper(req));
      console.log(`[konten] ${ich.name} hat ${konto.name} angelegt (${konto.rolle})`);
      return json(res, 201, { benutzer: konto });
    }
    if (id && req.method === 'PATCH') return json(res, 200, { benutzer: await konten.bearbeiten(id, await jsonKoerper(req), id === ich.id ? sitzung.token : undefined) });
    if (id && req.method === 'DELETE') {
      await konten.loeschen(id, ich.id);
      console.log(`[konten] ${ich.name} hat ein Konto gelöscht`);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { fehler: 'Methode nicht erlaubt.' });
  }

  // Vorbereitung des Virtualisieren-Dialogs (MikroTik): Versionen, Vorschlag, Standard-Zugang, Belegung.
  if (pfad === '/_explorer/api/mikrotik/vorbereitung' && req.method === 'GET') {
    const parameter = suchparameter(req);
    const hauptversion = parameter.get('hauptversion') || '7';
    if (hauptversion !== '7') return json(res, 400, { fehler: 'RouterOS 6 wird noch nicht virtualisiert – nur Backups aus RouterOS 7.' });
    const mindestens = /^\d+\.\d+(\.\d+)?$/.test(parameter.get('mindestens') || '') ? parameter.get('mindestens') : '';
    const [{ kanaele, quelle, stand }, lokal, image, zugang] = await Promise.all([
      versionenAbfragen(hauptversion), lokaleVersionen(), docker.imageInfo(CHR_IMAGE).catch(() => null), einstellungen.lesen()
    ]);
    const { vorschlag, hinweis } = waehleChrVersion(kanaele, lokal, hauptversion, mindestens);
    return json(res, 200, {
      vorschlag, hinweis, kanaele, lokal, quelle, stand, zugang: zugang.mikrotikZugang, image: Boolean(image), kvm: null,
      max: vorschau.MAX, belegt: vorschau.status(ich).andere.length
    });
  }

  // „Neuer Tab“ bei MikroTik: Vollbild-Seite mit dem Vorschau-Fenster. WebFig springt zur
  // Anmeldung auf "/" – das geht nur aus einem Frame an die Vorschau (nginx: location = /).
  if (pfad === '/_explorer/api/vorschau/tab' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "frame-ancestors 'none'" });
    return res.end('<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<title>Virtuelle Vorschau – FAH-Extraktor</title><style>html,body{margin:0;height:100%;background:#0b1220}iframe{display:block;border:0;width:100%;height:100%}</style></head>'
      + '<body><iframe src="/_explorer/api/vorschau/oeffnen?eingebettet=1" title="Virtuelle Vorschau"></iframe></body></html>');
  }

  if (pfad === '/_explorer/api/vorschau/oeffnen' && req.method === 'GET') {
    const ziel = await vorschau.oeffnenZiel(vorschau.laufVon(ich.id), { eigenesKonto: suchparameter(req).get('konto') === 'eigen' });
    if (!ziel) {
      if (eingebettet(req)) return keineVorschau(req, res);
      res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
      return res.end();
    }
    res.writeHead(302, {
      ...(ziel.cookie ? { 'set-cookie': [].concat(ziel.cookie).map((c) => `${c}; Path=/; HttpOnly; SameSite=Lax${istHttps(req) ? '; Secure' : ''}`) } : {}),
      location: ziel.location, 'cache-control': 'no-store'
    });
    return res.end();
  }
  // Lebenszeichen des Vorschau-Fensters (WebFig hat keinen WebSocket): hält den Leerlauf-Wächter fern.
  if (pfad === '/_explorer/api/vorschau/puls' && req.method === 'POST') {
    const lauf = vorschau.laufVon(ich.id);
    if (lauf) vorschau.aktivitaet(lauf);
    res.writeHead(204, { 'cache-control': 'no-store' });
    return res.end();
  }
  if (pfad === '/_explorer/api/uebergabe' && req.method === 'POST') {
    const { unf, ausgelassen } = await uebergabeDatei(await koerper(req, MAX_UPLOAD));
    console.log(`[uebergabe] Kundendatei erstellt durch ${ich.name}`);
    const inhalt = Buffer.from(unf);
    res.writeHead(200, {
      'content-type': 'application/octet-stream', 'content-length': inhalt.length, 'cache-control': 'no-store',
      'x-uebergabe-ausgelassen': ausgelassen.slice(0, 20).map((name) => String(name).replace(/[^\w./: -]/g, '_').slice(0, 80)).join(', ')
        + (ausgelassen.length > 20 ? ` und ${ausgelassen.length - 20} weitere` : '')
    });
    return res.end(inhalt);
  }
  if (pfad !== '/_explorer/api/vorschau') return json(res, 404, { fehler: 'Unbekannte Adresse.' });
  if (req.method === 'GET') return json(res, 200, vorschau.status(ich));
  if (req.method === 'POST') {
    const art = suchparameter(req).get('art') || 'unifi';
    if (!vorschau.ARTEN[art]) return json(res, 400, { fehler: 'Unbekannte Vorschau-Art.' });
    const datei = await koerper(req, MAX_UPLOAD);
    let name = 'Backup';
    try { name = decodeURIComponent(String(req.headers['x-backup-name'] || 'Backup')).slice(0, 200); } catch { /* Name bleibt "Backup" */ }
    // Optionen werden vor dem Start geprüft (400 mit klarem Text); Geheimnisse stehen nie im Log.
    const optionen = art === 'mikrotik' ? optionenPruefen(req.headers['x-vorschau-optionen'], datei) : art === 'omada' ? omadaOptionen(datei, name, req.headers['x-vorschau-optionen']) : {};
    console.log(`[vorschau] Start (${art}) durch ${ich.name}: ${name} (${datei.length} Byte)`);
    return json(res, 202, await vorschau.starte(art, datei, name, ich, optionen));
  }
  if (req.method === 'DELETE') {
    // Ohne ?id= die eigene Vorschau; eine fremde dürfen nur Administratoren beenden.
    const id = suchparameter(req).get('id');
    const lauf = id ? vorschau.laufMitId(id) : vorschau.laufVon(ich.id);
    if (lauf && lauf.kontoId !== ich.id) {
      if (ich.rolle !== 'admin') return json(res, 403, { fehler: 'Fremde Vorschauen dürfen nur Administratoren beenden.' });
      console.log(`[vorschau] ${ich.name} beendet die Vorschau von ${lauf.gestartetVon}: ${lauf.name}`);
      await vorschau.beende(lauf.kontoId, `von ${ich.name} beendet`, lauf.id);
    } else if (lauf) {
      console.log(`[vorschau] Beendet durch ${ich.name}`);
      await vorschau.beende(ich.id, 'beendet', lauf.id);
    }
    return json(res, 200, vorschau.status(ich));
  }
  json(res, 405, { fehler: 'Methode nicht erlaubt.' });
}

const server = http.createServer(async (req, res) => {
  try {
    const pfad = new URL(req.url, 'http://explorer').pathname;
    if (pfad.startsWith('/_explorer/api/')) return await api(req, res, pfad);
    const sitzung = sitzungVon(req);
    if (!sitzung) return zurAnmeldung(req, res);
    // Jedes Konto sieht seine eigene Vorschau; ihre Art bestimmt Ziel, Hülle und Hinweis.
    const lauf = vorschau.laufVon(sitzung.benutzer.id);
    if (!vorschau.bereit(lauf)) return keineVorschau(req, res);
    vorschau.aktivitaet(lauf);
    const A = vorschau.artVon(lauf);
    leiteWeiter(req, res, { ziel: lauf.ziel, banner: A.banner ? () => A.banner(lauf) : null, https: istHttps(req), istHuelle: A.istHuelle });
  } catch (fehler) {
    console.error('[server]', fehler);
    if (!res.headersSent) json(res, fehler.status || 500, { fehler: fehler.message });
    else res.destroy();
  }
});

server.on('upgrade', (req, socket, head) => {
  const pfad = new URL(req.url, 'http://explorer').pathname;
  // Mitschau-Kanal: eigene WebSocket je angemeldeter Oberfläche (nicht an die Vorschau weiterreichen).
  if (pfad === '/_explorer/ws/mitschau') {
    const sitzung = sitzungVon(req);
    if (!sitzung || !ws.istWebSocket(req)) return socket.destroy();
    socket.on('error', () => socket.destroy());
    mitschau.verbinde(ws.annehmen(req, socket), sitzung.benutzer);
    return;
  }
  const sitzung = req.url.startsWith('/_explorer/') ? null : sitzungVon(req);
  const lauf = sitzung && vorschau.laufVon(sitzung.benutzer.id);
  if (!vorschau.bereit(lauf)) return socket.destroy();
  leiteUpgradeWeiter(req, socket, head, { ziel: lauf.ziel, beiOffen: () => vorschau.socketAuf(lauf), beiZu: vorschau.socketZu });
});

server.requestTimeout = 0;
server.headersTimeout = 60000;
server.keepAliveTimeout = 65000;

try { await vorschau.aufraeumen(); } catch (fehler) { console.error('[vorschau] Aufräumen beim Start fehlgeschlagen:', fehler.message); }
vorschau.waechter();
server.listen(PORT, () => console.log(`[server] FAH-Extraktor API auf Port ${PORT}`));

// Beim Stoppen des Containers ausstehende Sitzungsänderungen noch speichern.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    await konten.fertig().catch(() => {});
    process.exit(0);
  });
}
