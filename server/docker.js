import http from 'node:http';
import { hostname } from 'node:os';

// Minimaler Client für die Docker-Engine-API über den Unix-Socket. Das Backend
// fasst damit ausschließlich die eigenen Vorschau-Container an (Label LABEL).
const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
export const LABEL = 'fah.unifi-vorschau';

// "body" wird als JSON gesendet; "koerperRoh" (Buffer) unverändert mit "contentType".
function anfrage(method, pfad, body, { roh = false, timeout = 60000, beiDaten, koerperRoh, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const daten = koerperRoh !== undefined ? koerperRoh : body === undefined ? null : Buffer.from(JSON.stringify(body));
    const typ = koerperRoh !== undefined ? (contentType || 'application/octet-stream') : 'application/json';
    const req = http.request({
      socketPath: SOCKET, method, path: pfad, timeout,
      headers: daten ? { 'Content-Type': typ, 'Content-Length': daten.length } : {}
    }, (res) => {
      const teile = [];
      res.on('data', (teil) => { teile.push(teil); beiDaten?.(teil); });
      res.on('end', () => {
        const inhalt = Buffer.concat(teile);
        if (res.statusCode >= 400) {
          let text = inhalt.toString();
          try { text = JSON.parse(text).message || text; } catch { /* Rohtext behalten */ }
          const fehler = new Error(`Docker ${method} ${pfad.split('?')[0]}: ${text.trim().slice(0, 300)}`);
          fehler.status = res.statusCode;
          return reject(fehler);
        }
        if (roh) return resolve(inhalt);
        try { resolve(inhalt.length ? JSON.parse(inhalt.toString()) : null); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Docker ${method} ${pfad.split('?')[0]}: Zeitüberschreitung`)));
    req.on('error', reject);
    if (daten) req.write(daten);
    req.end();
  });
}

const ohne404 = (promise) => promise.catch((fehler) => { if (fehler.status === 404) return null; throw fehler; });

export const imageInfo = (ref) => ohne404(anfrage('GET', `/images/${ref}/json`));

export async function lokaleImages(repo) {
  const filter = encodeURIComponent(JSON.stringify({ reference: [repo] }));
  return (await anfrage('GET', `/images/json?filters=${filter}`)) || [];
}

// Lädt ein Image. Die Engine meldet Fortschritt und Fehler als JSON-Zeilen im
// Antwortstrom (auch bei HTTP 200), daher wird der Strom selbst ausgewertet.
export async function imageLaden(repo, tag, beiFortschritt) {
  const ebenen = new Map();
  let rest = '';
  let fehler = null;
  await anfrage('POST', `/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`, undefined, {
    roh: true, timeout: 20 * 60000,
    beiDaten: (teil) => {
      const zeilen = (rest + teil.toString()).split('\n');
      rest = zeilen.pop();
      for (const zeile of zeilen) {
        if (!zeile.trim()) continue;
        let meldung;
        try { meldung = JSON.parse(zeile); } catch { continue; }
        if (meldung.error) fehler = meldung.error;
        if (meldung.id && meldung.progressDetail?.total) ebenen.set(meldung.id, meldung.progressDetail);
        if (meldung.id && /complete|already exists/i.test(meldung.status || '')) {
          const alt = ebenen.get(meldung.id);
          if (alt) ebenen.set(meldung.id, { current: alt.total, total: alt.total });
        }
      }
      let geladen = 0, gesamt = 0;
      for (const { current = 0, total = 0 } of ebenen.values()) { geladen += Math.min(current, total); gesamt += total; }
      if (gesamt) beiFortschritt?.(geladen, gesamt);
    }
  });
  if (fehler) throw new Error(`Image ${repo}:${tag} konnte nicht geladen werden: ${fehler}`);
}

export async function containerErstellen(name, konfiguration) {
  const antwort = await anfrage('POST', `/containers/create?name=${encodeURIComponent(name)}`, konfiguration);
  return antwort.Id;
}

export const containerStarten = (id) => anfrage('POST', `/containers/${id}/start`);
export const containerInfo = (id) => ohne404(anfrage('GET', `/containers/${id}/json`));
// force+v entfernt nur anonyme Volumes - benannte (z. B. der CHR-Cache) bleiben.
export const containerEntfernen = (id) => ohne404(anfrage('DELETE', `/containers/${id}?force=true&v=true`));

// Dateien (als ustar-Archiv) in einen bestehenden Container legen; "pfad" muss dort existieren.
export const archivHochladen = (id, pfad, tar) =>
  anfrage('PUT', `/containers/${id}/archive?path=${encodeURIComponent(pfad)}`, undefined, { koerperRoh: tar, contentType: 'application/x-tar', timeout: 5 * 60000 });

// Benanntes Volume anlegen (idempotent; ein vorhandenes gleichen Namens bleibt).
export async function volumeSicherstellen(name) {
  try { await anfrage('POST', '/volumes/create', { Name: name, Labels: { [LABEL]: '1' } }); } catch (fehler) {
    if (fehler.status !== 409) throw fehler;
  }
}

// Logs eines Containers live mitlesen (stdout+stderr, 8-Byte-Demux über
// Chunk-Grenzen hinweg), zeilenweise an beiZeile. Liefert { beenden() }.
export function logsFolgen(id, beiZeile) {
  let rest = Buffer.alloc(0);
  const angefangen = new Map(); // Strom -> angefangene Zeile
  const verarbeite = (strom, text) => {
    const zeilen = ((angefangen.get(strom) || '') + text).split('\n');
    angefangen.set(strom, zeilen.pop());
    for (const zeile of zeilen) { try { beiZeile(zeile.replace(/\r$/, ''), strom); } catch (f) { console.error('[docker] logsFolgen:', f.message); } }
  };
  const req = http.request({ socketPath: SOCKET, method: 'GET', path: `/containers/${id}/logs?follow=true&stdout=true&stderr=true&tail=all` }, (res) => {
    if (res.statusCode >= 400) { res.resume(); return; }
    res.on('data', (teil) => {
      rest = rest.length ? Buffer.concat([rest, teil]) : teil;
      let i = 0;
      while (i + 8 <= rest.length) {
        const laenge = rest.readUInt32BE(i + 4);
        if (i + 8 + laenge > rest.length) break;
        verarbeite(rest[i], rest.subarray(i + 8, i + 8 + laenge).toString('utf8'));
        i += 8 + laenge;
      }
      rest = rest.subarray(i);
    });
    res.on('end', () => { for (const [strom, zeile] of angefangen) if (zeile) verarbeite(strom, '\n'); });
    res.on('error', () => {});
  });
  req.on('error', () => {});
  req.end();
  return { beenden: () => req.destroy() };
}

// Alle Vorschau-Container oder nur die eines Laufs.
export async function eigeneContainer(lauf) {
  const filter = encodeURIComponent(JSON.stringify({ label: [`${LABEL}=1`, ...(lauf ? [`${LABEL}.lauf=${lauf}`] : [])] }));
  return (await anfrage('GET', `/containers/json?all=true&filters=${filter}`)) || [];
}

// Ohne TTY liefert die Engine Logs gemultiplext: je Block 8 Byte Kopf
// (Strom, 3x0, Länge als uint32 big endian) und danach die Nutzdaten.
export async function containerLogs(id, zeilen = 40) {
  const roh = await ohne404(anfrage('GET', `/containers/${id}/logs?stdout=1&stderr=1&tail=${zeilen}`, undefined, { roh: true }));
  if (!roh) return '';
  const teile = [];
  for (let i = 0; i + 8 <= roh.length;) {
    const laenge = roh.readUInt32BE(i + 4);
    teile.push(roh.subarray(i + 8, i + 8 + laenge));
    i += 8 + laenge;
  }
  return Buffer.concat(teile).toString('utf8');
}

// Abgeschottetes Netz: "Internal" heißt kein Weg ins LAN und ins Internet. Das
// Backend hängt sich selbst zusätzlich hinein, um den Controller zu erreichen.
export async function vorschauNetz(name) {
  let netz = await ohne404(anfrage('GET', `/networks/${name}`));
  if (!netz) {
    await anfrage('POST', '/networks/create', { Name: name, Driver: 'bridge', Internal: true, Labels: { [LABEL]: '1' } });
    netz = await anfrage('GET', `/networks/${name}`);
  }
  if (!netz.Internal) throw new Error(`Docker-Netz ${name} ist nicht abgeschottet (Internal=false) – Vorschau verweigert.`);
  const ich = await containerInfo(hostname());
  if (ich && !Object.keys(ich.NetworkSettings?.Networks || {}).includes(name)) {
    await anfrage('POST', `/networks/${name}/connect`, { Container: ich.Id });
  }
  return netz;
}
