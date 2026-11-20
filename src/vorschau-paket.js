import { deserialize, serialize, ObjectId, Long } from 'bson';
import { gunzipSync, gzipSync, unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { encryptUnf, ALLOWED_COLLECTIONS } from './backup.js';

// Virtuelle Vorschau: Das Backup wird in einem abgeschotteten Wegwerf-Controller
// wiederhergestellt. Der Browser schickt dafür nur den Network-Teil (netzwerkPaket);
// Protect-Schlüssel und UniFi-OS-Benutzer eines .unifi bleiben im Browser. Das
// Backend baut daraus mit vorschauUnf ein vollständiges Controller-Backup und setzt
// einen Wegwerf-Admin ein - die Admins aus UniFi-OS-Backups haben kein lokales
// Passwort (x_shadow fehlt), mit ihnen käme man nie in die Oberfläche.

export function istSiteExport(backup) {
  // Ein Single-Site-Export ("Sites exportieren") hat kein system.properties und keine
  // Admins. vorschauUnf ergänzt das für die Vorschau; sie zeigt dann nur diese eine Site.
  return !backup.files.has(`${backup.networkPrefix}system.properties`);
}

export function netzwerkPaket(backup, zusatz = {}) {
  const entries = {};
  for (const [path, bytes] of backup.files) {
    if (!path.startsWith(backup.networkPrefix)) continue;
    const rel = path.slice(backup.networkPrefix.length);
    if (rel) entries[rel] = bytes;
  }
  if (!entries['db.gz']) throw new Error('Kein Network-Datenbankdump (db.gz) gefunden.');
  // db.gz ist schon komprimiert, der Rest winzig -> nur speichern, nicht packen.
  // Der Zusatz kommt zuletzt: Ein gleichnamiger Eintrag aus der Datei darf ihn nicht ersetzen.
  return zipSync({ ...entries, ...zusatz }, { level: 0 });
}

function* bsonStrom(bytes) {
  for (let offset = 0; offset + 4 <= bytes.length;) {
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0, true);
    if (size < 5 || offset + size > bytes.length) break;
    yield bytes.subarray(offset, offset + size);
    offset += size;
  }
}

