// FAH-Extraktor · Urheber: Fabian Hammer
import { randomBytes } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import * as docker from '../docker.js';
import * as controller from '../controller.js';
import { REPO, waehleImage } from '../images.js';
import { sha512crypt } from '../sha512crypt.js';
import { vorschauUnf } from '../../src/vorschau-paket.js';
import { setze, pruefe, warte, bisBereit, erreichbar, labels, hostKonfig } from '../lauf.js';

// Vorschau-Art UniFi: Backup vorbereiten -> Controller-Programm bereitstellen ->
// MongoDB + Controller im abgeschotteten Netz starten -> Backup über den
// Einrichtungsassistenten einspielen -> mit dem Wegwerf-Admin anmelden.
export const art = 'unifi';
export const bezeichnung = 'Der Controller';
const MONGO = 'mongo:7.0';
const BENUTZER = 'fah-vorschau';
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

export const SCHRITTE = [
  ['vorbereiten', 'Backup vorbereiten'],
  ['laden', 'Controller-Programm bereitstellen'],
  ['starten', 'Controller starten'],
  ['einspielen', 'Backup einspielen'],
  ['anmelden', 'Anmeldung vorbereiten']
];

export const zielFuer = (l) => controller.zielFuer(l.app);
export const zugang = (l) => ({ benutzer: BENUTZER, passwort: l.passwort, hinweis: 'Automatische Anmeldung; sonst diese Daten.' });
export const statusExtra = (l) => ({ version: l.version, sites: l.sites, geraete: l.geraete, startSite: l.startSite });
export const istHuelle = (req) => req.method === 'GET' && req.url.startsWith('/manage') && /text\/html/.test(req.headers.accept || '');

// Frische Sitzung für den Browser des Betreibers (automatische Anmeldung).
export async function oeffnenZiel(l) {
  const cookie = await controller.anmelden(l.ziel, BENUTZER, l.passwort);
  return cookie ? { cookie, location: `/manage/${encodeURIComponent(l.startSite || 'default')}/dashboard` } : null;
}

// Der eigenständige Controller blendet "Auf UniFi OS Server upgraden" ein, solange
// es im sessionStorage des Tabs nicht als weggeklickt gilt (Schlüssel je
// Controller-Kennung, Wert <= Laufzeit in s). Das Skript steht vor den
// defer-Skripten und belegt den Schlüssel vor. Beim allerersten Laden entscheidet
// die Oberfläche aber, bevor ihre Daten da sind - dann klickt der Wächter im
// Fenster (erkannt am Produktnamen) selbst auf "Später erinnern".
function upgradeHinweisAus(kennung) {
  const vorbelegen = /^[0-9a-f-]{8,64}$/i.test(kennung)
    ? `try{sessionStorage.setItem("networkServerUpgradeModalDismissed-${kennung}","1")}catch(e){}` : '';
  return `<script>${vorbelegen}(function(){var ende=Date.now()+90000;var w=new MutationObserver(function(){`
    + `if(Date.now()>ende){w.disconnect();return;}var d=document.querySelectorAll('[role="dialog"],[aria-modal="true"]');`
    + `for(var i=0;i<d.length;i++){if(!/UniFi OS Server/.test(d[i].textContent||''))continue;`
    + `var k=[].filter.call(d[i].querySelectorAll('button'),function(b){var t=(b.textContent||'').trim();return t&&!/UniFi OS Server/.test(t);}).pop();`
    + `if(k&&!k.dataset.fahGeklickt){k.dataset.fahGeklickt='1';k.click();}}});`
    + `w.observe(document.documentElement,{childList:true,subtree:true});})();</script>`;
}

// Hinweisleiste in der Seitenhülle der UniFi-Oberfläche (nur im eigenen Tab,
// nicht im Fenster des Explorers). Der Link zielt immer auf das oberste Fenster.
export function banner(lauf) {
  const name = escapeHtml(lauf.name || 'Backup');
  return upgradeHinweisAus(lauf.controllerId || '') + `<div id="fah-vorschau" style="position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:10px;padding:6px 8px 6px 14px;border-radius:999px;background:#1674e8;color:#fff;font:600 12px/1.3 system-ui,-apple-system,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:calc(100vw - 24px)">`
    + `<span style="white-space:nowrap">Virtuelle Vorschau</span><span style="font-weight:400;opacity:.9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${name} · ohne Verbindung zu echten Geräten</span>`
    + `<a href="/" target="_top" style="color:#fff;white-space:nowrap">FAH-Extraktor</a>`
    + `<button type="button" aria-label="Hinweis ausblenden" onclick="this.parentNode.remove()" style="border:0;background:rgba(255,255,255,.18);color:#fff;border-radius:999px;width:22px;height:22px;cursor:pointer;font:inherit;line-height:1">×</button></div>`;
}

// Nur die aussagekräftigen Zeilen: Java-Warnungen und Startbanner weglassen.
export function logAuszug(log) {
  return log.split('\n').map((zeile) => zeile.trimEnd())
    .filter((zeile) => zeile && !/^WARNING: |^\[(custom-init|migrations|ls\.io-init)\]|^\s*$/.test(zeile))
    .slice(-25).join('\n');
}

