// FAH-Extraktor · src/konfig.js — Urheber: Fabian Hammer © 2026
// Klartext-Konfigurationen lesen (nur durchsuchen, keine Virtualisierung):
//   Fortinet FortiGate (.conf: config / edit / set / next / end)
//   Aruba AOS-S, AOS-CX, Instant AP, ArubaOS 8 (eingerückte Blöcke; flashbackup.tar.gz → default.cfg)
// Das Ergebnis hat dieselbe Form wie src/mikrotik.js (rubriken → saetze → felder), damit Baum,
// Suche und Rohdatei-Ansicht des Arbeitsplatzes unverändert passen. Statt Hex-Rohdaten trägt
// jeder Datensatz seine Originalzeilen (quelle, zeileNr).

const td = new TextDecoder('utf-8', { fatal: false });

export const HERSTELLER = { aruba: 'Aruba', fortinet: 'Fortinet' };
const NICHT_VIRTUELL = {
  aruba: 'Virtuell nicht möglich – Aruba stellt kein frei nutzbares Abbild bereit (AOS-CX-Simulator nur mit HPE-Konto).',
  fortinet: 'Virtuell nur mit gekaufter FortiGate-VM-Lizenz – die Testlizenz erlaubt nur 3 Interfaces, Policies und Routen.',
};

// Datei (Browser) → Konfig-Objekt.
export async function oeffneKonfig(file, hersteller) {
  return konfigAusBytes(file.name, new Uint8Array(await file.arrayBuffer()), hersteller);
}

// Rohbytes → Konfig-Objekt (auch für Node-Tests).
export async function konfigAusBytes(name, bytes, hersteller) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (!HERSTELLER[hersteller]) throw new Error(`Unbekannter Hersteller: ${hersteller}`);
  let inhalt = bytes, quelle = name, archiv = null;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try { inhalt = await gunzip(bytes); } catch { throw new Error('Die Datei sieht wie ein gzip-Archiv aus, lässt sich aber nicht entpacken.'); }
  }
  if (istTar(inhalt)) {
    archiv = tarLesen(inhalt);
    const wahl = konfigImArchiv(archiv);
    if (!wahl) throw new Error('Im Archiv steckt keine Konfigurationsdatei (erwartet z. B. config/default.cfg).');
    inhalt = wahl.daten; quelle = wahl.name;
  }
  const basis = {
    name, size: bytes.length, art: hersteller, dateiart: 'text', roh: bytes, quelle,
    files: new Map(archiv ? archiv.map((e) => [e.name, e.daten]) : [[name, bytes]]),
    nichtVirtuell: NICHT_VIRTUELL[hersteller],
  };
  if (!istText(inhalt)) {
    return { ...basis, ...leer(), verschluesselt: true, type: `${HERSTELLER[hersteller]}-Konfiguration (verschlüsselt)`, exportText: null, zeilen: 0,
      version: { anzeige: 'verschlüsselt oder binär', genau: null, hauptversion: null, hinweise: [hersteller === 'fortinet'
        ? 'Das Backup wurde mit Passwort verschlüsselt – auf der FortiGate ohne Passwort erneut sichern (System › Konfiguration › Sichern).'
        : 'Die Datei ist keine lesbare Textkonfiguration – bitte running-config/startup-config als Text oder flashbackup.tar.gz wählen.'] } };
  }
  const text = td.decode(inhalt).replace(/^﻿/, '');
  const ergebnis = hersteller === 'fortinet' ? fortigateLesen(text) : arubaLesen(text);
  if (archiv) ergebnis.version.hinweise.unshift(`Archiv mit ${archiv.length} Dateien – gelesen wird ${quelle}.`);
  const unbekannt = !ergebnis.rubriken.length;
  if (unbekannt) ergebnis.version.hinweise.unshift(`Keine ${HERSTELLER[hersteller]}-Konfiguration erkannt – die Datei hat keine bekannten Abschnitte.`);
  return { ...basis, ...ergebnis, unbekannt, exportText: text, zeilen: text.split('\n').length };
}

const leer = () => ({ identitaet: null, rubriken: [], adressen: [], wlans: [], geraet: {} });

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------
async function gunzip(bytes) {
  const strom = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(strom).arrayBuffer());
}

const istTar = (b) => b.length >= 512 && td.decode(b.subarray(257, 262)) === 'ustar';

