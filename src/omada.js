// FAH-Extraktor · src/omada.js — Urheber: Fabian Hammer © 2026
// Omada-Controller-Backup (.cfg) im Browser lesen. Aufbau (nach jgrimard/Omada_Backup_Decryptor, MIT):
//   RC4( gzip( JSON ) ) – der RC4-Schlüssel ist ein fester 224-Byte-Block aus dem Controller-Code,
//   dessen erste 8 Byte TEA-entschlüsselt werden (64 Runden). Einzelne Werte mit „v2#“ sind zusätzlich
//   AES-128-CBC-verschlüsselt; Schlüssel und IV kommen per PBKDF2-SHA256 aus systemSetting.pbkdf2KeySaltIv.
// Das Ergebnis hat dieselbe Form wie src/mikrotik.js und src/konfig.js (rubriken → saetze → felder).

const TEA_KEY = [-707509657, -1887749506, 1427902494, -1686606610];
const DELTA = -1640531527; // 0x9E3779B9 als vorzeichenbehaftete 32-Bit-Zahl
const C = [112, 122, 14, 91, -110, 101, -10, 34, 51, 59, 94, 118, 50, 108, 63, 50,
  94, 52, 94, 104, 67, 100, 117, 114, 110, 53, 47, 79, 38, 103, 43, 59,
  70, 43, 72, 119, 107, 61, 108, 82, 84, 80, 36, 95, 106, 72, 53, 101,
  105, 81, 38, 47, 65, 110, 47, 47, 99, 79, 72, 36, 50, 108, 68, 48,
  120, 89, 68, 97, 95, 70, 65, 35, 33, 84, 53, 49, 64, 102, 105, 88,
  84, 100, 76, 49, 63, 107, 82, 45, 58, 115, 126, 101, 63, 95, 45, 72,
  50, 45, 84, 36, 100, 117, 43, 110, 114, 65, 72, 98, 112, 103, 78, 45,
  121, 98, 114, 52, 117, 37, 57, 36, 40, 126, 45, 66, 64, 101, 100, 73,
  122, 108, 114, 100, 112, 110, 98, 94, 37, 102, 37, 95, 51, 89, 90, 49,
  115, 95, 103, 89, 106, 103, 101, 56, 117, 99, 106, 115, 108, 118, 89, 33,
  69, 33, 82, 107, 102, 64, 76, 117, 61, 122, 40, 45, 38, 75, 116, 87,
  99, 100, 41, 63, 73, 119, 37, 57, 43, 57, 42, 69, 61, 36, 42, 83,
  95, 58, 112, 52, 118, 47, 77, 112, 57, 115, 57, 56, 61, 51, 108, 89,
  117, 67, 100, 99, 107, 121, 36, 101, 100, 113, 70, 108, 37, 79, 55, 47,
  49, 72, 114, 73, 56, 78, 64, 85, 122, 33, 99, 37, 76, 75, 33, 108,
  110, 117, 88, 114, 115, 73, 80, 110, 47, 118, 97, 37, 114, 89, 85, 71];
const FELD_PRAEFIX = 'v2#';
const PBKDF2_PRAEFIX = 'v0hGiXNmbzJdhMvx8BRMrg==';
const te = new TextEncoder();
const td = new TextDecoder('utf-8');

// --- Entschlüsselung ---------------------------------------------------------
export function rc4Schluessel() {
  const roh = new Uint8Array(Int8Array.from(C).buffer);
  const dv = new DataView(roh.buffer);
  let y = dv.getInt32(0), z = dv.getInt32(4);
  const [a, b, c, d] = TEA_KEY;
  let summe = Math.imul(DELTA, 64);
  for (let i = 0; i < 64; i++) {
    z = (z - ((((y << 4) + c) | 0) ^ ((y + summe) | 0) ^ (((y >> 5) + d) | 0))) | 0;
    y = (y - ((((z << 4) + a) | 0) ^ ((z + summe) | 0) ^ (((z >> 5) + b) | 0))) | 0;
    summe = (summe - DELTA) | 0;
  }
  dv.setInt32(0, y); dv.setInt32(4, z);
  return roh;
}

