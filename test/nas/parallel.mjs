// E2E-Test parallele Vorschauen – läuft im API-Container: node /tmp/uxtest/parallel.mjs start|ende
// Startet so viele Vorschauen wie die Grenze erlaubt (VORSCHAU_MAX), jede unter einem eigenen
// Testkonto; ein weiteres Konto muss abgewiesen werden. Backups aus /tmp/uxtest/*.unifi werden
// reihum verwendet, der Anzeigename ist je Konto eindeutig.
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { openBackup } from '/app/src/backup.js';
import { netzwerkPaket } from '/app/src/vorschau-paket.js';

const BASIS = 'http://127.0.0.1:3000';
const PW = 'TestPasswort-2026!';
const ok = (b, text) => { console.log(`${b ? 'OK  ' : 'FEHL'} ${text}`); if (!b) process.exitCode = 1; };

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

const admin = await anmelden(process.env.ADMIN_NAME || 'admin', process.env.ADMIN_PW || 'admin');
if (!admin) { console.log('FEHL Admin-Anmeldung'); process.exit(2); }
const MAX = (await anfrage('/_explorer/api/vorschau', { cookie: admin })).json.max;
// Konten 1..MAX starten je eine Vorschau, Konto MAX+1 wird abgewiesen.
const NAMEN = Array.from({ length: MAX + 1 }, (_, i) => `ux-test${i + 1}`);
const STARTER = NAMEN.slice(0, MAX);
const LETZTER = NAMEN[MAX];
const modus = process.argv[2];