// ustar/GNU-tar: reguläre Dateien mit Namen (GNU-Langnamen „L“ und ustar-Präfix berücksichtigt).
export function tarLesen(b) {
  const dateien = [];
  let langname = null;
  for (let i = 0; i + 512 <= b.length;) {
    const kopf = b.subarray(i, i + 512);
    if (kopf.every((x) => x === 0)) break;
    const feld = (start, laenge) => td.decode(kopf.subarray(start, start + laenge)).replace(/\0.*$/s, '');
    const groesse = parseInt(feld(124, 12).trim() || '0', 8) || 0;
    const typ = String.fromCharCode(kopf[156] || 0x30);
    const praefix = feld(345, 155);
    const daten = b.subarray(i + 512, i + 512 + groesse);
    let name = langname || (praefix ? `${praefix}/${feld(0, 100)}` : feld(0, 100));
    langname = null;
    if (typ === 'L') langname = td.decode(daten).replace(/\0.*$/s, '');
    else if (typ === '0' || typ === '\0') dateien.push({ name: name.replace(/^\.\//, ''), daten });
    i += 512 + Math.ceil(groesse / 512) * 512;
  }
  return dateien;
}

function konfigImArchiv(dateien) {
  const rang = (n) => (/(^|\/)default\.cfg$/i.test(n) ? 0 : /\.cfg$/i.test(n) ? 1 : /\.conf$/i.test(n) ? 2 : /(running|startup)-config/i.test(n) ? 3 : 9);
  return dateien.filter((d) => rang(d.name) < 9 && istText(d.daten)).sort((a, b) => rang(a.name) - rang(b.name))[0] || null;
}

function istText(b) {
  const probe = b.subarray(0, 8192);
  if (!probe.length) return false;
  let fremd = 0;
  for (const x of probe) {
    if (x === 0) return false;
    if (x < 9 || (x > 13 && x < 32 && x !== 27)) fremd++;
  }
  return fremd / probe.length < 0.02;
}

// Wörter einer CLI-Zeile, "…"-Werte mit Leerzeichen zusammenhalten (ohne Anführungszeichen).
export function woerter(zeile) {
  const t = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(zeile))) t.push(m[1] ?? m[2] ?? m[3]);
  return t;
}

const maskeZuPrefix = (maske) => String(maske).split('.').reduce((n, o) => n + ((Number(o) >>> 0).toString(2).match(/1/g) || []).length, 0);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// "1.2.3.4 255.255.255.0" oder "1.2.3.4/24" → { adresse, prefix } (0.0.0.0 = keine Adresse)
function ipAus(wert) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2})|\s+(\d{1,3}(?:\.\d{1,3}){3}))?/.exec(String(wert || '').trim());
  if (!m || m[1] === '0.0.0.0') return null;
  return { adresse: m[1], prefix: m[2] ? Number(m[2]) : m[3] && IPV4.test(m[3]) ? maskeZuPrefix(m[3]) : 32 };
}

function rubrikHolen(map, pfad) {
  if (!map.has(pfad)) map.set(pfad, { schluessel: pfad, pfad, saetze: [] });
  return map.get(pfad);
}
function neuerSatz(rubrik, titel, zeileNr) {
  const satz = { nr: rubrik.saetze.length + 1, titel, felder: [], zeilen: [], zeileNr, roh: null };
  rubrik.saetze.push(satz);
  return satz;
}
const wert = (satz, name) => satz.felder.find((f) => f.name === name)?.anzeige ?? null;

// Abschluss: Originalzeilen als Text, Volltext in Kleinbuchstaben, leere Rubriken weg.
function abschliessen(map) {
  const rubriken = [];
  for (const r of map.values()) {
    for (const s of r.saetze) {
      s.quelle = s.zeilen.join('\n');
      delete s.zeilen;
      s.text = `${s.titel} ${s.felder.map((f) => `${f.name} ${f.anzeige}`).join(' ')}`.toLowerCase();
    }
    if (r.saetze.length) rubriken.push(r);
  }
  return rubriken;
}