export function rc4(schluessel, daten) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + schluessel[i % schluessel.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const aus = new Uint8Array(daten.length);
  for (let k = 0, i = 0, j = 0; k < daten.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    aus[k] = daten[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return aus;
}

async function gunzip(bytes) {
  const strom = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(strom).arrayBuffer());
}

const hexBytes = (hex) => Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
const base64Bytes = (text) => Uint8Array.from(atob(text), (z) => z.charCodeAt(0));

async function feldSchluessel(ksi) {
  const basis = await crypto.subtle.importKey('raw', te.encode(PBKDF2_PRAEFIX + ksi.slice(0, 32)), 'PBKDF2', false, ['deriveKey']);
  const schluessel = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: hexBytes(ksi.slice(32, 64)), iterations: 1000, hash: 'SHA-256' },
    basis, { name: 'AES-CBC', length: 128 }, false, ['decrypt']);
  return { schluessel, iv: hexBytes(ksi.slice(64, 96)) };
}

// Alle „v2#“-Werte ersetzen; liefert die Anzahl. Nicht entschlüsselbare bleiben stehen.
async function felderEntschluesseln(objekt, aes) {
  let anzahl = 0;
  const gehe = async (wert) => {
    if (Array.isArray(wert)) { for (let i = 0; i < wert.length; i++) wert[i] = await gehe(wert[i]); return wert; }
    if (wert && typeof wert === 'object') { for (const k of Object.keys(wert)) wert[k] = await gehe(wert[k]); return wert; }
    if (typeof wert === 'string' && wert.startsWith(FELD_PRAEFIX)) {
      try {
        const klar = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: aes.iv }, aes.schluessel, base64Bytes(wert.slice(FELD_PRAEFIX.length)));
        anzahl++;
        return td.decode(klar);
      } catch { return wert; }
    }
    return wert;
  };
  await gehe(objekt);
  return anzahl;
}

// .cfg-Bytes → JSON-Objekt (+ Zahl entschlüsselter Felder). Wirft bei fremden Dateien.
export async function omadaEntschluesseln(bytes) {
  const gz = rc4(rc4Schluessel(), bytes);
  if (gz[0] !== 0x1f || gz[1] !== 0x8b) throw new Error('Keine Omada-Sicherung: nach der Entschlüsselung kein gzip-Strom (falsche Datei oder unbekanntes Format).');
  const json = JSON.parse(td.decode(await gunzip(gz)));
  const ksi = json?.systemSetting?.pbkdf2KeySaltIv;
  const felder = typeof ksi === 'string' && ksi.length >= 96 ? await felderEntschluesseln(json, await feldSchluessel(ksi)) : 0;
  return { json, felder };
}

// --- Aufbereitung für Baum und Übersicht ---------------------------------------
export async function oeffneOmada(file) {
  return omadaAusBytes(file.name, new Uint8Array(await file.arrayBuffer()));
}

export async function omadaAusBytes(name, bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const { json, felder } = await omadaEntschluesseln(bytes);
  const text = JSON.stringify(json, null, 2);
  return { name, size: bytes.length, art: 'omada', dateiart: 'cfg', roh: bytes, files: new Map([[name, bytes]]), quelle: name,
    json, exportText: text, zeilen: text.split('\n').length, entschluesselteFelder: felder, ...aufbereiten(json, felder) };
}

const istObjekt = (w) => w && typeof w === 'object' && !Array.isArray(w);
const kurz = (w) => (typeof w === 'string' ? w : JSON.stringify(w));

