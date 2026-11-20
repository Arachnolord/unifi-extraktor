// FAH-Extraktor · Urheber: Fabian Hammer
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import * as docker from './docker.js';

// Gemeinsame Bausteine aller Vorschau-Arten (UniFi, MikroTik): Schritte setzen,
// Abbruch erkennen, auf den Hauptcontainer warten, Labels und Ressourcen-Deckel.
// Bewusst ohne Import aus vorschau.js, damit die Arten keinen Kreis bilden.

export function setze(l, key, status, detail) {
  const schritt = l.schritte.find((s) => s.key === key);
  if (!schritt) return;
  schritt.status = status;
  if (detail !== undefined) schritt.detail = detail;
  if (status === 'laeuft') l.phase = key;
}

// Nach jedem await im Ablauf aufrufen: ein beendeter oder ersetzter Lauf baut nichts mehr weiter.
export function pruefe(l) {
  if (l.abgebrochen) throw Object.assign(new Error('abgebrochen'), { abgebrochen: true });
}

export const warte = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wartet, bis "test" wahr liefert. "frist" in ms oder eine Funktion, die die Frist
// bei jedem Durchlauf neu liefert (z. B. länger ohne KVM). Endet der Hauptcontainer
// l.app vorzeitig, ist das ein Fehler mit Exit-Code.
export async function bisBereit(l, frist, test, was = 'Die Vorschau', takt = 3000) {
  const start = Date.now();
  const grenze = () => start + (typeof frist === 'function' ? frist() : frist);
  while (Date.now() < grenze()) {
    pruefe(l);
    if (await test()) return;
    const info = await docker.containerInfo(l.app);
    if (info && !info.State?.Running) throw new Error(`${was} hat sich beendet (Exit-Code ${info.State?.ExitCode}).`);
    await warte(takt);
  }
  throw new Error(`${was} ist nicht rechtzeitig bereit geworden.`);
}

export const erreichbar = (host, port) => new Promise((resolve) => {
  const verbindung = net.connect({ host, port, timeout: 2000 });
  const ende = (ok) => { verbindung.destroy(); resolve(ok); };
  verbindung.once('connect', () => ende(true));
  verbindung.once('timeout', () => ende(false));
  verbindung.once('error', () => ende(false));
});

// Kleiner HTTP-Abruf im Vorschau-Netz (http oder https mit selbstsigniertem
// Zertifikat); liefert { status, text } oder null bei Verbindungsfehler.
export function httpAbruf(ziel, pfad = '/', { timeout = 8000, kopf = {} } = {}) {
  return new Promise((resolve) => {
    const sicher = ziel.schema === 'https';
    const modul = sicher ? https : http;
    const req = modul.request({
      host: ziel.host, port: ziel.port, method: 'GET', path: pfad, timeout,
      headers: { Host: `${ziel.host}:${ziel.port}`, 'User-Agent': 'FAH-Extraktor', ...kopf },
      ...(sicher ? { rejectUnauthorized: false } : {})
    }, (res) => {
      const teile = [];
      let groesse = 0;
      res.on('data', (teil) => { if (groesse < 65536) { teile.push(teil); groesse += teil.length; } });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(teile).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

export const labels = (l, art) => ({ [docker.LABEL]: '1', [`${docker.LABEL}.lauf`]: l.id, [`${docker.LABEL}.art`]: art });

// Niedrige CPU-Anteile + harte Deckel: Kamera-KI und andere Dienste auf dem NAS haben Vorrang.
export const hostKonfig = (netz, cpus, speicherGB, extra = {}) => ({
  NetworkMode: netz, RestartPolicy: { Name: 'no' }, CpuShares: 256,
  NanoCpus: Math.round(cpus * 1e9), Memory: Math.round(speicherGB * 1024 ** 3), ...extra
});
