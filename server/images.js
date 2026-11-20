import * as docker from './docker.js';

// Auswahl des Controller-Programms: genau die Version des Backups, sonst die
// nächsthöhere (ältere Backups spielt der Controller per Migration ein), sonst
// die neueste - dann wird die Versionsangabe im Backup angeglichen, weil der
// Controller neuere Backups ablehnt.
export const REPO = 'lscr.io/linuxserver/unifi-network-application';
const HUB = 'https://hub.docker.com/v2/repositories/linuxserver/unifi-network-application/tags?page_size=100&ordering=last_updated';
const VERSION = /^\d+\.\d+\.\d+$/;

export const istVersion = (text) => VERSION.test(String(text || ''));

export function vergleiche(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

export function waehleVersion(verfuegbar, backupVersion) {
  const versionen = [...new Set(verfuegbar.filter(istVersion))].sort(vergleiche);
  if (!versionen.length) return null;
  if (!istVersion(backupVersion)) return { version: versionen.at(-1), angeglichen: true };
  const passend = versionen.find((v) => vergleiche(v, backupVersion) >= 0);
  return passend ? { version: passend, angeglichen: false } : { version: versionen.at(-1), angeglichen: true };
}

let hubCache = { zeit: 0, versionen: [] };
async function hubVersionen() {
  if (Date.now() - hubCache.zeit < 6 * 3600e3 && hubCache.versionen.length) return hubCache.versionen;
  const versionen = [];
  let url = HUB;
  for (let seite = 0; url && seite < 6; seite++) {
    const antwort = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!antwort.ok) throw new Error(`Docker Hub antwortet mit ${antwort.status}`);
    const daten = await antwort.json();
    for (const tag of daten.results || []) if (istVersion(tag.name)) versionen.push(tag.name);
    url = daten.next;
  }
  hubCache = { zeit: Date.now(), versionen };
  return versionen;
}

async function lokaleVersionen() {
  const versionen = [];
  for (const image of await docker.lokaleImages(REPO)) {
    for (const tag of image.RepoTags || []) {
      const name = tag.split(':').pop();
      if (istVersion(name)) versionen.push(name);
    }
  }
  return versionen;
}

export async function waehleImage(backupVersion) {
  if (istVersion(backupVersion) && await docker.imageInfo(`${REPO}:${backupVersion}`)) {
    return { ref: `${REPO}:${backupVersion}`, version: backupVersion, angeglichen: false, vorhanden: true };
  }
  let quelle;
  try { quelle = await hubVersionen(); } catch { quelle = []; }
  const wahl = waehleVersion([...quelle, ...await lokaleVersionen()], backupVersion);
  if (!wahl) throw new Error('Kein passendes UniFi-Controller-Programm gefunden und Docker Hub ist nicht erreichbar.');
  const ref = `${REPO}:${wahl.version}`;
  return { ref, ...wahl, vorhanden: Boolean(await docker.imageInfo(ref)) };
}