// Objekt → flache Felder („wlan.ssid“), Arrays aus Grundwerten als Liste.
function flach(objekt, praefix = '', felder = [], tiefe = 0) {
  for (const [k, w] of Object.entries(objekt || {})) {
    const name = praefix ? `${praefix}.${k}` : k;
    if (istObjekt(w) && tiefe < 6) flach(w, name, felder, tiefe + 1);
    else if (Array.isArray(w) && w.length && w.every((x) => !x || typeof x !== 'object')) felder.push({ name, typName: 'liste', anzeige: w.join(', '), idHex: null });
    else if (Array.isArray(w)) felder.push({ name, typName: 'liste', anzeige: w.length ? `${w.length} Einträge` : '(leer)', idHex: null });
    else felder.push({ name, typName: w === null ? 'leer' : typeof w === 'boolean' ? 'bool' : typeof w === 'number' ? 'zahl' : 'text', anzeige: w === null ? '' : String(w), idHex: null });
  }
  return felder;
}

function titelVon(eintrag, nr) {
  for (const k of ['name', 'ssid', 'siteName', 'username', 'userName', 'mac', 'ip', 'key', 'id', '_id']) {
    const w = eintrag?.[k];
    if (w !== undefined && w !== null && w !== '' && typeof w !== 'object') return String(w);
  }
  return `#${nr}`;
}

function satz(eintrag, nr) {
  const felder = istObjekt(eintrag) ? flach(eintrag) : [{ name: 'wert', typName: typeof eintrag, anzeige: kurz(eintrag), idHex: null }];
  const titel = istObjekt(eintrag) ? titelVon(eintrag, nr) : String(eintrag).slice(0, 60);
  const quelle = JSON.stringify(eintrag, null, 2);
  return { nr, titel, felder, roh: null, quelle: quelle.length > 20000 ? `${quelle.slice(0, 20000)}\n…` : quelle, zeileNr: null,
    text: `${titel} ${felder.map((f) => `${f.name} ${f.anzeige}`).join(' ')}`.toLowerCase() };
}

// Rubriken: zuerst je Site „Site <Name> › <Bereich> › <Liste>“, dann „Controller › …“. Listen aus
// Objekten = je Eintrag ein Datensatz; einfache Werte eines Bereichs = ein Datensatz „(Einstellungen)“.
const hatObjektListe = (w) => Array.isArray(w) && w.some((x) => x && typeof x === 'object');
function rubrikenAus(json) {
  const rubriken = [];
  const dazu = (pfad, saetze) => { if (saetze.length) rubriken.push({ schluessel: pfad, pfad, saetze }); };
  const bereich = (wert, pfad, tiefe) => {
    if (Array.isArray(wert)) { if (hatObjektListe(wert)) dazu(pfad, wert.map((e, i) => satz(e, i + 1))); return; }
    if (!istObjekt(wert)) return;
    const einfach = {};
    for (const [k, w] of Object.entries(wert)) {
      const komplex = hatObjektListe(w) || (istObjekt(w) && Object.values(w).some((x) => hatObjektListe(x) || istObjekt(x)));
      if (komplex && tiefe < 4) bereich(w, `${pfad} › ${k}`, tiefe + 1);
      else einfach[k] = w;
    }
    if (Object.keys(einfach).length) dazu(pfad, [{ ...satz(einfach, 1), titel: '(Einstellungen)' }]);
  };
  (Array.isArray(json.sites) ? json.sites : []).forEach((s, i) => {
    const name = s?.site?.name || `${i + 1}`;
    for (const [k, w] of Object.entries(s || {})) bereich(w, `Site ${name} › ${k}`, 1);
  });
  for (const [k, w] of Object.entries(json)) if (k !== 'sites') bereich(w, `Controller › ${k}`, 1);
  return rubriken;
}

