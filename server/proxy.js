import http from 'node:http';
import https from 'node:https';
import { agent as httpsAgent } from './controller.js';
import { COOKIE } from './konten.js';

// Reicht die Oberfläche der virtuellen Vorschau (UniFi-Controller per https,
// MikroTik-WebFig per http) unter derselben Domain durch wie den Explorer.
// Welche Vorschau ("ziel" = { host, port, schema }) gemeint ist, entscheidet der
// Aufrufer anhand der Anmeldung. Der UniFi-Controller bindet die Sitzung an den
// Host-Header und lehnt fremde Origins ab (403) - beides wird daher umgeschrieben.
const WEG_ANFRAGE = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'forwarded', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host',
  'x-forwarded-port', 'x-real-ip'
]);
const WEG_ANTWORT = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding']);
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });

const schema = (ziel) => (ziel.schema === 'http' ? 'http' : 'https');
export const ursprung = (ziel) => `${schema(ziel)}://${ziel.host}:${ziel.port}`;
const modulFuer = (ziel) => (schema(ziel) === 'http' ? http : https);
const optionenFuer = (ziel) => (schema(ziel) === 'http' ? { agent: httpAgent } : { agent: httpsAgent, rejectUnauthorized: false });

export function zielKopf(kopf, ziel) {
  const neu = {};
  for (const [name, wert] of Object.entries(kopf)) if (!WEG_ANFRAGE.has(name)) neu[name] = wert;
  neu.host = `${ziel.host}:${ziel.port}`;
  // Das Sitzungs-Cookie des Explorers geht die Vorschau nichts an.
  if (neu.cookie) {
    const rest = String(neu.cookie).split(';').map((teil) => teil.trim()).filter((teil) => teil && !teil.startsWith(`${COOKIE}=`)).join('; ');
    if (rest) neu.cookie = rest; else delete neu.cookie;
  }
  if (kopf.origin) neu.origin = ursprung(ziel);
  if (kopf.referer) {
    try { const alt = new URL(kopf.referer); neu.referer = ursprung(ziel) + alt.pathname + alt.search; } catch { delete neu.referer; }
  }
  return neu;
}

// Die Vorschau läuft als Fenster (iframe) im Explorer, gleiche Origin: Einbettung
// nur von dort erlauben - x-frame-options weg, frame-ancestors 'self' setzen.
function einbettungErlauben(neu) {
  delete neu['x-frame-options'];
  const alt = [].concat(neu['content-security-policy'] || []).join('; ');
  const direktiven = alt.split(';').map((d) => d.trim()).filter((d) => d && !/^frame-ancestors(\s|$)/i.test(d));
  direktiven.push("frame-ancestors 'self'");
  neu['content-security-policy'] = direktiven.join('; ');
}

export function antwortKopf(kopf, { https: sicher, ziel }) {
  const neu = {};
  for (const [name, wert] of Object.entries(kopf)) if (!WEG_ANTWORT.has(name)) neu[name] = wert;
  if (neu.location) {
    try {
      // URL.origin lässt den Standardport weg (http :80, https :443) – darum beide Seiten normalisieren
      const eigen = new URL(ursprung(ziel)).origin;
      const ort = new URL(neu.location, eigen);
      if (ort.origin === eigen) neu.location = ort.pathname + ort.search + ort.hash;
    } catch { /* Location unverändert lassen */ }
  }
  // Über reines HTTP (direkter LAN-Port) würde der Browser Secure-Cookies verwerfen.
  if (neu['set-cookie'] && !sicher) neu['set-cookie'] = [].concat(neu['set-cookie']).map((c) => c.replace(/;\s*secure/gi, ''));
  einbettungErlauben(neu);
  return neu;
}

export function bannerEinsetzen(html, banner) {
  const stelle = html.lastIndexOf('</html>');
  return stelle < 0 ? html + banner : html.slice(0, stelle) + banner + html.slice(stelle);
}