if (modus === 'start') {
  const konten = {};
  for (const name of NAMEN) {
    await anfrage('/_explorer/api/benutzer', { methode: 'POST', cookie: admin, body: JSON.stringify({ name, passwort: PW, rolle: 'benutzer' }) });
    konten[name] = await anmelden(name, PW);
    if (!konten[name]) ok(false, `Konto ${name} anlegen/anmelden`);
  }
  ok(Object.values(konten).every(Boolean), `${NAMEN.length} Testkonten angelegt (Grenze ${MAX})`);
  const dateien = readdirSync('/tmp/uxtest').filter((d) => d.endsWith('.unifi') && !d.startsWith('._')).sort();
  const pakete = [];
  for (const d of dateien) pakete.push({ datei: d, zip: netzwerkPaket(await openBackup(new File([readFileSync(`/tmp/uxtest/${d}`)], d))) });
  const plan = STARTER.map((n, i) => ({ konto: n, name: `${n} – ${pakete[i % pakete.length].datei}`, zip: pakete[i % pakete.length].zip }));

  // Alle Konten starten gleichzeitig.
  const starts = await Promise.all(plan.map((p) => anfrage('/_explorer/api/vorschau', {
    methode: 'POST', cookie: konten[p.konto], body: p.zip, kopf: { 'Content-Type': 'application/zip', 'X-Backup-Name': encodeURIComponent(p.name) }
  })));
  ok(starts.every((r) => r.status === 202), `${MAX} Vorschauen gleichzeitig gestartet (${starts.map((r) => r.status).join(' ')})`);

  // Ein Konto mehr: abgewiesen, sieht alle anderen.
  const voll = await anfrage('/_explorer/api/vorschau', { methode: 'POST', cookie: konten[LETZTER], body: pakete[0].zip, kopf: { 'Content-Type': 'application/zip', 'X-Backup-Name': 'zu-viel' } });
  ok(voll.status === 409, `${MAX + 1}. Vorschau abgewiesen (HTTP ${voll.status})`);
  const sl = (await anfrage('/_explorer/api/vorschau', { cookie: konten[LETZTER] })).json;
  ok(sl.andere.length === MAX && !sl.aktiv, `${LETZTER} sieht ${sl.andere.length} belegte Plätze`);
  ok(!JSON.stringify(sl.andere).includes('passwort'), 'Fremde Einträge ohne Zugangsdaten');
  const fremd = await anfrage(`/_explorer/api/vorschau?id=${sl.andere[0].id}`, { methode: 'DELETE', cookie: konten[LETZTER] });
  ok(fremd.status === 403, `Benutzer darf fremde Vorschau nicht beenden (HTTP ${fremd.status})`);

  // Warten, bis alle bereit sind.
  const t0 = Date.now();
  const stand = {};
  let zeile = '';
  while (Date.now() - t0 < 20 * 60000) {
    for (const n of STARTER) stand[n] = (await anfrage('/_explorer/api/vorschau', { cookie: konten[n] })).json;
    const neu = STARTER.map((n) => `${n.replace('ux-test', '')}:${stand[n].phase}`).join(' ');
    if (neu !== zeile) console.log(`     ${String(Math.round((Date.now() - t0) / 1000)).padStart(4)} s  ${zeile = neu}`);
    if (STARTER.every((n) => ['bereit', 'fehler'].includes(stand[n].phase))) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  for (const n of STARTER) ok(stand[n].phase === 'bereit' && stand[n].art === 'unifi', `${n} bereit (art ${stand[n].art}, ${stand[n].geraete} Geräte, UniFi ${stand[n].version?.controller})${stand[n].fehler ? ' – ' + stand[n].fehler.text : ''}`);

  // Jedes Konto landet bei seinem eigenen Controller.
  const uuids = new Set(), unifi = {};
  for (const p of plan) {
    const n = p.konto;
    const auf = await anfrage('/_explorer/api/vorschau/oeffnen', { cookie: konten[n] });
    unifi[n] = auf.cookies.find((c) => c.startsWith('unifises='));
    const beide = `${konten[n]}; ${unifi[n]}`;
    const seite = await anfrage(`/manage/${stand[n].startSite || 'default'}/dashboard`, { cookie: beide, kopf: { Accept: 'text/html' } });
    const eigener = seite.text.includes(`${n} – `) && !plan.some((q) => q.konto !== n && seite.text.includes(`${q.konto} – `));
    const st = await anfrage('/status', { cookie: beide });
    uuids.add(st.json?.meta?.uuid);
    const sites = await anfrage('/api/self/sites', { cookie: beide });
    const geraete = (sites.json?.data || []).reduce((s, x) => s + (x.device_count || 0), 0);
    ok(auf.status === 302 && unifi[n] && seite.status === 200 && eigener && sites.json?.meta?.rc === 'ok' && geraete === stand[n].geraete,
      `${n}: Anmeldung, eigenes Backup im Hinweis, ${geraete} Geräte`);
  }
  ok(uuids.size === MAX, `${uuids.size} verschiedene Controller`);

  // Fenster-Einbettung (FAH-Extraktor): Hülle ohne x-frame-options, CSP frame-ancestors 'self'; oeffnen?eingebettet=1.
  const e0 = STARTER[0];
  const huelle = await anfrage(`/manage/${stand[e0].startSite || 'default'}/dashboard`, { cookie: `${konten[e0]}; ${unifi[e0]}`, kopf: { Accept: 'text/html' } });
  ok(huelle.status === 200 && !('x-frame-options' in huelle.kopf) && /frame-ancestors 'self'/.test(huelle.kopf['content-security-policy'] || ''),
    `${e0}: Hülle ohne x-frame-options, CSP „${huelle.kopf['content-security-policy'] || '(keine)'}“`);
  const eingebettet = await anfrage('/_explorer/api/vorschau/oeffnen?eingebettet=1', { cookie: konten[e0] });
  ok(eingebettet.status === 302 && /^\/manage\//.test(eingebettet.kopf.location || '') && eingebettet.cookies.some((c) => c.startsWith('unifises=')),
    `${e0}: oeffnen?eingebettet=1 → ${eingebettet.status} ${eingebettet.kopf.location}`);
  const keine = await anfrage('/_explorer/api/vorschau/oeffnen?eingebettet=1', { cookie: konten[LETZTER] });
  ok(keine.status === 200 && /Keine/.test(keine.text) && !/href="\/"/.test(keine.text), `${LETZTER} ohne Lauf, eingebettet: ${keine.status} Hinweis ohne Link auf /`);
  const keine2 = await anfrage('/_explorer/api/vorschau/oeffnen', { cookie: konten[LETZTER] });
  ok(keine2.status === 302 && keine2.kopf.location === '/', `${LETZTER} ohne Lauf: ${keine2.status} → ${keine2.kopf.location}`);
  const quer = await anfrage('/api/self/sites', { cookie: `${konten[STARTER[0]]}; ${unifi[STARTER[1]]}` });
  ok(quer.json?.meta?.rc !== 'ok', `UniFi-Sitzung von ${STARTER[1]} gilt nicht beim Controller von ${STARTER[0]} (HTTP ${quer.status})`);

  // WebSocket geht an den eigenen Controller und zählt dort als offener Tab.
  const ws = await new Promise((resolve) => {
    const req = http.request(`${BASIS}/wss/s/${stand[STARTER[0]].startSite || 'default'}/events`, { headers: {
      Cookie: `${konten[STARTER[0]]}; ${unifi[STARTER[0]]}`, Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Key': Buffer.from('fah-test-1234567').toString('base64'), 'Sec-WebSocket-Version': '13'
    } });
    req.on('upgrade', (res, socket) => resolve({ ok: res.statusCode === 101, socket }));
    req.on('response', (res) => resolve({ ok: false, status: res.statusCode }));
    req.on('error', (e) => resolve({ ok: false, status: e.message }));
    req.end();
  });
  await new Promise((r) => setTimeout(r, 500));
  const nachWs = (await anfrage('/_explorer/api/vorschau', { cookie: konten[STARTER[0]] })).json;
  const andererWs = (await anfrage('/_explorer/api/vorschau', { cookie: konten[STARTER[1]] })).json;
  ok(ws.ok && nachWs.offeneSockets === 1 && andererWs.offeneSockets === 0, `WebSocket ${STARTER[0]} offen, nur dort gezählt (${ws.status || 101})`);
  ws.socket?.destroy();
  process.exit();
}

if (modus === 'ende') {
  const liste = (await anfrage('/_explorer/api/benutzer', { cookie: admin })).json.benutzer;
  const test = liste.filter((x) => /^ux-test\d+$/.test(x.name));
  for (const b of test) {
    const c = await anmelden(b.name, PW);
    if (c) await anfrage('/_explorer/api/vorschau', { methode: 'DELETE', cookie: c });
    await anfrage(`/_explorer/api/benutzer/${b.id}`, { methode: 'DELETE', cookie: admin });
  }
  const rest = (await anfrage('/_explorer/api/benutzer', { cookie: admin })).json.benutzer.filter((x) => /^ux-test\d+$/.test(x.name));
  ok(rest.length === 0, `${test.length} Testkonten samt Vorschauen entfernt`);
}