// Rekursiv alle Objekte mit einer der Schlüsselgruppen finden (für WLANs/Netze/Geräte in unbekannter Tiefe).
function sammle(json, passt, grenze = 500) {
  const treffer = [];
  const gehe = (w, pfad) => {
    if (treffer.length >= grenze) return;
    if (Array.isArray(w)) w.forEach((x) => gehe(x, pfad));
    else if (istObjekt(w)) { if (passt(w, pfad)) treffer.push({ objekt: w, pfad }); for (const [k, x] of Object.entries(w)) gehe(x, `${pfad}.${k}`); }
  };
  gehe(json, '');
  return treffer;
}

function aufbereiten(json, felder) {
  const rubriken = rubrikenAus(json);
  const info = json.mainInfo || {};
  const version = String(info.softVer || info.ver || '').match(/\d+\.\d+\.\d+(?:\.\d+)?/)?.[0] || null;
  const name = json.omadacSetting?.omadacSetting?.name || null;
  const sites = (Array.isArray(json.sites) ? json.sites : []).map((s) => s?.site).filter(Boolean)
    .map((s) => ({ name: s.name, region: s.region, timeZone: s.timeZone, scenario: s.scenario }));
  const wlans = sammle(json, (o) => typeof o.ssid === 'string' || (typeof o.name === 'string' && 'security' in o && 'band' in o))
    .map(({ objekt: o, pfad }) => ({ profil: o.name || pfad.split('.').pop(), ssid: o.ssid || o.name, sicherheit: o.security ?? o.securityMode ?? null, vlan: o.vlanId ?? o.vlan ?? null, aktiv: o.enable !== false && o.disable !== true }));
  const netze = sammle(json, (o, p) => /lanNetworks$/.test(p) || typeof o.gatewaySubnet === 'string')
    .map(({ objekt: o }) => ({ name: o.name, subnetz: o.gatewaySubnet || o.subnet || '', vlan: o.vlan ?? o.vlanId ?? null, zweck: o.purpose === 'vlan' ? 'nur VLAN' : o.purpose === 'interface' ? 'mit Gateway' : (o.purpose || '') }));
  // Konten: tenant[].iamUser (Hauptadmin zuerst). Omada übernimmt sie beim Wiederherstellen nicht.
  const admins = (Array.isArray(json.tenant) ? json.tenant : []).map((t) => t?.iamUser).filter((u) => u?.username)
    .map((u) => ({ benutzer: u.username, email: u.email || '', rolle: u.roleName || u.role || '' }));
  const geraete = sammle(json, (o) => typeof o.mac === 'string' && /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(o.mac) && ('model' in o || 'type' in o))
    .map(({ objekt: o }) => ({ name: o.name || o.mac, mac: o.mac, modell: o.model || o.showModel || null, typ: o.type ?? null, ip: o.ip || null }));
  const adressen = netze.map((n) => { const [adresse, prefix] = String(n.subnetz || '').split('/'); return { adresse, prefix: prefix ? Number(prefix) : null, schnittstelle: n.name, name: n.vlan != null ? `VLAN ${n.vlan}` : null }; }).filter((a) => a.adresse);
  const hinweise = [`Entschlüsselt im Browser (RC4 + gzip)${felder ? `, dazu ${felder} verschlüsselte Einzelwerte (v2#)` : ''}.`];
  hinweise.push('Passwörter von WLANs und RADIUS stehen nach der Entschlüsselung im Klartext – Datei vertraulich behandeln.');
  if (version) hinweise.push(`Wiederherstellen geht nur in Omada ${version} oder neuer.`);
  return {
    type: 'Omada-Controller-Backup (.cfg)', identitaet: name, rubriken, sites, wlans, netze, geraete, admins, adressen, verschluesselt: false, unbekannt: !rubriken.length,
    geraet: { hersteller: 'TP-Link', variante: info.controllerType || 'Omada Controller', modell: null, firmware: version ? `Omada ${version}` : null, hostname: name },
    version: { anzeige: version ? `Omada Controller ${version}` : 'Controller-Version unbekannt', genau: version, hauptversion: version?.split('.')[0] || null, hinweise },
  };
}
