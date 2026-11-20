// © 2026 Fabian Hammer – FAH-Extraktor. E2E-Test der MikroTik-Vorschau – läuft IM API-Container
// (nicht in der ZIP, nie auf dem Mac):
//   docker exec unifi-backup-explorer-api mkdir -p /tmp/fahtest
//   docker cp /home/benutzer/chr-test/kunde.backup unifi-backup-explorer-api:/tmp/fahtest/kunde.backup
//   docker cp /tmp/fahtest/mikrotik.mjs unifi-backup-explorer-api:/tmp/fahtest/
//   read -r PW        (Router-Passwort des Backups – nur so, nie in Dateien)
//   docker exec -e ADMIN_NAME=fah-testadmin -e ADMIN_PW=… -e MIKROTIK_PW="$PW" -w /app \
//     unifi-backup-explorer-api node /tmp/fahtest/mikrotik.mjs start
//   … Vorschau bleibt für Sichtprüfung/klick-Test stehen …
//   docker exec -e ADMIN_NAME=fah-testadmin -e ADMIN_PW=… -w /app unifi-backup-explorer-api node /tmp/fahtest/mikrotik.mjs ende
// Env: MIKROTIK_BACKUP (Pfad, Standard /tmp/fahtest/kunde.backup), MIKROTIK_USER (admin),
//      CHR_VERSION (7.24.5, muss im Cache liegen), ZUGANG=lokal|wan (lokal), ZUGANG_IP (192.168.250.1),
//      LIMIT_S (420 lokal / 600 wan). ADMIN_* = Admin-Testkonto aus testkonto.mjs.
// Legt die Konten mt-test1 (startet die Vorschau) und mt-test2 (fremdes Konto) an; „ende“ räumt beides weg.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { eigeneContainer } from '/app/server/docker.js';

