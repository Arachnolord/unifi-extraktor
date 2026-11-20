// FAH-Extraktor · src/ansicht.js — Urheber: Fabian Hammer © 2026
// Lesbare Ansicht für alle Hersteller: ein gemeinsamer Index (Rubrik → Datensatz → Felder),
// Suche über alles mit markierten Treffern, Tabellenspalten je Rubrik und „Das Wichtigste“
// für die erste Seite. UniFi-Collections werden dafür in dieselbe Form gebracht wie MikroTik,
// Aruba und Omada.
import { jsonValue } from './backup.js';

// Mitschau: Geheim bleibt ein Feld auch, solange es sichtbar ist (type=text hinter „Passwort anzeigen“).
export const istGeheim = (el) => el.type === 'password' || el.dataset?.geheim !== undefined;

const istObjekt = (w) => w && typeof w === 'object' && !Array.isArray(w);
// MikroTik kennt nicht jeden Feldnamen – dann zählt die Feld-ID („0x010006“).
export const feldName = (f) => f.name || f.idHex || '';
export const escapeHtml = (w) => String(w ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

// Objekt → flache Felder („x_passphrase“, „config.vlan“); Listen aus Grundwerten als Text.
export function flachFelder(objekt, praefix = '', aus = [], tiefe = 0) {
  for (const [k, w] of Object.entries(objekt || {})) {
    const name = praefix ? `${praefix}.${k}` : k;
    if (istObjekt(w) && tiefe < 5) flachFelder(w, name, aus, tiefe + 1);
    else if (Array.isArray(w)) {
      if (w.every((x) => !x || typeof x !== 'object')) aus.push({ name, typName: 'liste', anzeige: w.join(', ') });
      else if (tiefe < 3 && w.length <= 20) w.forEach((x, i) => (istObjekt(x) ? flachFelder(x, `${name}[${i + 1}]`, aus, tiefe + 1) : aus.push({ name: `${name}[${i + 1}]`, typName: 'wert', anzeige: String(x) })));
      else aus.push({ name, typName: 'liste', anzeige: `${w.length} Einträge` });
    } else aus.push({ name, typName: w === null ? 'leer' : typeof w, anzeige: w === null || w === undefined ? '' : String(w) });
  }
  return aus;
}

const TITEL_FELDER = ['name', 'desc', 'ssid', 'essid', 'hostname', 'key', 'mac', 'ip', 'email', 'title'];
function titelAus(o, nr) {
  for (const k of TITEL_FELDER) if (o?.[k] !== undefined && o[k] !== null && o[k] !== '' && typeof o[k] !== 'object') return String(o[k]);
  return `#${nr}`;
}

// UniFi: Collections mit sehr vielen Dokumenten (Statistiken, Ereignisse) nur angeschnitten indizieren.
const GRENZE_JE_COLLECTION = 5000;

// Gemeinsamer Index aller Arten, einmal je Backup berechnet.
export function indexVon(backup) {
  if (backup._index) return backup._index;
  let rubriken;
  if (backup.art === 'unifi') {
    rubriken = [...backup.collections.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, docs]) => {
      const saetze = docs.slice(0, GRENZE_JE_COLLECTION).map((doc, i) => {
        let o; try { o = JSON.parse(jsonValue(doc)); } catch { o = {}; }
        const felder = flachFelder(o);
        const titel = titelAus(o, i + 1);
        return { nr: i + 1, titel, felder, objekt: o, text: `${titel} ${felder.map((f) => `${f.name} ${f.anzeige}`).join(' ')}`.toLowerCase(), docIndex: i };
      });
      return { schluessel: name, pfad: name, saetze, gekuerzt: docs.length > GRENZE_JE_COLLECTION ? docs.length : 0 };
    });
  } else rubriken = backup.rubriken || [];
  backup._index = rubriken;
  return rubriken;
}

// Suche: alle Wörter müssen im Datensatz (oder im Rubrik-Pfad) vorkommen; je Treffer die passenden Felder.
export function sucheAlles(backup, eingabe, grenze = 300) {
  const woerter = String(eingabe || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!woerter.length || woerter.join('').length < 2) return { woerter, treffer: [], mehr: false };
  const treffer = [];
  for (const r of indexVon(backup)) {
    const pfad = r.pfad.toLowerCase();
    for (const s of r.saetze) {
      if (!woerter.every((w) => s.text.includes(w) || pfad.includes(w))) continue;
      const felder = s.felder.filter((f) => woerter.some((w) => `${feldName(f)} ${f.anzeige}`.toLowerCase().includes(w)));
      treffer.push({ rubrik: r, satz: s, felder });
      if (treffer.length >= grenze) return { woerter, treffer, mehr: true };
    }
  }
  return { woerter, treffer, mehr: false };
}

