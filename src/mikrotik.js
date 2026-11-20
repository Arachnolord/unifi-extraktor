// FAH-Extraktor · src/mikrotik.js — Urheber: Fabian Hammer © 2026
// Hülle um den RouterOS-Decoder (mikrotik-backup.js): macht aus einer .backup- oder
// .rsc-Datei dieselbe Grundform, die main.js von openBackup() kennt (name, size,
// type, files), plus alles für die MikroTik-Ansichten: Rubriken → Datensätze →
// Felder (lesbar gemacht), Adressen für den Zugangsweg der virtuellen Vorschau,
// Versionserkennung, Volltextsuche und Hex-Dump. Läuft im Browser und in Node
// (Tests rufen mikrotikAusBytes ohne File-Objekt).
//
// Belegt am echten CCR2004-Backup (RouterOS 7, siehe scratchpad/format/SPEZIFIKATION.md):
//   net/devices  : Satz-Index (anzeige) = Schnittstellen-Index; 0x010006 Name,
//                  0x010001 Typ (1 Ethernet, 12 Bridge, 30 VLAN – empirisch), 0x010009 MAC-Text
//   net/addrs    : 0x01 Adresse, 0x02 Netz, 0x03 Maske, 0x04 Broadcast (je 4 Byte Netzreihenfolge),
//                  0x05 Träger-Index, 0xFE0009 Name, 0xFE000A disabled
//   hotspot/iface: 0x01 Träger-Index, 0xFE000A disabled
//   dhcp/client  : 0x02 Träger-Index (Uplink), 0xFE000A disabled
//   system       : 0x0C Identität
import { parseBackup, versionErkennen, rubrikFuer, alsIp, alsMac, MAGIC_KLARTEXT, MAGIC_RC4, MAGIC_AES } from './mikrotik-backup.js';

const td = new TextDecoder('utf-8', { fatal: false });
const te = new TextEncoder();

// Gültige CHR-Versionsangabe (gleiche Regel wie im Backend).
export const CHR_VERSION_MUSTER = /^\d+\.\d+(\.\d+)?(rc\d+|beta\d+)?$/;
export const istChrVersion = (text) => CHR_VERSION_MUSTER.test(String(text || '').trim());

// Datei (Browser) → Backup-Objekt.
export async function oeffneMikrotik(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return mikrotikAusBytes(file.name, bytes);
}

// Rohbytes → Backup-Objekt (auch für Node-Tests).
export function mikrotikAusBytes(name, bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const dateiart = dateiartErkennen(name, bytes);
  const basis = { name, size: bytes.length, art: 'mikrotik', dateiart, files: new Map([[name, bytes]]), roh: bytes };
  return dateiart === 'rsc'
    ? { ...basis, type: 'RouterOS-Export (.rsc)', ...rscLesen(bytes) }
    : { ...basis, type: 'RouterOS-Backup (.backup)', ...backupLesen(bytes) };
}

function dateiartErkennen(name, bytes) {
  const endung = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (endung === 'rsc') return 'rsc';
  if (endung === 'backup') return 'backup';
  if (bytes.length >= 8) {
    const magic = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
    if (magic === MAGIC_KLARTEXT || magic === MAGIC_RC4 || magic === MAGIC_AES) return 'backup';
  }
  const anfang = td.decode(bytes.subarray(0, 64)).trimStart();
  if (anfang.startsWith('#') || anfang.startsWith('/')) return 'rsc';
  throw new Error('Keine RouterOS-Sicherung: weder ein .backup-Dateikopf noch ein .rsc-Export erkannt.');
}

// ---------------------------------------------------------------------------
// .backup (binär)
// ---------------------------------------------------------------------------
const TYP_NAMEN = { 0x00: 'bool', 0x08: 'ganzzahl', 0x10: 'ganzzahl', 0x18: 'rohbytes', 0x20: 'string', 0x28: 'nachricht', 0x30: 'rohbytes' };