// banner: Funktion, die den Hinweis-HTML liefert (null = kein Hinweis);
// istHuelle(req): erkennt die Seitenhülle der Oberfläche, in die er gehört.
export function leiteWeiter(req, res, { ziel, banner = null, https: sicher, istHuelle = () => false }) {
  const kopf = zielKopf(req.headers, ziel);
  // Die Seitenhülle unkomprimiert holen, um den Hinweis einzusetzen - nicht im
  // Fenster des Explorers (dort steht der Rahmen schon außen).
  const huelle = Boolean(banner) && istHuelle(req) && req.headers['sec-fetch-dest'] !== 'iframe';
  // Ohne Bedingungen anfragen: Ein 304 ließe den Browser eine alte Hülle mit dem
  // Hinweis und der Controller-Kennung einer früheren Vorschau zeigen.
  if (huelle) {
    kopf['accept-encoding'] = 'identity';
    delete kopf['if-modified-since'];
    delete kopf['if-none-match'];
  }
  const anfrage = modulFuer(ziel).request({ host: ziel.host, port: ziel.port, method: req.method, path: req.url, headers: kopf, ...optionenFuer(ziel) }, (antwort) => {
    const neu = antwortKopf(antwort.headers, { https: sicher, ziel });
    const istHtml = /text\/html/i.test(antwort.headers['content-type'] || '') && !antwort.headers['content-encoding'];
    if (huelle && istHtml && antwort.statusCode === 200) {
      const teile = [];
      antwort.on('data', (teil) => teile.push(teil));
      antwort.on('end', () => {
        const inhalt = Buffer.from(bannerEinsetzen(Buffer.concat(teile).toString('utf8'), banner()), 'utf8');
        neu['content-length'] = inhalt.length;
        neu['cache-control'] = 'no-store';
        delete neu['last-modified'];
        delete neu.etag;
        delete neu.expires;
        res.writeHead(antwort.statusCode, neu);
        res.end(inhalt);
      });
      return;
    }
    res.writeHead(antwort.statusCode, antwort.statusMessage, neu);
    antwort.pipe(res);
  });
  anfrage.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Die virtuelle Vorschau ist gerade nicht erreichbar.');
    } else res.destroy();
  });
  res.on('close', () => { if (!res.writableFinished) anfrage.destroy(); });
  req.pipe(anfrage);
}

// WebSocket (UniFi /wss/...): Handshake an die Vorschau, danach beide Leitungen verbinden.
export function leiteUpgradeWeiter(req, socket, head, { ziel, beiOffen, beiZu }) {
  const kopf = { ...zielKopf(req.headers, ziel), connection: 'Upgrade', upgrade: req.headers.upgrade || 'websocket' };
  const anfrage = modulFuer(ziel).request({
    host: ziel.host, port: ziel.port, method: req.method, path: req.url, headers: kopf,
    ...(schema(ziel) === 'https' ? { rejectUnauthorized: false } : {})
  });
  anfrage.on('upgrade', (antwort, gegenstelle, zielKopfdaten) => {
    const zeilen = ['HTTP/1.1 101 Switching Protocols'];
    for (let i = 0; i < antwort.rawHeaders.length; i += 2) zeilen.push(`${antwort.rawHeaders[i]}: ${antwort.rawHeaders[i + 1]}`);
    socket.write(`${zeilen.join('\r\n')}\r\n\r\n`);
    if (zielKopfdaten?.length) socket.write(zielKopfdaten);
    if (head?.length) gegenstelle.write(head);
    for (const s of [socket, gegenstelle]) { s.setNoDelay(true); s.setTimeout(0); s.setKeepAlive(true, 30000); }
    gegenstelle.pipe(socket);
    socket.pipe(gegenstelle);
    const kennung = beiOffen();
    let zu = false;
    const schliessen = () => {
      if (zu) return;
      zu = true;
      gegenstelle.destroy();
      socket.destroy();
      beiZu(kennung);
    };
    for (const s of [socket, gegenstelle]) { s.on('error', schliessen); s.on('close', schliessen); }
  });
  anfrage.on('response', (antwort) => {
    socket.end(`HTTP/1.1 ${antwort.statusCode} ${antwort.statusMessage}\r\nConnection: close\r\n\r\n`);
    antwort.resume();
  });
  anfrage.on('error', () => socket.destroy());
  socket.on('error', () => anfrage.destroy());
  anfrage.end();
}