export function markiere(text, woerter) {
  let html = escapeHtml(text);
  for (const w of woerter) {
    if (!w) continue;
    const muster = new RegExp(escapeHtml(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    html = html.replace(muster, (m) => `<mark>${m}</mark>`);
  }
  return html;
}

// Tabellenspalten: häufige, kurze, aussagekräftige Felder; Kennungen und Geheimnisse nicht.
const WICHTIG = ['name', 'desc', 'description', 'comment', 'ssid', 'essid', 'hostname', 'purpose', 'vlan', 'vlanid', 'vlan_id', 'ip', 'address', 'ip_subnet', 'gatewaysubnet', 'subnet', 'network', 'mac', 'model', 'type', 'interface', 'port', 'security', 'wpa_mode', 'opmode', 'mode', 'role', 'enabled', 'enable', 'disabled', 'status', 'action', 'proto', 'dst_port', 'fwd', 'fwd_port', 'srcintf', 'dstintf', 'service', 'allowaccess', 'email', 'version'];
const NICHT = /(^_?id$|_id$|^x_|hash|secret|passw|passphrase|private|token|psk|key$|^attr_)/i;
// Kennungen in camelCase („siteId“) – aber wichtige Felder wie „vlanId“ bleiben.
const nichtSpalte = (blatt) => !WICHTIG.includes(blatt.toLowerCase()) && (NICHT.test(blatt) || /[a-z]Id$/.test(blatt));
export function spaltenFuer(rubrik, max = 6) {
  const stichprobe = rubrik.saetze.slice(0, 200);
  if (stichprobe.length < 2) return [];
  const zaehler = new Map();
  for (const s of stichprobe) for (const f of s.felder) {
    const n = feldName(f);
    if (!n || f.anzeige === '' || String(f.anzeige).length > 70 || n.includes('[')) continue;
    zaehler.set(n, (zaehler.get(n) || 0) + 1);
  }
  const blatt = (n) => n.split('.').pop().toLowerCase();
  return [...zaehler.entries()]
    .filter(([n, z]) => z >= Math.max(1, stichprobe.length * 0.25) && !nichtSpalte(n.split('.').pop()))
    .sort(([a, za], [b, zb]) => {
      const wa = WICHTIG.indexOf(blatt(a)), wb = WICHTIG.indexOf(blatt(b));
      return (wa < 0 ? 99 : wa) - (wb < 0 ? 99 : wb) || a.startsWith('0x') - b.startsWith('0x') || zb - za || a.length - b.length;
    })
    .slice(0, max).map(([n]) => n);
}
export const wertVon = (satz, name) => satz.felder.find((f) => feldName(f) === name)?.anzeige ?? '';

// --- „Das Wichtigste“ ----------------------------------------------------------
// Abschnitte { titel, spalten, zeilen, hinweis? }; leere Abschnitte fallen weg.
const abschnitt = (titel, spalten, zeilen, hinweis) => ({ titel, spalten, zeilen: zeilen.filter((z) => z.some((x) => x !== '' && x != null)), hinweis });
const ja = (w) => (w === true || w === 'true' ? 'an' : w === false || w === 'false' ? 'aus' : w ?? '');

function unifiWichtigstes(b) {
  const col = (n) => (b.collections.get(n) || []).map((d) => { try { return JSON.parse(jsonValue(d)); } catch { return {}; } });
  const sites = col('site');
  const siteName = new Map(sites.map((s) => [String(s._id?.$oid ?? s._id ?? ''), s.desc || s.name]));
  const netze = col('networkconf');
  const netzName = new Map(netze.map((n) => [String(n._id?.$oid ?? n._id ?? ''), `${n.name}${n.vlan ? ` (VLAN ${n.vlan})` : ''}`]));
  const site = (o) => (sites.length > 1 ? siteName.get(String(o.site_id)) || '' : '');
  const mitSite = sites.length > 1;
  return [
    abschnitt(`Sites (${sites.length})`, ['Name', 'Kurzname'], sites.map((s) => [s.desc || s.name, s.name])),
    abschnitt(`Netze (${netze.length})`, ['Name', 'Zweck', 'VLAN', 'Subnetz', 'DHCP', ...(mitSite ? ['Site'] : [])],
      netze.map((n) => [n.name, n.purpose, n.vlan || (n.purpose === 'corporate' ? '1 / ohne Tag' : ''), n.ip_subnet, n.dhcpd_enabled ? `an ${n.dhcpd_start || ''}–${n.dhcpd_stop || ''}` : '', ...(mitSite ? [site(n)] : [])])),
    abschnitt(`WLANs (${col('wlanconf').length})`, ['SSID', 'Sicherheit', 'Netz', 'Status', ...(mitSite ? ['Site'] : [])],
      col('wlanconf').map((w) => [w.name, [w.security, w.wpa_mode].filter(Boolean).join(' / '), netzName.get(String(w.networkconf_id)) || '', ja(w.enabled), ...(mitSite ? [site(w)] : [])])),
    abschnitt(`Geräte (${col('device').length})`, ['Name', 'Modell', 'Typ', 'IP', 'MAC', 'Firmware'],
      col('device').map((d) => [d.name || '', d.model, d.type, d.ip || d.config_network?.ip || '', d.mac, d.version])),
    abschnitt('Portweiterleitungen', ['Name', 'Protokoll', 'Port außen', 'Ziel', 'Status'],
      col('portforward').map((p) => [p.name, p.proto, p.dst_port, `${p.fwd}:${p.fwd_port}`, ja(p.enabled)])),
    abschnitt('Firewall-Regeln', ['Name', 'Regelsatz', 'Aktion', 'Status'],
      col('firewallrule').slice(0, 100).map((r) => [r.name, r.ruleset, r.action, ja(r.enabled)])),
    abschnitt('Administratoren', ['Name', 'E-Mail'], col('admin').map((a) => [a.name, a.email])),
  ];
}

function mikrotikWichtigstes(b) {
  const wifi = (b.rubriken || []).filter((r) => /wifi|wireless|wlan|capsman/i.test(`${r.schluessel} ${r.pfad}`));
  return [
    abschnitt(`IP-Adressen (${b.adressen.length})`, ['Adresse', 'Schnittstelle', 'Kommentar', 'Art'],
      b.adressen.map((a) => [`${a.adresse}/${a.prefix}`, a.schnittstelle || '', a.name || '', a.hotspot ? 'Hotspot' : a.bridge ? 'Bridge' : a.vlan ? 'VLAN' : a.disabled ? 'deaktiviert' : 'Port'])),
    abschnitt('Uplink', ['Schnittstelle', 'Art'], b.wan ? [[b.wan.schnittstelle, b.wan.dhcp ? 'DHCP-Client' : b.wan.adresse || '']] : []),
    abschnitt(`Bridges (${b.bridges.length})`, ['Name'], b.bridges.map((n) => [n])),
    abschnitt(`VLANs (${(b.vlans || []).length})`, ['Name'], (b.vlans || []).map((n) => [n])),
    abschnitt(`Ports (${(b.ports || []).length})`, ['Name', 'MAC'], (b.ports || []).map((p) => [p.name, p.mac || ''])),
    abschnitt('Hotspots', ['Schnittstelle'], (b.hotspots || []).map((n) => [n])),
    abschnitt('WLAN', ['Rubrik', 'Eintrag', 'Werte'], wifi.flatMap((r) => r.saetze.slice(0, 30).map((s) => [r.pfad, s.titel, s.felder.filter((f) => f.typName === 'string').map((f) => f.anzeige).slice(0, 4).join(' · ')])),
      'Die Feldnamen der WLAN-Rubriken sind im RouterOS-Backup nur teilweise bekannt – vollständig im virtuellen Router (WebFig › Wireless/WiFi).'),
  ];
}

function konfigWichtigstes(b) {
  const r = (pfad) => (b.rubriken || []).filter((x) => x.pfad === pfad || x.pfad.endsWith(` › ${pfad}`)).flatMap((x) => x.saetze);
  const w = wertVon;
  const teile = [
    abschnitt(`IP-Adressen (${b.adressen.length})`, ['Adresse', 'Schnittstelle', 'Name', 'Rolle/Zugriff'],
      b.adressen.map((a) => [`${a.adresse}${a.prefix != null ? `/${a.prefix}` : ''}`, a.schnittstelle, a.name || '', a.rolle || a.zugriff || ''])),
    abschnitt(`WLANs (${b.wlans.length})`, ['SSID', 'Profil', 'Sicherheit', 'VLAN', 'Status'], b.wlans.map((x) => [x.ssid || '', x.profil, x.sicherheit || '', x.vlan ?? '', x.aktiv ? 'an' : 'aus'])),
  ];
  if (b.art === 'aruba') {
    teile.push(abschnitt('VLANs', ['VLAN', 'Name', 'Untagged', 'Tagged'], r('vlan').map((s) => [s.titel, w(s, 'name'), w(s, 'untagged'), w(s, 'tagged')])));
    teile.push(abschnitt('Schnittstellen', ['Port', 'Name/Beschreibung', 'VLAN', 'Status'], [...r('interface'), ...r('interface vlan')].map((s) => [s.titel, w(s, 'name') || w(s, 'description'), w(s, 'vlan'), s.felder.some((f) => f.name === 'no shutdown') ? 'an' : s.felder.some((f) => f.name === 'shutdown' || f.name === 'disable') ? 'aus' : ''])));
  } else {
    teile.push(abschnitt('Firewall-Policies', ['Nr · Name', 'Von', 'Nach', 'Aktion', 'NAT'], r('firewall policy').map((s) => [s.titel, w(s, 'srcintf'), w(s, 'dstintf'), w(s, 'action') || 'deny', w(s, 'nat')])));
    teile.push(abschnitt('VPN (IPsec)', ['Name', 'Gegenstelle', 'Schnittstelle'], r('vpn ipsec phase1-interface').map((s) => [s.titel, w(s, 'remote-gw'), w(s, 'interface')])));
  }
  return teile;
}

function omadaWichtigstes(b) {
  return [
    abschnitt(`Sites (${b.sites.length})`, ['Name', 'Region', 'Zeitzone', 'Szenario'], b.sites.map((s) => [s.name, s.region, s.timeZone, s.scenario])),
    abschnitt(`Netze (${b.netze.length})`, ['Name', 'VLAN', 'Subnetz', 'Art'], b.netze.map((n) => [n.name, n.vlan ?? '', n.subnetz, n.zweck || ''])),
    abschnitt(`WLANs (${b.wlans.length})`, ['SSID', 'Sicherheit', 'VLAN', 'Status'], b.wlans.map((x) => [x.ssid, x.sicherheit ?? '', x.vlan ?? '', x.aktiv ? 'an' : 'aus'])),
    abschnitt(`Geräte (${b.geraete.length})`, ['Name', 'Modell', 'MAC', 'IP'], b.geraete.map((g) => [g.name, g.modell || '', g.mac, g.ip || ''])),
    abschnitt('Konten im Backup', ['Benutzer', 'E-Mail'], (b.admins || []).map((a) => [a.benutzer, a.email]),
      'Omada übernimmt diese Konten beim Einspielen nicht – beim Virtualisieren kannst du Benutzer und Passwort für die Vorschau selbst setzen.'),
  ];
}

export function wichtigstes(b) {
  const teile = b.art === 'unifi' ? unifiWichtigstes(b) : b.art === 'mikrotik' ? mikrotikWichtigstes(b) : b.art === 'omada' ? omadaWichtigstes(b) : konfigWichtigstes(b);
  return teile.filter((t) => t.zeilen.length);
}

export function wichtigstesHtml(b) {
  const teile = wichtigstes(b);
  if (!teile.length) return '<p class="empty">Keine Netze, WLANs oder Geräte gefunden – alles Weitere über „Suchen“ und den Baum.</p>';
  return `<div class="wichtig">${teile.map((t) => `<section><h3>${escapeHtml(t.titel)}</h3><div class="tabelle-rahmen"><table class="daten"><thead><tr>${t.spalten.map((s) => `<th>${escapeHtml(s)}</th>`).join('')}</tr></thead><tbody>${t.zeilen.slice(0, 200).map((z) => `<tr>${z.map((x) => `<td>${escapeHtml(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${t.zeilen.length > 200 ? `<p class="empty">… und ${t.zeilen.length - 200} weitere – über „Suchen“ finden.</p>` : ''}${t.hinweis ? `<p class="vorschau-hinweis">${escapeHtml(t.hinweis)}</p>` : ''}</section>`).join('')}</div>`;
}

// Alle Felder eines Datensatzes als lesbare Liste (für aufgeklappte Tabellenzeilen und Treffer).
export function felderHtml(satz, woerter = [], nur = null) {
  const felder = nur || satz.felder;
  return `<div class="felder">${felder.map((f) => `<div><code>${markiere(feldName(f), woerter)}</code><span>${markiere(f.anzeige, woerter) || '<em>leer</em>'}</span></div>`).join('') || '<div><span>Keine Felder</span></div>'}</div>`;
}