// Bekannte Feldnamen je Rubrik (aus der Spezifikation; „?“ = plausibel, nicht belegt).
const FELDER_GLOBAL = { 0xFE0009: 'comment/name', 0xFE000A: 'disabled', 0xFE0001: 'nr', 0xFE0005: 'nr2?', 0xFE0008: 'flag?', 0xFE0007: 'flag?' };
const FIREWALL = { 0x27: 'chain', 0x59: 'address-list?', 0x32: 'src-address-from?', 0x33: 'src-address-to?' };
const FELDER = {
  'user': { 0x01: 'name', 0x02: 'group?', 0x20: 'password-salt', 0x21: 'password-hash' },
  'net/addrs': { 0x01: 'address', 0x02: 'network', 0x03: 'netmask', 0x04: 'broadcast', 0x05: 'interface', 0x0A: 'interface?' },
  'net/ipt-filter': FIREWALL, 'net/ipt-nat': FIREWALL, 'net/ipt-mangle': FIREWALL, 'net/ipt-raw': FIREWALL,
  'net/devices': { 0x010006: 'name', 0x010001: 'type', 0x010009: 'mac-address', 0x010010: 'slot', 0x010030: 'mac-address?', 0x000404: 'mac (current)', 0x0003E9: 'mac (default)' },
  'hotspot/iface': { 0x01: 'interface', 0x8B: 'name?', 0x86: 'profile?', 0x79: 'dns-name?', 0xFE0010: 'name?' },
  'dhcp/client': { 0x02: 'interface' },
  'dhcp/server/server': { 0x07: 'interface', 0x09: 'name', 0x05: 'lease-time?' },
  'bridgeports': { 0x03: 'interface', 0x04: 'bridge' },
  'system': { 0x0C: 'identity', 0x1A: 'time-zone' },
};
// Felder, die eine IPv4-Adresse in Netzreihenfolge tragen (4-Byte-Ganzzahl).
const IP_FELDER = { 'net/addrs': [0x01, 0x02, 0x03, 0x04], 'net/ipt-filter': [0x32, 0x33], 'net/ipt-nat': [0x32, 0x33], 'net/ipt-mangle': [0x32, 0x33], 'net/ipt-raw': [0x32, 0x33], 'hotspot/iface': [0x68] };
// Felder, die auf eine Schnittstelle (Index in net/devices) verweisen.
const IFACE_FELDER = { 'net/addrs': [0x05, 0x0A], 'hotspot/iface': [0x01], 'dhcp/client': [0x02], 'dhcp/server/server': [0x07], 'bridgeports': [0x03, 0x04] };
// Titel eines Datensatzes: Feld-ID oder Funktion; sonst 0xFE0009, sonst erster String.
const TITEL = {
  'user': 0x01, 'net/devices': 0x010006, 'dhcp/server/server': 0x09, 'system': 0x0C,
  'net/addrs': (s) => { const a = feldRoh(s, 0x01), m = feldRoh(s, 0x03); return a ? `${alsIp(a)}/${m ? maskeZuPrefix(alsIp(m)) : '?'}` : null; },
};

const feldVon = (satz, id) => satz.felder.find((f) => f.id === id);
const feldRoh = (satz, id) => { const f = feldVon(satz, id); return f && f.roh && f.roh.length >= 4 ? f.roh : null; };
const feldText = (satz, id) => { const f = feldVon(satz, id); return f && typeof f.wert === 'string' ? f.wert : null; };
const feldZahl = (satz, id) => { const f = feldVon(satz, id); return f && typeof f.wert === 'number' ? f.wert : null; };
const feldBool = (satz, id) => { const f = feldVon(satz, id); return f && typeof f.wert === 'boolean' ? f.wert : null; };

