// Durchklick „alle Plätze belegt“ als Admin ohne eigene Vorschau – node:22-alpine, --network host, -e MAX=<Grenze>
import { writeFileSync, readdirSync } from 'node:fs';

const SEITE = 'http://127.0.0.1:45913/';
const MAX = Number(process.env.MAX || 6);
const ok = (b, text) => { console.log(`${b ? 'OK  ' : 'FEHL'} ${text}`); if (!b) process.exitCode = 1; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

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
  writeFileSync(`/tmp/uxtest/${name}.png`, Buffer.from(data, 'base64'));
};

await groesse(1280);
await s('Page.navigate', { url: SEITE });
ok(await warte(`!!document.querySelector('input[name="passwort"]')`), 'Anmeldeseite erscheint');
await js(`(() => { const f = document.querySelector('form'); f.querySelector('[name="name"]').value = ${JSON.stringify(process.env.ADMIN_NAME)}; f.querySelector('[name="passwort"]').value = ${JSON.stringify(process.env.ADMIN_PW)}; f.requestSubmit(); })()`);
ok(await warte(`!!document.querySelector('#picker')`), 'Angemeldet, Explorer offen');

const datei = readdirSync('/tmp/uxtest').find((d) => d.startsWith('PA_Boutique') && d.endsWith('.unifi'));
const { root } = await s('DOM.getDocument', { depth: 1 });
const { nodeId } = await s('DOM.querySelector', { nodeId: root.nodeId, selector: '#picker' });
await s('DOM.setFileInputFiles', { nodeId, files: [`/tmp/uxtest/${datei}`] });
ok(await warte(`!!document.querySelector('#nav button[data-id="vorschau"]')`), 'Backup geöffnet');
await js(`document.querySelector('#nav button[data-id="vorschau"]').click()`);
ok(await warte(`document.querySelector('#vorschau-inhalt')?.textContent.includes('Es laufen schon ${MAX}')`), `Hinweis „Es laufen schon ${MAX} virtuelle Vorschauen“`);
const eintraege = await js(`[...document.querySelectorAll('.vorschau-andere > div')].map((d) => d.innerText.replace(/\\s+/g, ' '))`);
ok(eintraege.length === MAX, `Belegung sichtbar (${eintraege.length}): ${eintraege.join(' | ')}`);
ok(await js(`document.querySelectorAll('[data-v="fremd-ende"]').length === ${MAX} && !document.querySelector('[data-v="start"]')`), `Admin sieht ${MAX}× „Beenden“, kein Start-Knopf`);
await bild('1-voll');
await groesse(390);
await pause(400);
await bild('2-voll-handy');
ok(await js(`document.documentElement.scrollWidth <= 390`), 'Handy-Breite ohne Querscrollen');
await groesse(1280);

// Fremde Vorschau von ux-test3 beenden: erster Klick fragt nach, zweiter beendet.
const knopf = `[...document.querySelectorAll('.vorschau-andere > div')].find((d) => d.innerText.includes('ux-test3'))?.querySelector('[data-v="fremd-ende"]')`;
await js(`${knopf}.click()`);
ok(await js(`${knopf}?.textContent === 'Wirklich beenden?'`), 'Erster Klick fragt „Wirklich beenden?“');
await js(`${knopf}.click()`);
ok(await warte(`!!document.querySelector('#vorschau-inhalt [data-v="start"]')`), 'Platz frei: Start-Knopf erscheint');
ok(await js(`document.querySelector('#vorschau-inhalt').textContent.includes('Gerade belegt: ${MAX - 1} von ${MAX}')`), `Anzeige „Gerade belegt: ${MAX - 1} von ${MAX}“`);
await bild('3-platz-frei');
process.exit();