const BASIS = 'http://127.0.0.1:3000';
const PW = randomBytes(12).toString('base64url');
const ZUGANG = process.env.ZUGANG === 'wan' ? 'wan' : 'lokal';
const ZUGANG_IP = process.env.ZUGANG_IP || '192.168.250.1';
const CHR_VERSION = process.env.CHR_VERSION || '7.24.5';
const BENUTZER = process.env.MIKROTIK_USER || 'admin';
const LIMIT = Number(process.env.LIMIT_S || (ZUGANG === 'wan' ? 600 : 420)) * 1000;
const ok = (b, text) => { console.log(`${b ? 'OK  ' : 'FEHL'} ${text}`); if (!b) process.exitCode = 1; return Boolean(b); };
const info = (text) => console.log(`INFO ${text}`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const sek = (ms) => `${(ms / 1000).toFixed(1)} s`;

async function anfrage(pfad, { methode = 'GET', cookie = '', body, kopf = {} } = {}) {
  const res = await fetch(BASIS + pfad, {
    method: methode, redirect: 'manual', body,
    headers: { 'X-Explorer': '1', ...(cookie ? { Cookie: cookie } : {}), ...(body && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}), ...kopf }
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, kopf: Object.fromEntries(res.headers), cookies: res.headers.getSetCookie().map((c) => c.split(';')[0]) };
}
const anmelden = async (name, passwort) => {
  const r = await anfrage('/_explorer/api/anmelden', { methode: 'POST', body: JSON.stringify({ name, passwort }) });
  return r.status === 200 ? r.cookies.find((c) => c.startsWith('fah_explorer=')) : null;
};

const modus = process.argv[2];
if (!['start', 'ende'].includes(modus)) { console.log('Aufruf: node mikrotik.mjs start|ende'); process.exit(2); }
const admin = await anmelden(process.env.ADMIN_NAME || 'admin', process.env.ADMIN_PW || 'admin');
if (!admin) { console.log('FEHL Admin-Anmeldung (ADMIN_NAME/ADMIN_PW – Testkonto mit testkonto.mjs anlegen)'); process.exit(2); }

// Testkonto anlegen (bleibt eines aus einem abgebrochenen Lauf stehen: Passwort neu setzen) und anmelden.
async function kontoAnlegen(name) {
  const r = await anfrage('/_explorer/api/benutzer', { methode: 'POST', cookie: admin, body: JSON.stringify({ name, passwort: PW, rolle: 'benutzer' }) });
  if (r.status === 409) {
    const alt = ((await anfrage('/_explorer/api/benutzer', { cookie: admin })).json?.benutzer || []).find((b) => b.name === name);
    if (alt) await anfrage(`/_explorer/api/benutzer/${alt.id}`, { methode: 'PATCH', cookie: admin, body: JSON.stringify({ passwort: PW }) });
  }
  return anmelden(name, PW);
}

if (modus === 'start') {
  if (!process.env.MIKROTIK_PW) { console.log('FEHL MIKROTIK_PW fehlt (read -r PW; docker exec -e MIKROTIK_PW="$PW" …)'); process.exit(2); }
  const backup = readFileSync(process.env.MIKROTIK_BACKUP || '/tmp/fahtest/kunde.backup');
  const k1 = await kontoAnlegen('mt-test1');
  const k2 = await kontoAnlegen('mt-test2');
  if (!ok(k1 && k2, 'Testkonten mt-test1/mt-test2 angelegt und angemeldet')) process.exit(2);

  // 1) Einstellungen (Kritik 27): Standard-Zugang setzen, Registrierung bleibt unverändert.
  const vorher = (await anfrage('/_explorer/api/einstellungen', { cookie: admin })).json;
  ok(vorher && typeof vorher.registrierung === 'boolean' && vorher.mikrotikZugang && 'benutzer' in vorher.mikrotikZugang,
    `GET einstellungen: registrierung=${vorher?.registrierung}, mikrotikZugang vorhanden`);
  const gesetzt = await anfrage('/_explorer/api/einstellungen', { methode: 'PUT', cookie: admin, body: JSON.stringify({ mikrotikZugang: { benutzer: 'fah-test', passwort: 'nur-test' } }) });
  ok(gesetzt.status === 200 && gesetzt.json?.mikrotikZugang?.benutzer === 'fah-test' && gesetzt.json?.registrierung === vorher?.registrierung,
    `PUT einstellungen {mikrotikZugang}: HTTP ${gesetzt.status}, Antwort = Gesamtstand, registrierung unverändert (${gesetzt.json?.registrierung})`);
  const nachher = (await anfrage('/_explorer/api/einstellungen', { cookie: admin })).json;
  ok(nachher?.registrierung === vorher?.registrierung && nachher?.mikrotikZugang?.passwort === 'nur-test', 'GET einstellungen danach: registrierung unverändert, Zugang gespeichert');
  ok((await anfrage('/_explorer/api/benutzer', { cookie: admin })).json?.mikrotikZugang?.benutzer === 'fah-test', 'GET benutzer liefert mikrotikZugang mit');
  ok((await anfrage('/_explorer/api/einstellungen', { cookie: k1 })).status === 403, 'Benutzer darf die Einstellungen nicht lesen (403)');

  // 2) Vorbereitung als Benutzer: Vorschlag, Kanäle, lokale Versionen, Vorbelegung des Zugangs.
  const vb = await anfrage('/_explorer/api/mikrotik/vorbereitung?hauptversion=7&mindestens=7.22', { cookie: k1 });
  const v = vb.json || {};
  ok(vb.status === 200 && /^7\.\d+/.test(v.vorschlag || ''), `vorbereitung: Vorschlag ${v.vorschlag} (Quelle ${v.quelle}, Hinweis ${v.hinweis ?? '–'})`);
  ok(Array.isArray(v.lokal) && v.lokal.includes(CHR_VERSION), `lokale Versionen ${JSON.stringify(v.lokal)} enthalten ${CHR_VERSION}`);
  ok(Array.isArray(v.kanaele) && v.kanaele.some((k) => k.kanal === 'stable' && /^7\./.test(k.version)),
    `Kanäle: ${(v.kanaele || []).map((k) => `${k.kanal}=${k.version}`).join(' ') || '(keine – offline?)'}`);
  ok(v.zugang?.benutzer === 'fah-test' && v.zugang?.passwort === 'nur-test', 'Standard-Zugang wird jedem angemeldeten Konto vorbelegt');
  ok(v.image === true, `Vorschau-Image vorhanden (image=${v.image})`);
  ok(v.kvm === null && typeof v.max === 'number' && typeof v.belegt === 'number', `kvm=${v.kvm}, max=${v.max}, belegt=${v.belegt}`);
  // Standard-Zugang zurücksetzen – nie Testwerte in der Produktivdatei lassen.
  const zurueck = await anfrage('/_explorer/api/einstellungen', { methode: 'PUT', cookie: admin, body: JSON.stringify({ mikrotikZugang: vorher?.mikrotikZugang || { benutzer: '', passwort: '' } }) });
  ok(zurueck.status === 200 && zurueck.json?.mikrotikZugang?.benutzer === (vorher?.mikrotikZugang?.benutzer || ''), 'Standard-Zugang wiederhergestellt');

  // 3) Abgelehnte Starts (mt-test2) – erzeugen keinen Lauf.
  const zugang = ZUGANG === 'wan' ? { modus: 'wan', ip: '', prefix: null } : { modus: 'lokal', ip: ZUGANG_IP, prefix: 24 };
  const optionen = (aenderung = {}) => encodeURIComponent(JSON.stringify({ dateiart: 'backup', chrVersion: CHR_VERSION, benutzer: BENUTZER, passwort: process.env.MIKROTIK_PW, zugang, ...aenderung }));
  const start = (cookie, opt, art = 'mikrotik') => anfrage(`/_explorer/api/vorschau?art=${art}`, {
    methode: 'POST', cookie, body: backup,
    kopf: { 'Content-Type': 'application/octet-stream', 'X-Backup-Name': encodeURIComponent('kunde.backup'), ...(opt === null ? {} : { 'X-Vorschau-Optionen': opt }) }
  });
  for (const [text, opt, art] of [['RouterOS 6', optionen({ chrVersion: '6.49.23' })], ['Benutzer admin+x', optionen({ benutzer: 'admin+x' })], ['ohne Optionen-Kopf', null], ['unbekannte Art', optionen(), 'fritz']]) {
    const r = await start(k2, opt, art);
    ok(r.status === 400 && typeof r.json?.fehler === 'string', `Start abgelehnt (${text}): HTTP ${r.status} – ${r.json?.fehler || r.text.slice(0, 80)}`);
  }
  ok(!(await anfrage('/_explorer/api/vorschau', { cookie: k2 })).json?.aktiv, 'abgelehnte Starts erzeugen keinen Lauf');

  // 4) Echter Start als mt-test1.
  const t0 = Date.now();
  const s0 = await start(k1, optionen());
  ok(s0.status === 202 && s0.json?.art === 'mikrotik' && s0.json?.aktiv === true && s0.json?.name === 'kunde.backup',
    `Start angenommen: HTTP ${s0.status}, art=${s0.json?.art}, phase=${s0.json?.phase}${s0.json?.fehler ? ' – ' + JSON.stringify(s0.json.fehler) : ''}`);
  ok((s0.json?.schritte || []).map((x) => x.key).join(',') === 'vorbereiten,laden,starten,einspielen,anmelden', 'Schritt-Keys wie bei UniFi');
  const s2 = (await anfrage('/_explorer/api/vorschau', { cookie: k2 })).json || {};
  const fremd = (s2.andere || []).find((a) => a.gestartetVon === 'mt-test1');
  ok(fremd && fremd.art === 'mikrotik' && !JSON.stringify(s2.andere).includes('passwort'), 'Fremdes Konto sieht den MikroTik-Lauf in „andere“ (mit art, ohne Zugangsdaten)');
  const vb2 = (await anfrage('/_explorer/api/mikrotik/vorbereitung?hauptversion=7', { cookie: k2 })).json || {};
  ok(vb2.belegt === (s2.andere || []).length && vb2.max === s2.max, `vorbereitung.belegt (${vb2.belegt}) = andere.length, max ${vb2.max} gilt für beide Arten zusammen`);
  ok((await anfrage(`/_explorer/api/vorschau?id=${encodeURIComponent(fremd?.id || '')}`, { methode: 'DELETE', cookie: k2 })).status === 403, 'Benutzer darf fremde Vorschau nicht beenden (403)');

  // 5) Warten bis bereit – Phasenwechsel mit Zeiten protokollieren.
  let stand = s0.json || {};
  let zeile = '';
  const zeiten = {};
  while (Date.now() - t0 < LIMIT) {
    stand = (await anfrage('/_explorer/api/vorschau', { cookie: k1 })).json || {};
    const neu = `${stand.phase} | ${(stand.schritte || []).map((x) => `${x.key}:${x.status}${x.detail ? ` (${x.detail})` : ''}`).join(' ')}`;
    if (neu !== zeile) { console.log(`     ${String(Math.round((Date.now() - t0) / 1000)).padStart(4)} s  ${neu}`); zeile = neu; zeiten[stand.phase] ??= Date.now() - t0; }
    if (['bereit', 'fehler'].includes(stand.phase)) break;
    await pause(2000);
  }
  const dauer = Date.now() - t0;
  if (stand.phase === 'fehler') {
    console.log(`FEHL Vorschau fehlgeschlagen nach ${sek(dauer)}: ${stand.fehler?.text}\n${stand.fehler?.log || ''}`);
    process.exitCode = 1;
    process.exit();
  }
  ok(stand.phase === 'bereit', `bereit nach ${sek(dauer)} (Soll ≈ 45–60 s bei Cache-Treffer; Phasen: ${Object.entries(zeiten).map(([p, t]) => `${p}@${Math.round(t / 1000)}s`).join(' ')})`);
  ok((stand.schritte || []).every((x) => x.status === 'fertig'), 'alle Schritte fertig');
  const mt = stand.mikrotik || {};
  ok(stand.zugang?.benutzer === BENUTZER && stand.zugang?.passwort === process.env.MIKROTIK_PW && typeof stand.zugang?.hinweis === 'string', 'zugang: Benutzer/Passwort des Backups + Hinweis');
  ok(typeof mt.identitaet === 'string' && mt.identitaet.length > 0, `identitaet „${mt.identitaet}“, RouterOS ${mt.routerosVersion}, CHR ${mt.chrVersion}`);
  ok(mt.chrVersion === CHR_VERSION, `CHR-Version ${mt.chrVersion} = angefordert ${CHR_VERSION}`);
  ok(Number.isInteger(mt.wwwPort) && mt.modus === ZUGANG && typeof mt.zugangIp === 'string' && mt.zugangIp.length > 0,
    `WebFig ${mt.modus} ${mt.zugangIp}:${mt.wwwPort} über ${mt.traeger}, kvm=${mt.kvm}`);
  ok(ZUGANG !== 'lokal' || mt.zugangIp === ZUGANG_IP, 'zugangIp = gewählte Adresse');
  ok(typeof mt.kvm === 'boolean' && Array.isArray(mt.hinweise), `Hinweise: ${(mt.hinweise || []).join(' | ') || '–'}`);
  ok(!JSON.stringify([stand.schritte, stand.fehler, stand.mikrotik]).includes(process.env.MIKROTIK_PW), 'Passwort steht nicht in Schritten, Log oder mikrotik-Block');

  // 6) WebFig und REST durch den Proxy, Öffnen-Weiterleitungen, Puls.
  const wf = await anfrage('/webfig/', { cookie: k1, kopf: { Accept: 'text/html' } });
  ok(wf.status === 200 && /routeros|webfig/i.test(wf.text), `GET /webfig/ → ${wf.status}, ${wf.text.length} Byte`);
  ok(!('x-frame-options' in wf.kopf), 'kein x-frame-options');
  ok(/frame-ancestors 'self'/.test(wf.kopf['content-security-policy'] || ''), `CSP: ${wf.kopf['content-security-policy'] || '(keine)'}`);
  const wurzel = await anfrage('/', { cookie: k1, kopf: { Accept: 'text/html' } });
  ok(wurzel.status === 200 && /routeros/i.test(wurzel.text), `GET / (Catch-all) → ${wurzel.status}`);
  const auth = 'Basic ' + Buffer.from(`${BENUTZER}:${process.env.MIKROTIK_PW}`).toString('base64');
  const rest = await anfrage('/rest/system/identity', { cookie: k1, kopf: { Authorization: auth } });
  ok(rest.status === 200 && rest.json?.name === mt.identitaet, `REST /rest/system/identity → ${rest.status} ${rest.text.slice(0, 80)}`);
  const oe = await anfrage('/_explorer/api/vorschau/oeffnen?eingebettet=1', { cookie: k1 });
  ok(oe.status === 302 && oe.kopf.location === '/webfig/' && !oe.cookies.some((c) => c.startsWith('unifises=')), `oeffnen?eingebettet=1 → ${oe.status} ${oe.kopf.location}`);
  const oe2 = await anfrage('/_explorer/api/vorschau/oeffnen', { cookie: k1 });
  ok(oe2.status === 302 && oe2.kopf.location === '/webfig/', `oeffnen → ${oe2.status} ${oe2.kopf.location}`);
  const ohne = await anfrage('/webfig/', { kopf: { Accept: 'text/html' } });
  ok((ohne.status === 302 && /anmeldung/.test(ohne.kopf.location || '')) || ohne.status === 401, `ohne Sitzung: ${ohne.status} ${ohne.kopf.location || ''}`);
  const keine = await anfrage('/_explorer/api/vorschau/oeffnen?eingebettet=1', { cookie: k2 });
  ok(keine.status === 200 && /text\/html/.test(keine.kopf['content-type'] || '') && /Keine/.test(keine.text) && !/href="\/"/.test(keine.text),
    `ohne Lauf, eingebettet: ${keine.status} Hinweis ohne Link auf /`);
  const keine2 = await anfrage('/_explorer/api/vorschau/oeffnen', { cookie: k2 });
  ok(keine2.status === 302 && keine2.kopf.location === '/', `ohne Lauf: ${keine2.status} → ${keine2.kopf.location}`);
  ok((await anfrage('/_explorer/api/vorschau/puls', { methode: 'POST', cookie: k1 })).status === 204, 'puls → 204');
  ok((await anfrage('/_explorer/api/vorschau/puls', { methode: 'POST', cookie: k2 })).status === 204, 'puls ohne eigenen Lauf → 204');

  // 7) Leerlauf-Baseline (Kritik 8/28): ohne Browser darf letzteAktivitaet nicht steigen.
  const akt = async () => ((await anfrage('/_explorer/api/vorschau', { cookie: k2 })).json?.andere || []).find((a) => a.gestartetVon === 'mt-test1')?.letzteAktivitaet;
  const a0 = await akt();
  await pause(15000);
  const a1 = await akt();
  info(`letzteAktivitaet ohne Browser (15 s): ${a0 === a1 ? 'unverändert' : `gestiegen (+${Math.round((a1 - a0) / 1000)} s)`} – der WebFig-Leerlauf-Befund kommt aus klick-mikrotik.mjs`);
  info(`offeneSockets=${stand.offeneSockets} (WebFig hat keinen WebSocket)`);
  console.log('     Vorschau von mt-test1 bleibt stehen – Sichtprüfung/klick-Test möglich; danach: node mikrotik.mjs ende');
  process.exit();
}

if (modus === 'ende') {
  const s = (await anfrage('/_explorer/api/vorschau', { cookie: admin })).json || {};
  const laeufe = [...(s.andere || []), ...(s.aktiv ? [s] : [])].filter((l) => /^mt-test\d+$/.test(l.gestartetVon || ''));
  for (const l of laeufe) {
    const r = await anfrage(`/_explorer/api/vorschau?id=${encodeURIComponent(l.id)}`, { methode: 'DELETE', cookie: admin });
    ok(r.status === 200, `Vorschau von ${l.gestartetVon} (${l.art || 'unifi'}) beendet (HTTP ${r.status})`);
  }
  if (!laeufe.length) info('kein Testlauf aktiv');
  const danach = (await anfrage('/_explorer/api/vorschau', { cookie: admin })).json || {};
  ok(!(danach.andere || []).some((l) => /^mt-test\d+$/.test(l.gestartetVon || '')), 'keine Testläufe mehr in der Belegung');
  await pause(3000);
  const container = await eigeneContainer();
  const reste = container.filter((c) => laeufe.some((l) => c.Labels?.['fah.unifi-vorschau.lauf'] === l.id));
  const chr = container.filter((c) => (c.Names || []).some((n) => n.includes('-chr-')));
  ok(reste.length === 0, `keine Container der Testläufe mehr (${container.length} Vorschau-Container insgesamt, davon ${chr.length} CHR)`);
  const liste = (await anfrage('/_explorer/api/benutzer', { cookie: admin })).json?.benutzer || [];
  for (const b of liste.filter((x) => /^mt-test\d+$/.test(x.name))) {
    const r = await anfrage(`/_explorer/api/benutzer/${b.id}`, { methode: 'DELETE', cookie: admin });
    ok(r.status === 200, `Konto ${b.name} gelöscht (HTTP ${r.status})`);
  }
}