function concat(parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

// Kundenübergabe: Erlaubt ist nur, was ein Site-Export nachweislich enthält. Unbekanntes
// bleibt draußen und wird gemeldet, damit neue Controller-Versionen nichts durchschleusen.
export const UEBERGABE_OPTIONEN = 'uebergabe.json';
const UEBERGABE_SAMMLUNGEN = new Set([...ALLOWED_COLLECTIONS, 'site', 'event', 'map', 'rogue', 'rogueknown', 'scheduletask']);
const UEBERGABE_DATEIEN = new Set(['db.gz', 'version', 'timestamp', 'format']);
const uebergabeFehler = (text) => Object.assign(new Error(text), { status: 400 });
const NUR_SITE_EXPORT = () => uebergabeFehler('Die Kundenübergabe geht nur aus einem Site-Export. Ein Komplett-Backup enthält eure Admins und bleibt intern.');

// Das Geräte-SSH-Login des Betreibers gehört nicht in die Kundendatei. x_mgmt_key bleibt,
// damit die Geräte den neuen Controller als ihren erkennen.
function geraeteLoginSetzen({ x_api_token: entfernt, ...mgmt }, { benutzer, passwort, sha512, md5 }) {
  return { ...mgmt, x_ssh_username: benutzer, x_ssh_password: passwort, x_ssh_sha512passwd: sha512, x_ssh_md5passwd: md5, x_ssh_keys: [] };
}

const alteGeheimnisse = (mgmt) => ['x_ssh_password', 'x_ssh_md5passwd', 'x_ssh_sha512passwd', 'x_api_token']
  .map((feld) => mgmt[feld]).filter((wert) => typeof wert === 'string' && wert);

// Vergleicht Werte, keine Feldnamen. Kurze Geheimnisse nur exakt, sonst träfen sie zufällig.
function enthaeltGeheimnis(wert, alteWerte) {
  if (typeof wert === 'string') return alteWerte.some((alt) => wert === alt || (alt.length >= 8 && wert.includes(alt)));
  if (Array.isArray(wert)) return wert.some((eintrag) => enthaeltGeheimnis(eintrag, alteWerte));
  if (wert && wert.constructor === Object) return Object.values(wert).some((inhalt) => enthaeltGeheimnis(inhalt, alteWerte));
  return false;
}

const altesGeheimnisFehler = (ort) => uebergabeFehler(`Das alte Geräte-Passwort oder API-Token steht auch in „${ort}“. Diese Site lässt sich so nicht übergeben.`);

// Letzter Gang über alle Dokumente, nachdem das Geräte-Login ersetzt ist: Daten fremder
// Sites und Admin-Ereignisse (sie können Login-Namen enthalten) bleiben draußen.
function uebergabeBereinigen(bloecke, siteId, alteWerte, ausgelassen) {
  for (const block of bloecke) {
    block.teile = block.teile.filter((raw, index) => {
      if (index === 0) return true;
      const doc = deserialize(raw, { promoteLongs: false });
      if (block.name === 'setting' && /^super_/.test(String(doc.key))) throw NUR_SITE_EXPORT();
      if (doc.site_id !== undefined && String(doc.site_id) !== siteId) {
        ausgelassen.push(`${block.name}: fremde Site`);
        return false;
      }
      if (block.name === 'event' && ('admin' in doc || /^EVT_AD_/.test(String(doc.key)))) {
        ausgelassen.push('event: Admin-Ereignisse');
        return false;
      }
      if (enthaeltGeheimnis(doc, alteWerte)) throw altesGeheimnisFehler(block.name);
      return true;
    });
  }
}

const GEHEIM_FELD = /^x_|pass|secret|psk|token|community|credential|private|key$/i;
const KEIN_GEHEIMNIS = /^key$|public_?key$|essid$/i;

// Für die Ansicht: Welche Zugangsdaten bleiben als Site-Daten in der Kundendatei? Nur
// Feldnamen und Anzahl, nie Werte. Geräteschlüssel sind nötig und hier nicht gemeint.
export function verbleibendeGeheimnisse(backup) {
  const zaehler = new Map();
  const gehe = (wert, pfad) => {
    if (Array.isArray(wert)) { for (const eintrag of wert) gehe(eintrag, pfad); return; }
    if (!wert || typeof wert !== 'object' || wert.constructor !== Object) return;
    for (const [name, inhalt] of Object.entries(wert)) {
      const feld = `${pfad}.${name}`;
      const gefuellt = typeof inhalt === 'string' ? inhalt !== '' : inhalt?._bsontype === 'Binary';
      if (gefuellt && GEHEIM_FELD.test(name) && !KEIN_GEHEIMNIS.test(name)) zaehler.set(feld, (zaehler.get(feld) || 0) + 1);
      gehe(inhalt, feld);
    }
  };
  for (const [name, docs] of backup.collections) {
    if (name === 'device' || !UEBERGABE_SAMMLUNGEN.has(name)) continue;
    for (const doc of docs) {
      if (name === 'setting' && doc.key === 'mgmt') continue;
      gehe(doc, name === 'setting' ? `setting.${doc.key}` : name);
    }
  }
  return [...zaehler].map(([feld, anzahl]) => ({ feld, anzahl })).sort((a, b) => a.feld.localeCompare(b.feld));
}

// Baut die Datenbank für die Sandbox: hängt den Wegwerf-Admin samt Admin-Rechten
// auf JEDER Site (auch "super" -> Super-Admin) an die vorhandenen Blöcke an und
// meldet UniFi-OS-Konsolen (UDM, UDR, UCG, ...) als Gateway. Ein eigenständiger
// Controller verwirft Geräte vom Typ "udm" beim Einspielen; ohne Gateway blieben
// "Internet" (WAN) und "VPN" ausgegraut. Als "uxg" zeigt er die Konsole mit ihrem
// echten Portlayout als Gateway. Alle übrigen Dokumente bleiben byte-genau erhalten.
//
// Mit "geraeteLogin" entsteht stattdessen die Datei für die Kundenübergabe: Geräte
// bleiben, wie sie sind, das Geräte-SSH-Login wird ersetzt, und eine Datei mit
// fremden Konten oder mehreren Sites wird abgelehnt.
export function vorschauDatenbank(dbGz, { benutzer, shadow, email = `${benutzer}@vorschau.invalid`, geraeteLogin = null, jetzt = Date.now() }) {
  const bloecke = [];
  const sites = [];
  const ausgelassen = [];
  const alteWerte = [];
  let konsolen = 0;
  let aktuell = null;
  for (const raw of bsonStrom(gunzipSync(dbGz))) {
    const doc = deserialize(raw, { promoteLongs: false });
    if (doc.__cmd === 'select') {
      if (geraeteLogin && (doc.collection === 'admin' || doc.collection === 'privilege')) throw NUR_SITE_EXPORT();
      if (geraeteLogin && !UEBERGABE_SAMMLUNGEN.has(doc.collection)) {
        ausgelassen.push(String(doc.collection));
        aktuell = null;
        continue;
      }
      aktuell = { name: doc.collection, teile: [raw] };
      bloecke.push(aktuell);
    } else if (geraeteLogin && doc.__cmd !== undefined) {
      throw NUR_SITE_EXPORT();
    } else if (aktuell) {
      if (geraeteLogin && aktuell.name === 'setting' && doc.key === 'mgmt') {
        alteWerte.push(...alteGeheimnisse(doc));
        // Ohne Umwandlung lesen, damit die Zahltypen der übrigen Felder erhalten bleiben.
        aktuell.teile.push(serialize(geraeteLoginSetzen(deserialize(raw, { promoteValues: false }), geraeteLogin)));
        continue;
      }
      if (!geraeteLogin && aktuell.name === 'device' && doc.type === 'udm') {
        aktuell.teile.push(serialize({ ...doc, type: 'uxg' }));
        konsolen++;
        continue;
      }
      aktuell.teile.push(raw);
      if (aktuell.name === 'site') sites.push({ id: String(doc._id), name: doc.name || 'default' });
    }
  }
  if (!sites.length) throw new Error('Keine Site im Backup gefunden.');
  if (geraeteLogin) {
    if (sites.some((site) => site.name === 'super')) throw NUR_SITE_EXPORT();
    if (sites.length !== 1) throw uebergabeFehler('Die Kundenübergabe braucht genau eine Site.');
    if (typeof sites[0].name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(sites[0].name)) throw uebergabeFehler('Der Name der Site ist ungültig.');
    uebergabeBereinigen(bloecke, sites[0].id, alteWerte, ausgelassen);
  }

  const anhaengen = (name, docs) => {
    let block = bloecke.find((b) => b.name === name);
    if (!block) { block = { name, teile: [serialize({ __cmd: 'select', collection: name })] }; bloecke.push(block); }
    for (const doc of docs) block.teile.push(serialize(doc));
  };
  // Single-Site-Exporte kennen die versteckte Controller-Site "super" nicht. Felder wie im vollständigen Backup.
  if (!sites.some((site) => site.name === 'super')) {
    const superSite = {
      _id: new ObjectId(), name: 'super', key: 'super', attr_hidden_id: 'super', attr_hidden: true,
      attr_no_delete: true, attr_no_edit: true, anonymous_id: globalThis.crypto.randomUUID()
    };
    anhaengen('site', [superSite]);
    sites.push({ id: superSite._id.toHexString(), name: 'super' });
  }

  const adminId = new ObjectId();
  const startSite = sites.find((site) => site.name === 'default') || sites.find((site) => site.name !== 'super') || sites[0];
  const admin = {
    _id: adminId, name: benutzer, email, x_shadow: shadow,
    time_created: Long.fromNumber(Math.floor(jetzt / 1000)), last_site_name: startSite.name,
    requires_new_password: false, email_alert_enabled: false, push_alert_enabled: false,
    ui_settings: { preferredLanguage: 'de' }
  };
  const rechte = sites.map((site) => ({
    _id: new ObjectId(), admin_id: adminId.toHexString(), site_id: site.id, role: 'admin', permissions: []
  }));
  anhaengen('admin', [admin]);
  anhaengen('privilege', rechte);
  return { db: gzipSync(concat(bloecke.flatMap((b) => b.teile))), sites, startSite: startSite.name, konsolen, ausgelassen, alteWerte };
}

// UniFi-OS-Schlüssel (ucore.*) lassen einen eigenständigen Controller seine
// Anmeldung an den - hier nicht vorhandenen - UniFi-OS-Kern abgeben.
export function bereinigeProperties(bytes) {
  const text = bytes ? strFromU8(bytes) : '';
  return strToU8(text.split(/\r?\n/).filter((zeile) => !/^\s*(unifi\.)?ucore\./.test(zeile)).join('\n'));
}

export async function vorschauUnf(zipBytes, optionen) {
  const dateien = unzipSync(zipBytes);
  if (!dateien['db.gz']) throw new Error('Kein Network-Datenbankdump (db.gz) im Paket.');
  if (!dateien['system.properties']) siteExportErgaenzen(dateien);
  const { db, sites, startSite } = vorschauDatenbank(dateien['db.gz'], optionen);
  // Der Controller lehnt Backups aus neueren Versionen ab. Gibt es kein passendes
  // Programm, wird die Versionsangabe auf die des Controllers gesetzt.
  if (optionen.zielVersion) dateien.version = strToU8(optionen.zielVersion);
  return backupBauen(dateien, db, sites, startSite);
}

// Kundenübergabe: einspielbares Backup aus einem Single-Site-Export mit neuem Admin.
// Ein Komplett-Backup wird abgelehnt, weil es die Konten des Betreibers enthält.
export async function uebergabeUnf(dateien, optionen) {
  if (!dateien['db.gz']) throw uebergabeFehler('Kein Network-Datenbankdump (db.gz) im Paket.');
  if (dateien['system.properties']) throw NUR_SITE_EXPORT();
  const { db, sites, startSite, ausgelassen, alteWerte } = vorschauDatenbank(dateien['db.gz'], optionen);
  const ordner = [`sites/${startSite}/map/`, `sites/${startSite}/portalfile/`];
  const lange = alteWerte.filter((alt) => alt.length >= 8);
  const utf8 = new TextDecoder();
  const erlaubt = {};
  for (const [pfad, bytes] of Object.entries(dateien)) {
    if (pfad.endsWith('/')) continue;
    const sauber = !pfad.includes('\\') && !pfad.split('/').some((teil) => teil === '' || teil === '.' || teil === '..');
    const imOrdner = sauber && ordner.some((o) => pfad.startsWith(o));
    if (!UEBERGABE_DATEIEN.has(pfad) && !imOrdner) { ausgelassen.push(pfad); continue; }
    if (imOrdner && lange.some((alt) => utf8.decode(bytes).includes(alt))) throw altesGeheimnisFehler(pfad);
    erlaubt[pfad] = bytes;
  }
  siteExportErgaenzen(erlaubt);
  return { ...await backupBauen(erlaubt, db, sites, startSite), ausgelassen: [...new Set(ausgelassen)] };
}

// Ein Single-Site-Export wird nur zum Einspielen vervollständigt; die Site-Daten bleiben unverändert.
function siteExportErgaenzen(dateien) {
  dateien.format ??= strToU8('bson');
  dateien['system.properties'] = strToU8(`is_default=false\nuuid=${globalThis.crypto.randomUUID()}\n`);
}

async function backupBauen(dateien, db, sites, startSite) {
  const eintraege = { 'db.gz': db };
  for (const [pfad, bytes] of Object.entries(dateien)) {
    if (pfad === 'db.gz' || pfad.startsWith('sites/') || pfad.endsWith('/')) continue;
    eintraege[pfad] = pfad === 'system.properties' ? bereinigeProperties(bytes) : bytes;
  }
  // Wie ein nativer Download: erst die Ordnerkette sites/<name>/portalfile/, dann
  // die Dateien darin (siehe createSiteUnf in backup.js - ohne die Ordnereinträge
  // bricht der Controller das Einspielen der Portaldateien ab).
  const siteDateien = Object.entries(dateien).filter(([pfad]) => pfad.startsWith('sites/') && !pfad.endsWith('/'));
  const ordner = new Set(['sites/']);
  for (const site of sites) ordner.add(`sites/${site.name}/`).add(`sites/${site.name}/portalfile/`);
  for (const [pfad] of siteDateien) {
    const teile = pfad.split('/');
    for (let i = 1; i < teile.length; i++) ordner.add(`${teile.slice(0, i).join('/')}/`);
  }
  for (const pfad of ordner) eintraege[pfad] = new Uint8Array(0);
  for (const [pfad, bytes] of siteDateien) eintraege[pfad] = bytes;

  return {
    unf: await encryptUnf(zipSync(eintraege, { level: 6 })),
    version: dateien.version ? strFromU8(dateien.version).trim() : '',
    sites: sites.map((site) => site.name),
    startSite
  };
}