// kern.netz() liefert das abgeschottete Vorschau-Netz (serialisiert in vorschau.js).
export async function ablauf(l, zip, optionen, kern) {
  setze(l, 'vorbereiten', 'laeuft');
  const versionDatei = unzipSync(zip, { filter: (datei) => datei.name === 'version' }).version;
  const backupVersion = versionDatei ? strFromU8(versionDatei).trim() : '';
  const image = await waehleImage(backupVersion);
  pruefe(l);
  l.version = { backup: backupVersion || 'unbekannt', controller: image.version, angeglichen: image.angeglichen };
  const paket = await vorschauUnf(zip, {
    benutzer: BENUTZER, shadow: sha512crypt(l.passwort), zielVersion: image.angeglichen ? image.version : undefined
  });
  l.startSite = paket.startSite;
  l.sites = paket.sites.filter((site) => site !== 'super');
  setze(l, 'vorbereiten', 'fertig', `${l.sites.length} ${l.sites.length === 1 ? 'Site' : 'Sites'} · UniFi Network ${l.version.backup}`);

  setze(l, 'laden', 'laeuft', `UniFi Network ${image.version}`);
  if (!image.vorhanden) {
    await docker.imageLaden(REPO, image.version, (geladen, gesamt) => {
      setze(l, 'laden', 'laeuft', `UniFi Network ${image.version} wird einmalig geladen … ${Math.round((geladen / gesamt) * 100)} %`);
    });
  }
  if (!await docker.imageInfo(MONGO)) await docker.imageLaden('mongo', '7.0');
  pruefe(l);
  setze(l, 'laden', 'fertig', `UniFi Network ${image.version}${image.angeglichen ? ' (neuere Version als im Backup)' : ''}`);

  setze(l, 'starten', 'laeuft');
  const start = Date.now();
  const netz = await kern.netz();
  pruefe(l);
  const dbPasswort = randomBytes(18).toString('hex');
  const gemeinsam = labels(l, art);
  const db = await docker.containerErstellen(l.db, {
    Image: MONGO, Cmd: ['--wiredTigerCacheSizeGB', '0.25'], Labels: gemeinsam,
    Env: ['MONGO_INITDB_ROOT_USERNAME=unifi', `MONGO_INITDB_ROOT_PASSWORD=${dbPasswort}`],
    HostConfig: hostKonfig(netz, 1, 1)
  });
  await docker.containerStarten(db);
  await datenbankBereit(l);
  const app = await docker.containerErstellen(l.app, {
    Image: image.ref, Labels: gemeinsam,
    Env: [
      'PUID=1000', 'PGID=1000', `TZ=${process.env.TZ || 'Europe/Berlin'}`, 'MEM_LIMIT=1024', 'MEM_STARTUP=512',
      'MONGO_USER=unifi', `MONGO_PASS=${dbPasswort}`, `MONGO_HOST=${l.db}`, 'MONGO_PORT=27017',
      'MONGO_DBNAME=unifi', 'MONGO_AUTHSOURCE=admin'
    ],
    HostConfig: hostKonfig(netz, 2, 2.5)
  });
  await docker.containerStarten(app);
  await bisBereit(l, 10 * 60000, async () => (await controller.status(l.ziel))?.up === true, bezeichnung);
  setze(l, 'starten', 'fertig', `nach ${Math.round((Date.now() - start) / 1000)} s`);

  setze(l, 'einspielen', 'laeuft');
  const hochgeladen = await controller.backupHochladen(l.ziel, paket.unf);
  pruefe(l);
  await controller.einspielen(l.ziel, hochgeladen.backup_id);
  setze(l, 'einspielen', 'fertig');

  // Nach dem Einspielen startet der Controller neu; angemeldet werden kann erst,
  // wenn die wiederhergestellte Datenbank samt Wegwerf-Admin läuft.
  setze(l, 'anmelden', 'laeuft');
  let cookie = null;
  await bisBereit(l, 8 * 60000, async () => (cookie = await controller.anmelden(l.ziel, BENUTZER, l.passwort)) !== null, bezeichnung);
  l.controllerId = (await controller.status(l.ziel))?.uuid || '';
  const liste = await controller.sites(l.ziel, cookie);
  l.geraete = liste.reduce((summe, site) => summe + (site.device_count || 0), 0);
  setze(l, 'anmelden', 'fertig', `${l.geraete} ${l.geraete === 1 ? 'Gerät' : 'Geräte'} im Backup`);
}

// Das Controller-Programm wartet nur ~35 s auf die Datenbank und hängt danach für
// immer. Bei mehreren gleichzeitigen Starts braucht MongoDB länger, und der Neustart
// nach ihrer Ersteinrichtung scheitert gelegentlich ("Address already in use") -
// daher erst weiter, wenn sie von außen erreichbar ist (die Einrichtungsinstanz
// lauscht nur auf localhost), und eine beendete Datenbank neu starten.
async function datenbankBereit(l) {
  const ende = Date.now() + 5 * 60000;
  let neustarts = 0;
  while (Date.now() < ende) {
    pruefe(l);
    if (await erreichbar(l.db, 27017)) return;
    const info = await docker.containerInfo(l.db);
    if (info && !info.State?.Running) {
      if (++neustarts > 3) throw Object.assign(new Error(`Die Datenbank der Vorschau startet nicht (Exit-Code ${info.State?.ExitCode}).`), { container: l.db });
      console.log(`[vorschau] Datenbank ${l.db} beendet (Exit-Code ${info.State?.ExitCode}) – Neustart ${neustarts}`);
      await docker.containerStarten(l.db);
    }
    await warte(2000);
  }
  throw Object.assign(new Error('Die Datenbank der Vorschau ist nicht rechtzeitig bereit geworden.'), { container: l.db });
}