export function maskeZuPrefix(maske) {
  return String(maske).split('.').reduce((n, o) => n + ((Number(o) >>> 0).toString(2).match(/1/g) || []).length, 0);
}
export function istPrivat(ip) {
  const [a, b] = String(ip).split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function hex(roh, max = 48) {
  const n = Math.min(roh.length, max);
  let s = '';
  for (let i = 0; i < n; i++) s += roh[i].toString(16).padStart(2, '0');
  return roh.length > max ? `${s}… (${roh.length} Byte)` : s;
}

function backupLesen(bytes) {
  const p = parseBackup(bytes);
  const leer = { identitaet: null, rubriken: [], adressen: [], bridges: [], vlans: [], hotspots: [], ports: [], wan: null, zugangVorschlag: null, exportText: null, endeOk: false };
  if (p.verschluesselt) {
    return { ...leer, verschluesselt: true, magic: p.magic, version: {
      hauptversion: null, mindestens: null, genau: null,
      anzeige: 'verschlüsselt – Rubriken erst nach Entschlüsselung (in Vorbereitung)',
      hinweise: [p.hinweis || 'Backup ist verschlüsselt.', 'Virtuell öffnen geht nur mit unverschlüsselten Backups: auf dem Router mit „/system backup save dont-encrypt=yes“ erneut sichern.'],
    } };
  }
  if (!p.eintraege || (!p.eintraege.length && p.hinweis)) {
    // Fremder Dateikopf: leerer Baum mit klarer Anzeige statt Abbruch.
    return { ...leer, verschluesselt: false, magic: p.magic ?? null, unbekannt: true, version: {
      hauptversion: null, mindestens: null, genau: null,
      anzeige: `keine RouterOS-Sicherung erkannt (${p.hinweis || 'leere Datei'})`,
      hinweise: ['Die Datei hat keinen bekannten RouterOS-Dateikopf. Bitte ein .backup oder einen .rsc-Export vom Router wählen.'],
    } };
  }

  // Schnittstellen-Verzeichnis: Index → {name, typ, mac}
  const geraete = new Map();
  for (const s of (p.eintraege.find((e) => e.name === 'net/devices')?.saetze || [])) {
    const name = feldText(s, 0x010006);
    if (!name) continue;
    const typ = feldZahl(s, 0x010001);
    const macRoh = feldVon(s, 0x000404)?.roh;
    geraete.set(s.anzeige, { name, typ, mac: feldText(s, 0x010009) || (macRoh && macRoh.length === 6 ? alsMac(macRoh) : null) });
  }
  const istBridge = (g) => Boolean(g) && (g.typ === 12 || (g.typ == null && /^bridge/i.test(g.name)));
  const istVlan = (g) => Boolean(g) && (g.typ === 30 || (g.typ == null && /^vlan/i.test(g.name)));
  const bridges = [...geraete.values()].filter(istBridge).map((g) => g.name);
  const vlans = [...geraete.values()].filter(istVlan).map((g) => g.name);
  const hotspots = [];
  for (const s of (p.eintraege.find((e) => e.name === 'hotspot/iface')?.saetze || [])) {
    if (feldBool(s, 0xFE000A) === true) continue; // deaktivierter Hotspot-Server
    const g = geraete.get(feldZahl(s, 0x01));
    if (g && !hotspots.includes(g.name)) hotspots.push(g.name);
  }
  const ports = [...geraete.values()].filter((g) => g.typ === 1).map((g) => ({ name: g.name, defaultName: g.name, mac: g.mac }));

  // Adressen
  const adressen = [];
  for (const s of (p.eintraege.find((e) => e.name === 'net/addrs')?.saetze || [])) {
    const a = feldRoh(s, 0x01);
    if (!a) continue;
    const maske = feldRoh(s, 0x03);
    const netz = feldRoh(s, 0x02);
    const traeger = geraete.get(feldZahl(s, 0x05) ?? feldZahl(s, 0x0A)) || null;
    const schnittstelle = traeger ? traeger.name : null;
    adressen.push({
      adresse: alsIp(a), prefix: maske ? maskeZuPrefix(alsIp(maske)) : 32, netz: netz ? alsIp(netz) : null,
      name: feldText(s, 0xFE0009) || null, schnittstelle, disabled: feldBool(s, 0xFE000A) === true,
      bridge: istBridge(traeger), vlan: istVlan(traeger), hotspot: Boolean(schnittstelle) && hotspots.includes(schnittstelle),
    });
  }

  // Uplink: DHCP-Client (erster aktiver), sonst Adresse auf einer Nicht-Bridge außerhalb privater Netze
  let wan = null;
  for (const s of (p.eintraege.find((e) => e.name === 'dhcp/client')?.saetze || [])) {
    if (feldBool(s, 0xFE000A) === true) continue;
    const g = geraete.get(feldZahl(s, 0x02));
    if (g) { wan = { schnittstelle: g.name, adresse: null, dhcp: true }; break; }
  }
  wan ||= wanAusAdressen(adressen);

  // Identität
  let identitaet = null;
  for (const s of (p.eintraege.find((e) => e.name === 'system')?.saetze || [])) {
    const t = feldText(s, 0x0C);
    if (t) { identitaet = t; break; }
  }

  // Rubriken
  const rubriken = p.eintraege.map((e) => {
    const saetze = [];
    let q = 0;
    e.index.forEach((ix, i) => {
      const roh = e.daten.subarray(q, q + ix.groesse); q += ix.groesse;
      const s = e.saetze[i];
      if (!s) return;
      const felder = s.felder.map((f) => feldAufbereiten(e.name, f, geraete));
      const titel = titelVon(e.name, s, felder);
      saetze.push({ nr: i + 1, anzeige: s.anzeige, titel, felder, roh, fehler: s.fehler, text: suchtext(titel, felder) });
    });
    return { schluessel: e.name, pfad: rubrikFuer(e.name), saetze };
  }).sort(rubrikSortierung);

  const erkannt = versionErkennen(p);
  const hauptversion = erkannt.hauptversion === '7' || erkannt.hauptversion === '6' ? erkannt.hauptversion : null;
  const mindestens = erkannt.mindestversion ? (erkannt.mindestversion.match(/≥\s*([\d.]+)/)?.[1] || null) : null;
  const hinweise = [...erkannt.hinweise];
  if (!p.endeOk) hinweise.push('Die Datei endet nicht exakt am letzten Eintrag – sie könnte abgeschnitten sein.');
  const version = {
    hauptversion, mindestens, genau: null,
    anzeige: hauptversion ? `RouterOS ${hauptversion}${mindestens ? ` (mindestens ${mindestens})` : ''}` : 'unbekannt',
    hinweise,
  };
  return { ...leer, verschluesselt: false, magic: p.magic, endeOk: Boolean(p.endeOk), version, identitaet, rubriken, adressen, bridges, vlans, hotspots, ports, wan, zugangVorschlag: zugangVorschlagVon(adressen) };
}

function feldAufbereiten(rubrik, f, geraete) {
  const familie = f.typ & 0x7E;
  const array = (f.typ & 0x80) !== 0;
  const typName = array ? 'array' : (TYP_NAMEN[familie] || 'unbekannt');
  const name = FELDER[rubrik]?.[f.id] ?? FELDER_GLOBAL[f.id] ?? null;
  return { name, id: f.id, idHex: '0x' + f.id.toString(16).padStart(6, '0'), typ: f.typ, typName, wert: f.wert, roh: f.roh, anzeige: anzeigeVon(rubrik, f, familie, array, geraete, 0) };
}

function anzeigeVon(rubrik, f, familie, array, geraete, tiefe) {
  if (array) {
    const teile = (f.wert || []).map((w) => {
      if (w instanceof Uint8Array) return w.length === 6 ? alsMac(w) : hex(w, 16);
      if (w && typeof w === 'object' && w.felder) return `{${w.felder.length} Felder}`;
      return String(w);
    });
    const text = teile.join(', ');
    return `[${f.wert?.length ?? 0}] ${text.length > 200 ? text.slice(0, 200) + '…' : text}`;
  }
  switch (familie) {
    case 0x00: return f.wert ? 'ja' : 'nein';
    case 0x08:
    case 0x10: {
      if (f.roh && f.roh.length === 4 && IP_FELDER[rubrik]?.includes(f.id)) return alsIp(f.roh);
      if (IFACE_FELDER[rubrik]?.includes(f.id) && geraete?.has(f.wert)) return `${f.wert} (${geraete.get(f.wert).name})`;
      return String(f.wert);
    }
    case 0x20: return f.wert;
    case 0x28: {
      const felder = f.wert?.felder || [];
      if (tiefe >= 2) return `{${felder.length} Felder}`;
      const innen = felder.map((g) => `${'0x' + g.id.toString(16)}=${anzeigeVon(rubrik, g, g.typ & 0x7E, (g.typ & 0x80) !== 0, geraete, tiefe + 1)}`).join('; ');
      return `{${innen.length > 240 ? innen.slice(0, 240) + '…' : innen}}`;
    }
    case 0x18: return f.roh ? hex(f.roh, 16).replace(/(.{4})(?=.)/g, '$1:') : '';
    case 0x30: return f.roh ? (f.roh.length === 6 ? alsMac(f.roh) : hex(f.roh)) : '';
    default: return f.roh ? hex(f.roh) : String(f.wert ?? '');
  }
}

function titelVon(rubrik, satz, felder) {
  const t = TITEL[rubrik];
  const name = feldText(satz, 0xFE0009);
  // Adressen: IP/Präfix vorn, Name dahinter („10.10.0.1/16 · uplink“)
  if (typeof t === 'function') { const w = t(satz); if (w) return name ? `${w} · ${name}` : w; }
  else if (t !== undefined) { const w = feldText(satz, t); if (w) return w; }
  if (name) return name;
  const erster = felder.find((f) => f.typName === 'string' && typeof f.wert === 'string' && f.wert.trim());
  return erster ? erster.wert : `#${satz.anzeige}`;
}

function suchtext(titel, felder) {
  return `${titel} ${felder.map((f) => `${f.name || ''} ${f.anzeige}`).join(' ')}`.toLowerCase();
}

function rubrikSortierung(a, b) {
  return a.pfad.localeCompare(b.pfad, 'de') || a.schluessel.localeCompare(b.schluessel, 'de');
}

function wanAusAdressen(adressen) {
  const a = adressen.find((x) => !x.disabled && !x.bridge && !x.vlan && !istPrivat(x.adresse) && x.schnittstelle);
  return a ? { schnittstelle: a.schnittstelle, adresse: `${a.adresse}/${a.prefix}`, dhcp: false } : null;
}

// Vorgabe für den Zugangsweg: 192.168.250.x → erste Bridge-Adresse → erste private → erste.
// Hotspot- und VLAN-Träger sowie deaktivierte Adressen werden nie vorgeschlagen.
export function zugangVorschlagVon(adressen) {
  const kandidaten = adressen.filter((a) => !a.disabled && !a.hotspot && !a.vlan && a.prefix >= 8 && a.prefix <= 30);
  const treffer = kandidaten.find((a) => /^192\.168\.250\./.test(a.adresse))
    || kandidaten.find((a) => a.bridge)
    || kandidaten.find((a) => istPrivat(a.adresse))
    || kandidaten[0];
  return treffer ? { modus: 'lokal', ip: treffer.adresse, prefix: treffer.prefix } : null;
}

// ---------------------------------------------------------------------------
// .rsc (Text-Export)
// ---------------------------------------------------------------------------
const WOERTER = { ip: 'IP', ipv6: 'IPv6', dhcp: 'DHCP', ppp: 'PPP', pppoe: 'PPPoE', snmp: 'SNMP', dns: 'DNS', nat: 'NAT', ntp: 'NTP', mpls: 'MPLS', bgp: 'BGP', ospf: 'OSPF', rip: 'RIP', vlan: 'VLAN', l2tp: 'L2TP', pptp: 'PPTP', sstp: 'SSTP', ipsec: 'IPsec', wireguard: 'WireGuard', ssh: 'SSH', www: 'WWW', api: 'API', lte: 'LTE', upnp: 'UPnP', arp: 'ARP', eoip: 'EoIP', gre: 'GRE', vrrp: 'VRRP', cpu: 'CPU', led: 'LED', leds: 'LEDs', poe: 'PoE', sfp: 'SFP', mac: 'MAC', tftp: 'TFTP', smb: 'SMB', radius: 'RADIUS', wifi: 'WiFi', capsman: 'CAPsMAN', id: 'ID', ntp_client: 'NTP Client', usb: 'USB', romon: 'RoMON', socks: 'SOCKS', udp: 'UDP', tcp: 'TCP', ssl: 'SSL', tls: 'TLS', ovpn: 'OpenVPN', vpls: 'VPLS', vxlan: 'VXLAN', bfd: 'BFD', bth: 'Back To Home', wps: 'WPS', mdns: 'mDNS', lldp: 'LLDP', mikrotik: 'MikroTik', routerboard: 'RouterBOARD', ups: 'UPS', dot1x: '802.1X', cap: 'CAP' };
function pfadLesbar(pfad) {
  return pfad.replace(/^\//, '').trim().split(/\s+/).filter(Boolean).map((w) => WOERTER[w] || w.split('-').map((t) => WOERTER[t] || (t.charAt(0).toUpperCase() + t.slice(1))).join(' ')).join(' › ');
}

// Zerlegt eine Export-Zeile in Token; Anführungszeichen und [ … ]-Gruppen bleiben zusammen.
function tokenisieren(zeile) {
  const token = [];
  let akt = '', inZitat = false, tiefe = 0, hatte = false;
  for (let i = 0; i < zeile.length; i++) {
    const c = zeile[i];
    if (inZitat) {
      if (c === '\\' && i + 1 < zeile.length) { akt += c + zeile[++i]; continue; }
      if (c === '"') { inZitat = false; akt += c; continue; }
      akt += c; continue;
    }
    if (c === '"') { inZitat = true; akt += c; hatte = true; continue; }
    if (c === '[') { tiefe++; akt += c; hatte = true; continue; }
    if (c === ']') { tiefe = Math.max(0, tiefe - 1); akt += c; continue; }
    if (/\s/.test(c) && tiefe === 0) { if (hatte) token.push(akt); akt = ''; hatte = false; continue; }
    akt += c; hatte = true;
  }
  if (hatte) token.push(akt);
  return token;
}

// RouterOS-Zeichenkette ohne Anführungszeichen und mit aufgelösten Escapes.
function entquoten(wert) {
  if (wert.length >= 2 && wert.startsWith('"') && wert.endsWith('"')) wert = wert.slice(1, -1);
  return wert.replace(/\\(x[0-9A-Fa-f]{2}|[\s\S])/g, (m, e) => {
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: '\n', r: '\r', t: '\t', _: ' ', a: '\x07', b: '\b', f: '\f', v: '\v' }[e] ?? e;
  });
}

function rscLesen(bytes) {
  const exportText = td.decode(bytes);
  const roheZeilen = exportText.split(/\r?\n/);

  // Kopf: Version, Modell
  let genau = null, modell = null, seriennummer = null;
  for (const z of roheZeilen.slice(0, 12)) {
    if (!z.startsWith('#')) break;
    genau ||= z.match(/by RouterOS (\d+\.\d+(?:\.\d+)?(?:rc\d+|beta\d+)?)/i)?.[1] || null;
    modell ||= z.match(/^#\s*model\s*=\s*(.+)$/i)?.[1]?.trim() || null;
    seriennummer ||= z.match(/^#\s*serial number\s*=\s*(.+)$/i)?.[1]?.trim() || null;
  }

  // Fortsetzungszeilen (Backslash am Zeilenende) zusammenziehen
  const logisch = [];
  let offen = null, startNr = 0;
  roheZeilen.forEach((roh, i) => {
    let z = roh;
    if (offen !== null) z = offen + z.replace(/^\s+/, '');
    else startNr = i + 1;
    if (/\\$/.test(z) && !/\\\\$/.test(z)) { offen = z.slice(0, -1); return; }
    offen = null;
    logisch.push({ text: z, nr: startNr });
  });

  // Abschnitte und Datensätze
  const rubrikMap = new Map();
  let pfad = null;
  for (const { text, nr } of logisch) {
    const z = text.trim();
    if (!z || z.startsWith('#')) continue;
    if (z.startsWith('/')) { pfad = z.replace(/\s+/g, ' '); if (!rubrikMap.has(pfad)) rubrikMap.set(pfad, []); continue; }
    if (!pfad) continue;
    const token = tokenisieren(z);
    if (!token.length) continue;
    const felder = [{ name: 'befehl', wert: token[0] }];
    for (const t of token.slice(1)) {
      if (t.startsWith('[')) {
        for (const inner of tokenisieren(t.slice(1, -1))) {
          const m = inner.match(/^([a-zA-Z0-9._-]+)=([\s\S]*)$/);
          if (m) felder.push({ name: m[1], wert: entquoten(m[2]) });
        }
        continue;
      }
      const m = t.match(/^([a-zA-Z0-9._-]+)=([\s\S]*)$/);
      if (m) felder.push({ name: m[1], wert: entquoten(m[2]) });
      else felder.push({ name: 'ziel', wert: entquoten(t) });
    }
    rubrikMap.get(pfad).push({ zeileNr: nr, zeile: z, felder });
  }

  const wert = (s, n) => s.felder.find((f) => f.name === n)?.wert ?? null;
  const saetzeVon = (p) => rubrikMap.get(p) || [];
  const istAktiv = (s) => wert(s, 'disabled') !== 'yes';

  const bridges = saetzeVon('/interface bridge').map((s) => wert(s, 'name')).filter(Boolean);
  const vlans = saetzeVon('/interface vlan').map((s) => wert(s, 'name')).filter(Boolean);
  const hotspots = saetzeVon('/ip hotspot').filter(istAktiv).map((s) => wert(s, 'interface')).filter(Boolean);
  const ports = saetzeVon('/interface ethernet').map((s) => ({ defaultName: wert(s, 'default-name'), name: wert(s, 'name') || wert(s, 'default-name'), mac: wert(s, 'mac-address') })).filter((p) => p.defaultName);

  const adressen = [];
  for (const s of saetzeVon('/ip address')) {
    const m = String(wert(s, 'address') || '').match(/^(\d+\.\d+\.\d+\.\d+)(?:\/(\d+))?$/);
    if (!m) continue;
    const schnittstelle = wert(s, 'interface');
    adressen.push({
      adresse: m[1], prefix: m[2] ? Number(m[2]) : 32, netz: wert(s, 'network'), name: wert(s, 'comment') || null, schnittstelle,
      disabled: !istAktiv(s), bridge: bridges.includes(schnittstelle), vlan: vlans.includes(schnittstelle), hotspot: hotspots.includes(schnittstelle),
    });
  }
  const dhcpClient = saetzeVon('/ip dhcp-client').find((s) => istAktiv(s) && wert(s, 'interface'));
  const wan = dhcpClient ? { schnittstelle: wert(dhcpClient, 'interface'), adresse: null, dhcp: true } : wanAusAdressen(adressen);
  const identitaet = saetzeVon('/system identity').map((s) => wert(s, 'name')).find(Boolean) || null;

  const rubriken = [...rubrikMap.entries()].map(([p, saetze]) => ({
    schluessel: p,
    pfad: pfadLesbar(p),
    saetze: saetze.map((s, i) => {
      const felder = s.felder.map((f, j) => ({ name: f.name, id: j, idHex: null, typ: null, typName: 'string', wert: f.wert, anzeige: f.wert, roh: null }));
      const titel = wert(s, 'name') || wert(s, 'comment') || wert(s, 'address') || wert(s, 'default-name') || wert(s, 'interface') || `${s.felder[0].wert} (Zeile ${s.zeileNr})`;
      return { nr: i + 1, anzeige: i + 1, titel, felder, roh: te.encode(s.zeile), zeileNr: s.zeileNr, fehler: null, text: `${titel} ${s.zeile}`.toLowerCase() };
    }),
  })).sort(rubrikSortierung);

  const hinweise = [];
  hinweise.push(genau ? `Export erstellt von RouterOS ${genau}.` : 'Keine RouterOS-Version in der Kopfzeile gefunden.');
  if (modell) hinweise.push(`Modell: ${modell}${seriennummer ? ` · Seriennummer ${seriennummer}` : ''}.`);
  hinweise.push('Ein Export enthält keine Benutzer und keine Passwörter (hide-sensitive). Die virtuelle Vorschau läuft deshalb mit admin und einem Wegwerf-Passwort.');
  const hauptversion = genau ? genau.split('.')[0] : null;
  return {
    verschluesselt: false, magic: null, endeOk: true,
    version: { hauptversion, mindestens: null, genau, anzeige: genau ? `RouterOS ${genau}` : 'unbekannt', hinweise, modell },
    identitaet, rubriken, adressen, bridges, vlans, hotspots, ports, wan, zugangVorschlag: zugangVorschlagVon(adressen), exportText,
  };
}

// ---------------------------------------------------------------------------
// Suche und Hex-Dump
// ---------------------------------------------------------------------------
// Volltextsuche über alle Rubriken (Pfad, Schlüssel, Feldnamen, Werte).
export function suche(backup, query, limit = 500) {
  const q = String(query || '').trim().toLowerCase();
  const treffer = [];
  if (!q) return treffer;
  for (const rubrik of backup.rubriken || []) {
    const rubrikTrifft = rubrik.pfad.toLowerCase().includes(q) || rubrik.schluessel.toLowerCase().includes(q);
    for (const satz of rubrik.saetze) {
      if (rubrikTrifft || satz.text.includes(q)) {
        treffer.push({ rubrik, satz });
        if (treffer.length >= limit) return treffer;
      }
    }
  }
  return treffer;
}

// Klassischer Hex-Dump: Offset (8 Hex-Stellen), 16 Byte je Zeile, ASCII-Spalte.
export function hexDump(bytes, maxBytes = 65536) {
  if (!bytes) return '';
  const n = Math.min(bytes.length, maxBytes);
  const zeilen = [];
  for (let o = 0; o < n; o += 16) {
    let hexTeil = '', ascii = '';
    for (let i = 0; i < 16; i++) {
      const pos = o + i;
      if (pos < n) {
        const b = bytes[pos];
        hexTeil += b.toString(16).padStart(2, '0') + ' ';
        ascii += b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.';
      } else hexTeil += '   ';
      if (i === 7) hexTeil += ' ';
    }
    zeilen.push(`${o.toString(16).padStart(8, '0')}  ${hexTeil} |${ascii}|`);
  }
  if (bytes.length > n) zeilen.push(`… ${bytes.length - n} weitere Byte nicht angezeigt`);
  return zeilen.join('\n');
}