// ---------------------------------------------------------------------------
// FortiGate: config <pfad> / edit <id> / set|unset|append|select <schlüssel> <wert> / next / end
// Rubrik = config-Pfad; Datensatz = edit-Eintrag (bei Einstellungs-Abschnitten „(Einstellungen)“).
// config innerhalb von edit wird in den Eintrag eingeflacht (Feld „ipv6 › ip6-mode“), außer bei
// den Behältern „config vdom › edit <name>“ (Pfad „vdom <name> › …“) und „config global“.
// ---------------------------------------------------------------------------
export function fortigateLesen(text) {
  const map = new Map();
  const stapel = [];
  const zeilen = text.split(/\r?\n/);
  const verbinde = (a, b) => (a ? `${a} › ${b}` : b);
  const satzVon = (rahmen) => (rahmen?.art === 'edit' || rahmen?.flach ? rahmen.satz : rahmen?.einst) || null;

  zeilen.forEach((roh, index) => {
    const zeile = roh.trim();
    if (!zeile || zeile.startsWith('#')) return;
    const nr = index + 1;
    const [befehl, ...rest] = woerter(zeile);
    const oben = stapel.at(-1);
    if (befehl === 'config') {
      const name = rest.join(' ');
      let rahmen;
      if (!oben) rahmen = { art: 'config', pfad: name };
      else if (oben.art === 'config') rahmen = oben.flach ? { art: 'config', flach: true, satz: oben.satz, praefix: verbinde(oben.praefix, name) } : { art: 'config', pfad: `${oben.pfad} › ${name}` };
      else if (oben.behaelter) rahmen = { art: 'config', pfad: `${oben.behaelter} › ${name}` };
      else rahmen = { art: 'config', flach: true, satz: oben.satz, praefix: verbinde(oben.praefix, name) };
      stapel.push(rahmen);
      satzVon(rahmen)?.zeilen.push(roh);
    } else if (befehl === 'edit' && oben?.art === 'config') {
      const id = rest.join(' ');
      let rahmen;
      if (oben.flach) rahmen = { art: 'edit', satz: oben.satz, praefix: verbinde(oben.praefix, id) };
      else if (stapel.length === 1 && oben.pfad === 'vdom') rahmen = { art: 'edit', behaelter: `vdom ${id}` };
      else rahmen = { art: 'edit', satz: neuerSatz(rubrikHolen(map, oben.pfad), id, nr), praefix: '' };
      stapel.push(rahmen);
      satzVon(rahmen)?.zeilen.push(roh);
    } else if (befehl === 'next' || befehl === 'end') {
      satzVon(oben)?.zeilen.push(roh);
      if ((befehl === 'next' && oben?.art === 'edit') || (befehl === 'end' && oben?.art === 'config')) stapel.pop();
      else if (befehl === 'end' && oben?.art === 'edit') { stapel.pop(); stapel.pop(); } // fehlendes next
    } else if (/^(set|unset|append|select|unselect)$/.test(befehl) && rest.length) {
      let satz, praefix = '';
      if (!oben) satz = neuerSatz(rubrikHolen(map, '(ohne Abschnitt)'), rest[0], nr);
      else if (oben.art === 'edit') { satz = oben.satz; praefix = oben.praefix; }
      else if (oben.flach) { satz = oben.satz; praefix = oben.praefix; }
      else satz = oben.einst ||= neuerSatz(rubrikHolen(map, oben.pfad), '(Einstellungen)', nr);
      if (!satz) return;
      const werte = rest.slice(1);
      const anzeige = werte.length > 1 && /"/.test(zeile) ? werte.join(', ') : werte.join(' ');
      satz.felder.push({ name: verbinde(praefix, rest[0]), typName: befehl, anzeige, idHex: null });
      satz.zeilen.push(roh);
    } else {
      satzVon(oben)?.zeilen.push(roh);
    }
  });

  // Titel: bei Nummern-Einträgen (Policies, Routen) den Namen dazu
  for (const r of map.values()) for (const s of r.saetze) {
    const name = wert(s, 'name') || wert(s, 'alias');
    if (/^\d+$/.test(s.titel) && name) s.titel = `${s.titel} · ${name}`;
  }
  const rubriken = abschliessen(map);
  const endetAuf = (r, pfad) => r.pfad === pfad || r.pfad.endsWith(` › ${pfad}`);

  const adressen = [];
  const wlans = [];
  for (const r of rubriken) {
    if (endetAuf(r, 'system interface')) for (const s of r.saetze) {
      const ip = ipAus(wert(s, 'ip'));
      if (ip) adressen.push({ ...ip, schnittstelle: s.titel, name: wert(s, 'alias') || wert(s, 'description'), rolle: wert(s, 'role'), zugriff: wert(s, 'allowaccess'), vdom: wert(s, 'vdom'), modus: wert(s, 'mode') });
      else if (wert(s, 'mode') === 'dhcp') adressen.push({ adresse: 'DHCP', prefix: null, schnittstelle: s.titel, name: wert(s, 'alias'), rolle: wert(s, 'role'), zugriff: wert(s, 'allowaccess'), vdom: wert(s, 'vdom'), modus: 'dhcp' });
    }
    if (endetAuf(r, 'wireless-controller vap')) for (const s of r.saetze) {
      wlans.push({ profil: s.titel, ssid: wert(s, 'ssid'), sicherheit: wert(s, 'security'), vlan: wert(s, 'vlanid'), aktiv: wert(s, 'status') !== 'disable' });
    }
  }

  const kopf = /^#config-version=([^:\s]+)(.*)$/m.exec(text);
  let modell = null, version = null, build = null;
  if (kopf) {
    const teile = kopf[1].split('-');
    modell = teile[0] || null;
    version = teile.find((t) => /^\d+\.\d+(\.\d+)?$/.test(t)) || null;
    build = teile.find((t) => /^build\d+$/.test(t))?.slice(5) || null;
  }
  const global = rubriken.find((r) => endetAuf(r, 'system global'))?.saetze[0];
  const hostname = (global && wert(global, 'hostname')) || null;
  const vdomModus = /:vdom=1/.test(kopf?.[2] || '') || rubriken.some((r) => r.pfad.startsWith('vdom '));
  const hinweise = [];
  if (!kopf) hinweise.push('Kopfzeile #config-version fehlt – Modell und FortiOS-Version unbekannt.');
  if (vdomModus) hinweise.push('VDOM-Modus: Rubriken je VDOM beginnen mit „vdom <name> ›“, globale mit „global ›“.');
  if (global && wert(global, 'private-data-encryption') === 'enable') hinweise.push('private-data-encryption ist aktiv – Passwörter und Schlüssel sind gerätegebunden verschlüsselt.');
  hinweise.push('Passwörter und Schlüssel stehen als ENC-Werte in der Datei.');
  return {
    type: 'FortiGate-Konfiguration (.conf)', identitaet: hostname, rubriken, adressen, wlans, verschluesselt: false,
    geraet: { hersteller: 'Fortinet', variante: 'FortiGate', modell, firmware: version ? `FortiOS ${version}${build ? ` (Build ${build})` : ''}` : null, hostname },
    version: { anzeige: version ? `FortiOS ${version}${build ? ` · Build ${build}` : ''}${modell ? ` · ${modell}` : ''}` : 'FortiOS-Version unbekannt', genau: version, hauptversion: version?.split('.')[0] || null, hinweise },
  };
}

