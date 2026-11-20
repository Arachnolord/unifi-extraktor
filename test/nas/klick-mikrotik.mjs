// © 2026 Fabian Hammer – FAH-Extraktor. CDP-Durchklick der MikroTik-Integration: Kacheln → MikroTik →
// Backup öffnen → Baum/Suche/Hex → Rohdatei → Virtualisieren-Dialog (Polling-Schutz) → Start → Fenster
// (WebFig im iframe, Leerlauf-Befund, Handybreite) → Schließen → Beenden → Übersicht (Handybreite).
// Läuft NUR auf dem NAS (nicht in der ZIP, nie auf dem Mac):
//   docker run -d --rm --name fah-headless --network host -v /tmp/fahtest:/tmp/fahtest chromedp/headless-shell \
//     --no-sandbox --remote-debugging-address=127.0.0.1 --remote-debugging-port=9333
//   read -r PW
//   docker run --rm --network host -v /tmp/fahtest:/tmp/fahtest -e PORT=45913 -e ADMIN_NAME=fah-testadmin \
//     -e ADMIN_PW=… -e MIKROTIK_PW="$PW" node:22-alpine node /tmp/fahtest/klick-mikrotik.mjs
// Env: PORT (45913), BACKUP (/tmp/fahtest/kunde.backup – derselbe Pfad muss im headless-Container liegen),
//      MIKROTIK_USER (admin), LIMIT_S (420), AUSGABE (/tmp/fahtest, Screenshots 1-… bis 10-… .png).
// ADMIN_NAME/ADMIN_PW = Admin-Testkonto aus testkonto.mjs (nicht das Betreiberkonto). Für den
// Polling-Schutz und den Leerlauf-Befund legt das Skript ein Konto mt-klick2 an und entfernt es am Ende.
import { writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const PORT = process.env.PORT || '45913';
const SEITE = `http://127.0.0.1:${PORT}/`;
const BACKUP = process.env.BACKUP || '/tmp/fahtest/kunde.backup';
const AUSGABE = process.env.AUSGABE || '/tmp/fahtest';
const ADMIN_NAME = process.env.ADMIN_NAME || 'admin';
const ADMIN_PW = process.env.ADMIN_PW || 'admin';
const MIKROTIK_USER = process.env.MIKROTIK_USER || 'admin';
const MIKROTIK_PW = process.env.MIKROTIK_PW || '';
const LIMIT = Number(process.env.LIMIT_S || 420) * 1000;
const KACHELN = ['Aruba', 'Barracuda', 'Fortinet', 'MikroTik', 'Omada', 'Securepoint', 'UniFi'];
if (!MIKROTIK_PW) { console.log('FEHL MIKROTIK_PW fehlt (read -r PW; … -e MIKROTIK_PW="$PW")'); process.exit(2); }
const ok = (b, text) => { console.log(`${b ? 'OK  ' : 'FEHL'} ${text}`); if (!b) process.exitCode = 1; return Boolean(b); };
const info = (text) => console.log(`INFO ${text}`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// --- API-Helfer (Node-Seite, über nginx) für das Zweitkonto und den Leerlauf-Befund -----------------
async function api(pfad, { methode = 'GET', cookie = '', body, kopf = {} } = {}) {
  const res = await fetch(SEITE.replace(/\/$/, '') + pfad, {
    method: methode, redirect: 'manual', body,
    headers: { 'X-Explorer': '1', ...(cookie ? { Cookie: cookie } : {}), ...(body && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}), ...kopf }
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, cookies: res.headers.getSetCookie().map((c) => c.split(';')[0]) };
}
const anmelden = async (name, passwort) => {
  const r = await api('/_explorer/api/anmelden', { methode: 'POST', body: JSON.stringify({ name, passwort }) });
  return r.status === 200 ? r.cookies.find((c) => c.startsWith('fah_explorer=')) : null;
};

// --- CDP ------------------------------------------------------------------------------------------
const ver = await (await fetch('http://127.0.0.1:9333/json/version')).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let zaehler = 0;
const wartend = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (!m.id || !wartend.has(m.id)) return;
  const { res, rej } = wartend.get(m.id);
  wartend.delete(m.id);
  if (m.error) rej(new Error(m.error.message)); else res(m.result);
};
const cdp = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++zaehler;
  wartend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
const s = (m, p) => cdp(m, p, sessionId);
await s('Page.enable');
await s('Runtime.enable');
await s('DOM.enable');
const groesse = (width) => s('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
const js = async (ausdruck) => (await s('Runtime.evaluate', { expression: ausdruck, awaitPromise: true, returnByValue: true })).result.value;
const warte = async (ausdruck, ms = 30000) => {
  const ende = Date.now() + ms;
  while (Date.now() < ende) { if (await js(ausdruck).catch(() => false)) return true; await pause(300); }
  return false;
};
const bild = async (name) => {
  const { data } = await s('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${AUSGABE}/${name}.png`, Buffer.from(data, 'base64'));
};
// Sichtbar = hat Layout-Rechtecke (gilt auch für position:fixed, anders als offsetParent).
const sichtbar = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getClientRects().length > 0; })()`;
const anzahl = (sel) => js(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const klick = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
const tippen = (sel, wert) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.value = ${JSON.stringify(wert)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const text = (sel) => js(`(document.querySelector(${JSON.stringify(sel)})?.textContent || '').replace(/\\s+/g, ' ').trim()`);
const wert = (sel) => js(`document.querySelector(${JSON.stringify(sel)})?.value ?? null`);
const anmeldenImBrowser = () => js(`(() => { const f = document.querySelector('form'); f.querySelector('[name="name"]').value = ${JSON.stringify(ADMIN_NAME)}; f.querySelector('[name="passwort"]').value = ${JSON.stringify(ADMIN_PW)}; f.requestSubmit(); return true; })()`);

let admin = null;
let k2 = null;
async function aufraeumen() {
  try { if (k2) await api('/_explorer/api/vorschau', { methode: 'DELETE', cookie: k2 }); } catch {}
  try {
    if (admin) {
      const liste = (await api('/_explorer/api/benutzer', { cookie: admin })).json?.benutzer || [];
      for (const b of liste.filter((x) => x.name === 'mt-klick2')) await api(`/_explorer/api/benutzer/${b.id}`, { methode: 'DELETE', cookie: admin });
    }
  } catch {}
}

try {
  await groesse(1280);
  await s('Page.navigate', { url: SEITE });
  ok(await warte(`!!document.querySelector('input[name="passwort"]') || !!document.querySelector('.kachel')`), 'Anmeldeseite oder Kacheln erscheinen');
  if (await js(`!!document.querySelector('input[name="passwort"]')`)) await anmeldenImBrowser();
  else {
    // Der Testbrowser bleibt zwischen Läufen angemeldet – ein fremdes Konto zuerst abmelden.
    const wer = await text('.benutzermenue .name');
    if (wer && wer !== ADMIN_NAME) {
      info(`Browser war als „${wer}“ angemeldet – abmelden`);
      await js(`fetch('/_explorer/api/abmelden', { method: 'POST', headers: { 'X-Explorer': '1' } }).then(() => true)`);
      await s('Page.navigate', { url: SEITE });
      await warte(`!!document.querySelector('input[name="passwort"]')`);
      await anmeldenImBrowser();
    }
  }
  ok(await warte(`document.querySelectorAll('.kachel').length === 7 && document.querySelectorAll('.kachel.aktiv').length === 2`), 'Angemeldet: 7 Kacheln, davon 2 aktiv');

  // --- Kachelübersicht ---
  const namen = await js(`[...document.querySelectorAll('.kachel strong')].map((e) => e.textContent.trim())`);
  ok(JSON.stringify(namen) === JSON.stringify(KACHELN), `Reihenfolge A–Z: ${(namen || []).join(', ')}`);
  ok(JSON.stringify(await js(`[...document.querySelectorAll('.kachel.aktiv strong')].map((e) => e.textContent.trim())`)) === JSON.stringify(['MikroTik', 'UniFi']), 'aktiv: MikroTik, UniFi');
  const badges = await js(`[...document.querySelectorAll('.kachel.geplant')].map((k) => (k.disabled ? 'gesperrt:' : 'frei:') + (k.querySelector('.kachel-badge')?.textContent.trim() || ''))`);
  ok(badges.length === 5 && badges.every((b) => b === 'gesperrt:in Vorbereitung'), `5 geplante Kacheln gesperrt mit Badge „in Vorbereitung“ (${badges.join(' | ')})`);
  ok(await js(`document.querySelectorAll('.kachel-hinweis').length === 7 && [...document.querySelectorAll('.kachel-hinweis')].every((h) => h.textContent.trim().length > 20)`), 'jede Kachel hat einen Hinweis-Einzeiler');
  ok(await js(sichtbar('#kacheln')) && !(await js(sichtbar('#drop'))) && !(await js(sichtbar('#workspace'))), 'Startzustand: Kacheln sichtbar, Drop-Zone und Arbeitsbereich versteckt');
  await bild('1-kacheln');
  await klick('[data-i="mikrotik"]');
  ok(await warte(sichtbar('#drop')) && !(await js(sichtbar('#kacheln'))), 'MikroTik-Kachel öffnet die Drop-Zone');
  ok(await js(`['.backup', '.rsc'].every((e) => (document.querySelector('#picker').accept || '').includes(e))`), 'Dateiauswahl erlaubt .backup/.rsc');
  ok(/MikroTik/.test(await text('#drop h1')), `Überschrift „${await text('#drop h1')}“`);
  ok(await js(`!!document.querySelector('#drop #zur-uebersicht')`), 'Knopf „Zur Übersicht“ in der Drop-Zone');

  // --- Backup öffnen ---
  const { root } = await s('DOM.getDocument', { depth: 1 });
  const { nodeId } = await s('DOM.querySelector', { nodeId: root.nodeId, selector: '#picker' });
  await s('DOM.setFileInputFiles', { nodeId, files: [BACKUP] });
  ok(await warte(`${sichtbar('#workspace')} && !!document.querySelector('#nav button[data-id="baum"]')`, 60000), 'Backup geöffnet (Arbeitsbereich mit Baum-Knopf)');
  ok(/kunde\.backup/.test(await text('#file-info')) && /RouterOS/.test(await text('#file-info')), `Dateiinfo: ${await text('#file-info')}`);
  const nav = await js(`[...document.querySelectorAll('#nav button')].map((b) => b.dataset.id + '=' + b.textContent.trim())`);
  ok(nav.some((n) => /^baum=Baum \(\d+ Rubriken\)$/.test(n)) && nav.some((n) => n.startsWith('rohdatei=')) && nav.some((n) => n === 'vorschau=Virtualisieren'), `Navigation: ${nav.join(' | ')}`);
  ok(/Rubriken/.test(await text('#content .cards')) && /RouterOS/.test(await text('#content')), 'Übersicht mit Kennzahlen und erkannter Version');
  ok(await js(`!!document.querySelector('#content .vorschau-karte button') && !document.querySelector('#chr-dialog')`), 'Übersicht: Karte „Als CHR virtuell öffnen“, kein Autostart');
  await bild('2-uebersicht');

  // --- Baum: Rubriken, Suche, Datensatz mit Feldern und Hex, Volltext ---
  await klick('#nav button[data-id="baum"]');
  ok(await warte(`document.querySelectorAll('.collections button').length > 100`), `Baum: ${await anzahl('.collections button')} Rubriken`);
  await tippen('#rubrik-suche', 'addrs');
  const sichtbare = await js(`[...document.querySelectorAll('.collections button')].filter((b) => !b.hidden && b.getClientRects().length > 0).map((b) => b.dataset.r)`);
  ok(sichtbare.length >= 1 && sichtbare.every((r) => /addrs/.test(r)), `Rubrik-Suche „addrs“: ${sichtbare.join(', ')}`);
  await js(`[...document.querySelectorAll('.collections button')].find((b) => b.dataset.r === 'net/addrs')?.click()`);
  ok(await warte(`document.querySelectorAll('#docs details').length >= 1 && document.querySelector('.collections button[data-r="net/addrs"]')?.classList.contains('active')`), `net/addrs: ${await anzahl('#docs details')} Datensätze, Rubrik aktiv`);
  await js(`document.querySelector('#docs details').open = true`);
  ok((await anzahl('#docs details .table div')) >= 1 && (await anzahl('#docs details .hex-block')) >= 1, 'Datensatz zeigt Felder und Rohdaten-Block');
  ok(/^00000000/.test(await text('#docs details .hex-block pre.hex')), 'Hex-Ansicht beginnt mit Offset 00000000');
  ok(/Datensatz 1/.test(await text('#docs details summary')), `Summary: ${await text('#docs details summary')}`);
  await tippen('#doc-search', '192.168');
  ok(await warte(`document.querySelectorAll('#docs details').length >= 1 && (document.querySelector('#docs')?.textContent || '').includes('192.168')`), `Volltextsuche „192.168“: ${await anzahl('#docs details')} Treffer`);
  await tippen('#doc-search', 'gibtesnicht-xyz');
  ok(await warte(`!!document.querySelector('#docs .empty')`), 'ohne Treffer: Hinweis „Keine Treffer“');
  await tippen('#doc-search', '');
  ok(await js(`!!document.querySelector('#json-export')`), 'JSON-Export-Knopf vorhanden');
  await bild('3-baum');
  await klick('#nav button[data-id="rohdatei"]');
  ok(await warte(`/^00000000/.test(document.querySelector('#content pre.hex')?.textContent || '')`), 'Rohdatei (Hex) der ganzen Datei');

  // --- Virtualisieren-Dialog ---
  await klick('#nav button[data-id="vorschau"]');
  ok(await warte(sichtbar('#chr-dialog')), 'Virtualisieren-Dialog sichtbar');
  ok(/RouterOS 7/.test(await text('#chr-dialog')), `Erkannt: ${(await text('#chr-dialog')).slice(0, 90)}`);
  ok(await warte(`document.querySelectorAll('#chr-version option').length >= 1 && /^7\\./.test(document.querySelector('#chr-version').value)`, 30000),
    `CHR-Version vorbelegt: ${await wert('#chr-version')} (${await anzahl('#chr-version option')} Optionen)`);
  ok(await js(`[...document.querySelectorAll('#chr-version option')].some((o) => o.value === 'andere')`), 'Option „Andere Version …“ vorhanden');
  ok(await js(`document.querySelector('input[name="zugang"][value="lokal"]')?.checked === true`), 'Zugang „Lokal“ vorausgewählt');
  ok(/^192\.168\.250\.1/.test((await wert('#zugang-ip')) || ''), `Zugangsadresse: ${await wert('#zugang-ip')}`);
  ok((await anzahl('#chr-dialog .feld-hilfe')) >= 3, `${await anzahl('#chr-dialog .feld-hilfe')} Hilfetexte (jede Einstellung erklärt)`);
  ok(await js(`!document.querySelector('#chr-dialog input[name="backupPasswort"]')`), 'kein Backup-Passwort-Feld bei Klartext-Backup');
  await tippen('#chr-dialog input[name="benutzer"]', MIKROTIK_USER);
  await tippen('#chr-dialog input[name="passwort"]', MIKROTIK_PW);
  await bild('4-dialog');

  // --- Polling-Schutz (Kritik 18/27): getippte Werte überleben Status-Änderungen anderer Konten ---
  await js(`document.querySelector('#chr-dialog').dataset.fahMarke = 'vorher'`);
  const versionVorher = await wert('#chr-version');
  admin = await anmelden(ADMIN_NAME, ADMIN_PW);
  if (admin) {
    const pw2 = randomBytes(12).toString('base64url');
    const r = await api('/_explorer/api/benutzer', { methode: 'POST', cookie: admin, body: JSON.stringify({ name: 'mt-klick2', passwort: pw2, rolle: 'benutzer' }) });
    if (r.status === 409) {
      const alt = ((await api('/_explorer/api/benutzer', { cookie: admin })).json?.benutzer || []).find((b) => b.name === 'mt-klick2');
      if (alt) await api(`/_explorer/api/benutzer/${alt.id}`, { methode: 'PATCH', cookie: admin, body: JSON.stringify({ passwort: pw2 }) });
    }
    k2 = await anmelden('mt-klick2', pw2);
  }
  const dialogIntakt = async () => (await js(`document.querySelector('#chr-dialog')?.dataset.fahMarke`)) === 'vorher'
    && (await wert('#chr-dialog input[name="passwort"]')) === MIKROTIK_PW && (await wert('#chr-version')) === versionVorher;
  if (k2) {
    const fremd = await api('/_explorer/api/vorschau?art=mikrotik', {
      methode: 'POST', cookie: k2, body: readFileSync(BACKUP),
      kopf: { 'Content-Type': 'application/octet-stream', 'X-Backup-Name': encodeURIComponent('fremd.backup'),
        'X-Vorschau-Optionen': encodeURIComponent(JSON.stringify({ dateiart: 'backup', chrVersion: versionVorher, benutzer: 'admin', passwort: 'Wegwerf-1', zugang: { modus: 'lokal', ip: '192.168.250.1', prefix: 24 } })) }
    });
    ok(fremd.status === 202, `Fremdes Konto startet währenddessen eine Vorschau (HTTP ${fremd.status}) – „belegt“ ändert sich`);
    await pause(12000);
    ok(await dialogIntakt(), 'nach 12 s (ein Poll mit geänderter Belegung): Dialog, Passwort und Versionswahl unverändert');
    info(`Belegt-Zeile: ${(await text('#chr-belegt')) || '(kein #chr-belegt)'}`);
    const weg = await api('/_explorer/api/vorschau', { methode: 'DELETE', cookie: k2 });
    ok(weg.status === 200 && weg.json?.aktiv === false, 'fremde Vorschau wieder beendet');
    await pause(12000);
    ok(await dialogIntakt(), 'nach weiteren 12 s (Belegung wieder frei): Dialog weiterhin unverändert');
  } else {
    info('Zweitkonto nicht möglich (Admin-Anmeldung per API fehlgeschlagen) – nur Wartezeit-Prüfung');
    await pause(12000);
    ok(await dialogIntakt(), 'nach 12 s (ein Poll): Passwort und Versionswahl unverändert');
  }

  // --- Start und Lauf ---
  const t0 = Date.now();
  await klick('#chr-dialog button[type="submit"]');
  let zeile = '';
  let ergebnis = '';
  let laufBild = false;
  while (Date.now() - t0 < LIMIT) {
    if (await js(`!!document.querySelector('.vorschau-bereit')`)) { ergebnis = 'bereit'; break; }
    if (await js(`!!document.querySelector('.vorschau-fehler')`)) { ergebnis = 'fehler'; break; }
    const neu = await js(`[...document.querySelectorAll('ol.schritte li')].map((li) => li.className + (li.querySelector('small') ? ' (' + li.querySelector('small').textContent.trim() + ')' : '')).join(' | ')`);
    if (neu && neu !== zeile) {
      console.log(`     ${String(Math.round((Date.now() - t0) / 1000)).padStart(4)} s  ${neu}`);
      zeile = neu;
      if (!laufBild) { laufBild = true; await bild('5-lauf'); }
    }
    await pause(3000);
  }
  ok(ergebnis === 'bereit', `Vorschau bereit nach ${Math.round((Date.now() - t0) / 1000)} s`);
  if (ergebnis !== 'bereit') {
    console.log(`     ${await text('.vorschau-fehler')}\n${await text('#vorschau-inhalt details pre')}`);
    await bild('5-fehler');
    throw new Error('Vorschau nicht bereit');
  }

  // --- Bereit-Ansicht ---
  const bereitText = await text('.vorschau-bereit');
  ok(/RouterOS/.test(bereitText) && /CHR/.test(bereitText), `Bereit-Zeile: ${bereitText}`);
  ok(await js(`!!document.querySelector('#vorschau-inhalt [data-v="fenster"]') && !!document.querySelector('#vorschau-inhalt a[href="/_explorer/api/vorschau/oeffnen"][target="_blank"]')`), 'Knöpfe „Im Fenster öffnen“ und „Neuer Tab“');
  ok((await anzahl('#vorschau-inhalt .vorschau-info code')) >= 2, 'Zugangsdaten (Benutzer/Passwort) sichtbar');
  const sicher = await js('window.isSecureContext');
  const kopieren = await anzahl('#vorschau-inhalt .kopieren');
  ok(sicher ? kopieren >= 2 : kopieren === 0, `Kopier-Knöpfe: ${kopieren} (${sicher ? 'sicherer Kontext' : 'unsicherer Kontext → keine'})`);
  ok(/Endet \d+ Minuten/.test(await text('#vorschau-inhalt .vorschau-info')), 'Hinweis zur Laufzeit');
  ok(/Ablauf/.test(await text('#vorschau-inhalt details summary')), 'Ablauf-Details vorhanden');
  await bild('6-bereit');

  // --- Fenster ---
  await klick('#vorschau-inhalt [data-v="fenster"]');
  ok(await warte(`${sichtbar('#vorschau-fenster')} && !!document.querySelector('#vorschau-fenster iframe.fenster-rahmen')`), 'Fenster mit iframe geöffnet');
  ok(/WebFig/.test(await text('#vorschau-fenster .fenster-kopf')) && /kunde\.backup/.test(await text('#vorschau-fenster .fenster-titel')), `Fensterkopf: ${await text('#vorschau-fenster .fenster-kopf')}`);
  ok(await js(`['neu', 'schliessen', 'ende'].every((f) => !!document.querySelector('#vorschau-fenster [data-f="' + f + '"]')) && !!document.querySelector('#vorschau-fenster a[target="_blank"]')`), 'Fensterknöpfe: Neuer Tab, Neu laden, Schließen, Beenden');
  ok(await warte(`(() => { try { const d = document.querySelector('#vorschau-fenster iframe').contentDocument; return !!d && /RouterOS/.test(d.title) && d.location.pathname === '/webfig/'; } catch (e) { return false; } })()`, 30000),
    `WebFig im Frame: Titel „${await js(`document.querySelector('#vorschau-fenster iframe')?.contentDocument?.title`)}“, Pfad ${await js(`document.querySelector('#vorschau-fenster iframe')?.contentDocument?.location.pathname`)}`);
  await pause(3000);
  await bild('7-fenster');

  // --- Leerlauf-Befund (Kritik 8/28): schickt WebFig im Leerlauf Anfragen über den Proxy? ---
  if (k2) {
    const akt = async () => ((await api('/_explorer/api/vorschau', { cookie: k2 })).json?.andere || []).find((a) => a.gestartetVon === ADMIN_NAME);
    const a0 = await akt();
    await pause(25000);
    const a1 = await akt();
    if (a0 && a1) {
      const plus = Math.round((a1.letzteAktivitaet - a0.letzteAktivitaet) / 1000);
      info(`WebFig-Leerlauf 25 s: letzteAktivitaet ${plus > 0 ? `gestiegen (+${plus} s) → WebFig pollt über den Proxy, Puls entbehrlich` : 'unverändert → Puls nötig'}; offeneSockets=${a1.offeneSockets}`);
    } else info('Leerlauf-Befund nicht möglich (Lauf in „andere“ nicht gefunden)');
  }

  // --- Handybreite mit offenem Fenster, Schließen, Beenden, Übersicht ---
  await groesse(390);
  await pause(500);
  ok(await js(`Math.round(document.querySelector('#vorschau-fenster').getBoundingClientRect().width) >= 380 && document.documentElement.scrollWidth <= 390`), 'Handy-Breite: Fenster volle Breite, kein Querscrollen');
  await bild('8-fenster-handy');
  await groesse(1280);
  await pause(300);
  await klick('#vorschau-fenster [data-f="schliessen"]');
  ok(await warte(`!${sichtbar('#vorschau-fenster')} && !document.querySelector('#vorschau-fenster iframe')`), 'Schließen: Fenster zu, iframe entfernt');
  ok(await js(`!!document.querySelector('.vorschau-bereit')`), 'Vorschau läuft nach dem Schließen weiter');
  const ende = '#vorschau-inhalt [data-v="ende"]';
  await klick(ende);
  if (/Wirklich/.test(await text(ende))) { ok(true, 'Beenden fragt „Wirklich beenden?“ (zwei Klicks)'); await klick(ende); }
  ok(await warte(sichtbar('#chr-dialog'), 30000), 'Beendet: Dialog erscheint wieder (Lauf inaktiv)');
  await bild('9-beendet');
  await klick('#workspace #zur-uebersicht');
  ok(await warte(`${sichtbar('#kacheln')} && !${sichtbar('#workspace')}`), '„Zur Übersicht“: Kacheln sichtbar, Arbeitsbereich versteckt');
  await groesse(390);
  await pause(500);
  const spuren = await js(`getComputedStyle(document.querySelector('.kacheln')).gridTemplateColumns.trim().split(/\\s+/).length`);
  ok(spuren === 1 && (await js(`document.documentElement.scrollWidth <= 390`)), `Handy-Breite: Kacheln einspaltig (${spuren} Spur), kein Querscrollen`);
  await bild('10-kacheln-handy');
  await groesse(1280);
} catch (f) {
  ok(false, `Abbruch: ${f.message}`);
} finally {
  await aufraeumen();
  console.log(`     Screenshots unter ${AUSGABE}`);
  process.exit();
}