// ---------------------------------------------------------------------------
// Aruba: Kopfzeile ohne Einrückung + eingerückte Unterzeilen = Block (AOS-S schließt mit „exit“,
// AOS-CX/ArubaOS 8 trennen mit „!“). Rubrik = Kopf ohne letztes Wort („interface vlan“), Datensatz
// = letztes Wort („10“). Zeilen ohne Unterzeilen landen in „Globale Einstellungen“, je erstem Wort.
// ---------------------------------------------------------------------------
function arubaVariante(text) {
  let m;
  if ((m = /^; *(\S+) Configuration Editor; Created on release #(\S+)/m.exec(text))) return { variante: 'AOS-S', modell: m[1], firmware: m[2] };
  if ((m = /^!Version ArubaOS-CX (\S+)/m.exec(text))) return { variante: 'AOS-CX', modell: null, firmware: m[1] };
  if (/^virtual-controller-/m.test(text)) return { variante: 'Instant AP', modell: null, firmware: /^version (\S+?)(?:-\S+)?$/m.exec(text)?.[1] || null };
  if ((m = /^version (\d+\.\d+(?:\.\d+)*)/m.exec(text))) return { variante: `ArubaOS ${m[1].split('.')[0]}`, modell: null, firmware: m[1] };
  if (/^; .*Configuration Editor/m.test(text)) return { variante: 'AOS-S', modell: null, firmware: null };
  return { variante: null, modell: null, firmware: null };
}

export function arubaLesen(text) {
  const map = new Map();
  const zeilen = text.split(/\r?\n/);
  const bloecke = [];
  let block = null;
  zeilen.forEach((roh, index) => {
    const zeile = roh.replace(/\s+$/, '');
    const getrimmt = zeile.trim();
    if (!getrimmt || /^[;!]/.test(getrimmt)) { if (block && getrimmt.startsWith('!')) block = null; return; }
    const einzug = zeile.length - zeile.trimStart().length;
    if (einzug === 0) {
      if (/^(exit|end)$/.test(getrimmt)) { block = null; return; }
      block = { kopf: getrimmt, zeileNr: index + 1, kinder: [], roh: [roh] };
      bloecke.push(block);
    } else if (block) {
      block.roh.push(roh);
      if (getrimmt !== 'exit') block.kinder.push({ text: getrimmt, einzug });
    }
  });

  const global = rubrikHolen(map, '(global)');
  global.pfad = 'Globale Einstellungen';
  const globalSaetze = new Map();
  for (const b of bloecke) {
    const w = woerter(b.kopf);
    if (!b.kinder.length) {
      // Einzelzeile: gruppiert nach erstem Wort („snmp-server“, „ntp“ …)
      const gruppe = w[0] === 'no' && w[1] ? `no ${w[1]}` : w[0];
      if (!globalSaetze.has(gruppe)) globalSaetze.set(gruppe, neuerSatz(global, gruppe, b.zeileNr));
      const satz = globalSaetze.get(gruppe);
      const off = w[0] === 'no' ? 1 : 0;
      const name = w.length >= 3 + off ? w[1 + off] : w[off];
      const anzeige = b.kopf.slice(b.kopf.indexOf(w.length >= 3 + off ? w[1 + off] : w[off]) + name.length).trim().replace(/^"(.*)"$/, '$1');
      satz.felder.push({ name: w[0] === 'no' ? `no ${name}` : name, typName: 'cli', anzeige, idHex: null });
      satz.zeilen.push(...b.roh);
      continue;
    }
    const rubrikName = w.length > 1 ? w.slice(0, -1).join(' ') : w[0];
    const titel = w.length > 1 ? w.at(-1) : '(Einstellungen)';
    const satz = neuerSatz(rubrikHolen(map, rubrikName), titel, b.zeileNr);
    satz.zeilen.push(...b.roh);
    const basis = Math.min(...b.kinder.map((k) => k.einzug));
    let letzter = '';
    for (const k of b.kinder) {
      const kw = woerter(k.text);
      const name = kw[0] === 'no' && kw[1] ? `no ${kw[1]}` : kw[0];
      const anzeige = k.text.slice(k.text.indexOf(kw[0] === 'no' ? kw[1] : kw[0]) + (kw[0] === 'no' ? kw[1] : kw[0]).length).trim().replace(/^"(.*)"$/, '$1');
      if (k.einzug > basis && letzter) satz.felder.push({ name: `${letzter} › ${name}`, typName: 'cli', anzeige, idHex: null });
      else { letzter = name; satz.felder.push({ name, typName: 'cli', anzeige, idHex: null }); }
    }
  }
  if (!global.saetze.length) map.delete('(global)');
  const rubriken = abschliessen(map);

  const info = arubaVariante(text);
  const adressen = [];
  const wlans = [];
  for (const r of rubriken) {
    if (r.schluessel === '(global)') continue;
    for (const s of r.saetze) {
      const kopf = `${r.schluessel} ${s.titel}`;
      for (const f of s.felder) {
        if (f.name === 'ip address' || f.name === 'ip') {
          const ip = ipAus(f.name === 'ip' ? f.anzeige.replace(/^(address|static)\s+/, '') : f.anzeige);
          if (ip) adressen.push({ ...ip, schnittstelle: kopf, name: wert(s, 'name') || wert(s, 'description') });
        }
      }
      if (/(^|\s)ssid-profile$/.test(r.schluessel)) {
        wlans.push({ profil: s.titel, ssid: wert(s, 'essid'), sicherheit: wert(s, 'opmode'), vlan: wert(s, 'vlan'), aktiv: !s.felder.some((f) => f.name === 'disable' || f.name === 'ssid-disable') });
      }
    }
  }
  // „ip address 1.2.3.4 …“ steht als Feld „ip“ mit Anzeige „address 1.2.3.4 …“ – so oben gelesen.
  const glob = rubriken.find((r) => r.schluessel === '(global)');
  const globWert = (gruppe) => glob?.saetze.find((s) => s.titel === gruppe)?.felder[0]?.anzeige || null;
  const hostname = globWert('hostname') || (info.variante === 'Instant AP' ? globWert('name') : null);
  const hinweise = [];
  if (!info.variante) hinweise.push('Aruba-Variante nicht erkannt – gelesen wird trotzdem nach Blöcken.');
  else hinweise.push(`Erkannt: ${info.variante}${info.firmware ? ` ${info.firmware}` : ''}${info.modell ? ` (Modell ${info.modell})` : ''}.`);
  if (info.variante === 'AOS-CX') hinweise.push('Virtuell ginge nur der AOS-CX-Switch-Simulator – Download nur mit berechtigtem HPE-Konto.');
  hinweise.push('Passwörter stehen gehasht oder verschlüsselt in der Datei.');
  return {
    type: `Aruba-Konfiguration${info.variante ? ` (${info.variante})` : ''}`, identitaet: hostname, rubriken, adressen, wlans, verschluesselt: false,
    geraet: { hersteller: 'Aruba', variante: info.variante, modell: info.modell, firmware: info.firmware, hostname },
    version: { anzeige: info.variante ? `${info.variante}${info.firmware ? ` ${info.firmware}` : ''}` : 'Variante unbekannt', genau: info.firmware, hauptversion: null, hinweise },
  };
}
