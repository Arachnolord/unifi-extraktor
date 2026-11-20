// FAH-Extraktor · Urheber: Fabian Hammer
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import * as docker from '../docker.js';
import { tarPacken } from '../tar.js';
import { istChrVersion, imageSicherstellen } from '../mikrotik-versionen.js';
import { setze, pruefe, warte, bisBereit, httpAbruf, labels, hostKonfig } from '../lauf.js';

// Vorschau-Art MikroTik: ein RouterOS-Backup (.backup) oder Export (.rsc, Beta)
// läuft als Cloud Hosted Router (CHR) unter QEMU/KVM in einem Wegwerf-Container
// im abgeschotteten Vorschau-Netz. Das Backend liefert Auftrag + Datei per
// Archiv-Upload in den Container; chr/chr_lauf.py steuert den Router über die
// serielle Konsole und meldet sich mit Marker-Zeilen (FAH-SCHRITT, FAH-INFO,
// FAH-STAND, FAH-BEREIT, FAH-FEHLER, FAH-KONSOLE) über die Container-Logs.
// WebFig ist danach im Container auf Port 80 erreichbar (hostfwd + Relay).
export const art = 'mikrotik';
export const bezeichnung = 'Der virtuelle Router';
export const CHR_IMAGE = process.env.CHR_IMAGE || 'fah-extraktor-chr';
export const CHR_CACHE_VOLUME = process.env.CHR_CACHE_VOLUME || 'fah-chr-cache';
const CHR_RAM_MB = 384;
const CHR_MEMORY_GB = 0.75;
const KVM = { PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm', CgroupPermissions: 'rwm' };

export const SCHRITTE = [
  ['vorbereiten', 'Backup prüfen'],
  ['laden', 'RouterOS-Image bereitstellen'],
  ['starten', 'Virtuellen Router starten'],
  ['einspielen', 'Backup einspielen'],
  ['anmelden', 'Zugang einrichten (WebFig)']
];
const SCHRITT_KEYS = new Set(SCHRITTE.map(([key]) => key));

const MAGIC_KLARTEXT = 0xB1A1AC88;
const MAGIC_VERSCHLUESSELT = new Set([0x7291A8EF, 0x7391A8EF]);
const BENUTZER = /^[A-Za-z0-9._@-]{1,64}$/;
const STEUERZEICHEN = /[\x00-\x1f\x7f]/;
const PORTNAME = /^[a-z0-9-]{1,30}$/;
const MAX_PORTS = 32;

const fehler400 = (text) => Object.assign(new Error(text), { status: 400 });

export const zielFuer = (l) => ({ host: l.app, port: 80, schema: 'http' });
export const zugang = (l) => ({ benutzer: l.zugangsdaten.benutzer, passwort: l.zugangsdaten.passwort, hinweis: 'WebFig fragt nach der Anmeldung.' });
// Das Passwort geht nur über zugang() an den Browser, nie über den Status.
export const statusExtra = (l) => {
  if (!l.mikrotik) return { mikrotik: null };
  const { passwort, wegwerfPasswort, ...rest } = l.mikrotik;
  return { mikrotik: rest };
};
export const oeffnenZiel = async () => ({ location: '/webfig/' });
export const istHuelle = () => false;
export const banner = null;

// Protokoll für die Fehleransicht: Marker ohne Präfix, Konsolenzeilen wie gemeldet,
// Rohzustände (FAH-STAND/BEREIT/SCHRITT) weglassen. chr_lauf.py maskiert alle Geheimnisse.
export function logAuszug(log) {
  return log.split('\n').map((zeile) => zeile.trimEnd())
    .filter((zeile) => zeile && !/^FAH-(STAND|BEREIT|SCHRITT) /.test(zeile))
    .map((zeile) => zeile.replace(/^FAH-KONSOLE ?/, '').replace(/^FAH-(FEHLER|INFO) /, '$1: '))
    .slice(-40).join('\n');
}

// Portnamen eines Exports: "set [ find default-name=ether1 ] ..." in Reihenfolge.
export function portsAusRsc(text) {
  const namen = [];
  for (const m of String(text).matchAll(/default-name=([A-Za-z0-9-]{1,30})/g)) {
    const name = m[1].toLowerCase();
    if (!namen.includes(name)) namen.push(name);
  }
  return namen.slice(0, MAX_PORTS);
}

const istText = (bytes) => {
  const probe = bytes.subarray(0, 512);
  for (const b of probe) if (b === 0 || (b < 32 && b !== 9 && b !== 10 && b !== 13)) return false;
  return true;
};

// Prüft die Optionen des Virtualisieren-Dialogs (Header X-Vorschau-Optionen,
// percent-kodiertes JSON) gegen die hochgeladene Datei. Wirft { status: 400 }.
export function optionenPruefen(roh, eingabe) {
  if (!roh) throw fehler400('Vorschau-Optionen fehlen.');
  let o;
  try { o = JSON.parse(decodeURIComponent(String(roh))); } catch { throw fehler400('Vorschau-Optionen sind kein gültiges JSON.'); }
  if (!o || typeof o !== 'object') throw fehler400('Vorschau-Optionen sind ungültig.');
  if (!(eingabe instanceof Uint8Array) || eingabe.length < 8) throw fehler400('Die Datei ist leer oder zu kurz.');

  const magic = (eingabe[0] | (eingabe[1] << 8) | (eingabe[2] << 16) | (eingabe[3] << 24)) >>> 0;
  let erkannt = null;
  if (magic === MAGIC_KLARTEXT || MAGIC_VERSCHLUESSELT.has(magic)) erkannt = 'backup';
  else if (istText(eingabe) && /^\s*[#/]/.test(Buffer.from(eingabe.subarray(0, 64)).toString('utf8'))) erkannt = 'rsc';
  if (!erkannt) throw fehler400('Die Datei ist weder ein RouterOS-Backup (.backup) noch ein Export (.rsc).');
  if (o.dateiart !== undefined && o.dateiart !== erkannt) throw fehler400(`Die Datei wurde als ${o.dateiart} gemeldet, ihr Inhalt ist aber ein ${erkannt === 'rsc' ? 'Export (.rsc)' : 'Backup (.backup)'}.`);
  const dateiart = erkannt;
  if (MAGIC_VERSCHLUESSELT.has(magic)) {
    throw fehler400('Das Backup ist verschlüsselt – verschlüsselte Backups lassen sich noch nicht virtuell öffnen. Auf dem Router mit „/system backup save dont-encrypt=yes“ erneut sichern.');
  }

  const chrVersion = String(o.chrVersion ?? '').trim();
  if (!istChrVersion(chrVersion)) {
    if (/^6\./.test(chrVersion)) throw fehler400('RouterOS 6 wird noch nicht virtualisiert – bitte eine Version 7.x wählen.');
    throw fehler400('CHR-Version ungültig – erlaubt sind 7.x, 7.x.y, 7.xrcN oder 7.xbetaN.');
  }

  let benutzer = 'admin', passwort = '';
  if (dateiart === 'backup') {
    benutzer = String(o.benutzer ?? '').trim();
    passwort = String(o.passwort ?? '');
    if (!BENUTZER.test(benutzer)) throw fehler400('Benutzername: 1–64 Zeichen aus Buchstaben, Ziffern und . _ @ - (kein + und kein Leerzeichen).');
    if (passwort.length > 128) throw fehler400('Das Passwort ist zu lang (höchstens 128 Zeichen).');
    if (STEUERZEICHEN.test(passwort)) throw fehler400('Das Passwort darf keine Steuerzeichen oder Zeilenumbrüche enthalten.');
  }

  const z = o.zugang && typeof o.zugang === 'object' ? o.zugang : {};
  const modus = z.modus;
  if (modus !== 'lokal' && modus !== 'wan') throw fehler400('Zugangsweg ungültig – erlaubt sind „lokal“ und „wan“.');
  let ip = '', prefix = null;
  if (modus === 'lokal') {
    ip = String(z.ip ?? '').trim();
    prefix = Number(z.prefix);
    if (!net.isIPv4(ip)) throw fehler400('Zugangs-Adresse: bitte eine IPv4-Adresse des Routers wählen.');
    if (!Number.isInteger(prefix) || prefix < 8 || prefix > 30) throw fehler400('Zugangs-Adresse: Präfixlänge 8–30 nötig.');
  } else if (String(z.ip ?? '').trim()) {
    throw fehler400('WAN-Zugang gibt es in dieser Stufe nur per DHCP über den Uplink – das Adressfeld leer lassen.');
  }

  let ports = [];
  if (dateiart === 'rsc') {
    if (Array.isArray(o.ports)) {
      ports = o.ports.map((p) => String(p?.defaultName ?? p ?? '').trim().toLowerCase());
      if (ports.length > MAX_PORTS) throw fehler400(`Höchstens ${MAX_PORTS} Ports.`);
      if (!ports.every((p) => PORTNAME.test(p))) throw fehler400('Portnamen ungültig (erlaubt: a–z, 0–9, Bindestrich).');
    } else {
      ports = portsAusRsc(Buffer.from(eingabe).toString('utf8'));
    }
  }

  return { dateiart, chrVersion, benutzer, passwort, zugang: { modus, ip, prefix }, verschluesselt: false, magic, ports };
}

function hinweis(l, text) {
  const sauber = String(text || '').trim().slice(0, 240);
  if (sauber && !l.mikrotik.hinweise.includes(sauber) && l.mikrotik.hinweise.length < 20) l.mikrotik.hinweise.push(sauber);
}

const text = (wert, max = 120) => (typeof wert === 'string' ? wert.slice(0, max) : null);

// FAH-STAND / FAH-BEREIT: JSON des Containers in den Statusteil mischen (nur bekannte Felder).
function standMischen(l, rohJson) {
  let daten;
  try { daten = JSON.parse(rohJson); } catch { return; }
  if (!daten || typeof daten !== 'object') return;
  const m = l.mikrotik;
  if (daten.identitaet !== undefined) m.identitaet = text(daten.identitaet);
  if (daten.routerosVersion !== undefined) m.routerosVersion = text(daten.routerosVersion, 40);
  if (daten.traeger !== undefined) m.traeger = text(daten.traeger, 64);
  if (daten.verwaltungsName !== undefined) m.verwaltungsName = text(daten.verwaltungsName, 64);
  if (daten.zugangIp !== undefined) m.zugangIp = text(daten.zugangIp, 45);
  if (daten.modus === 'lokal' || daten.modus === 'wan') m.modus = daten.modus;
  if (Number.isInteger(daten.wwwPort) && daten.wwwPort > 0 && daten.wwwPort < 65536) m.wwwPort = daten.wwwPort;
  if (typeof daten.kvm === 'boolean') m.kvm = daten.kvm;
  if (daten.schema === 'http' || daten.schema === 'https') { m.schema = daten.schema; l.ziel.schema = daten.schema; }
  if (Array.isArray(daten.hinweise)) for (const h of daten.hinweise) hinweis(l, h);
}

function markerAuswerten(l, zeile, zustand) {
  const m = /^FAH-(SCHRITT|INFO|STAND|BEREIT|FEHLER) ?(.*)$/.exec(zeile);
  if (!m) return;
  const [, markerArt, rest] = m;
  if (markerArt === 'SCHRITT') {
    const s = /^(\w+) (laeuft|fertig|fehler)(?: (.*))?$/.exec(rest);
    if (s && SCHRITT_KEYS.has(s[1])) setze(l, s[1], s[2], (s[3] || '').slice(0, 200));
  } else if (markerArt === 'INFO') {
    hinweis(l, rest);
  } else if (markerArt === 'STAND' || markerArt === 'BEREIT') {
    standMischen(l, rest);
    if (markerArt === 'BEREIT') zustand.bereit = true;
  } else if (markerArt === 'FEHLER') {
    zustand.fehler = rest.trim().slice(0, 500) || 'Der virtuelle Router meldet einen Fehler.';
  }
}

const groesse = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

// optionen = Ergebnis von optionenPruefen; kern.netz() liefert das Vorschau-Netz.
export async function ablauf(l, eingabe, optionen, kern) {
  const { dateiart, chrVersion, benutzer, passwort, zugang, ports } = optionen;
  const rsc = dateiart === 'rsc';
  setze(l, 'vorbereiten', 'laeuft');
  const wegwerfPasswort = randomBytes(9).toString('base64url');
  l.mikrotik = {
    dateiart, chrVersion, modus: zugang.modus, zugangIp: zugang.ip || null, wwwPort: null, schema: 'http',
    identitaet: null, routerosVersion: null, traeger: null, verwaltungsName: null, kvm: true, hinweise: []
  };
  // Zugangsdaten nur hier (nie im Statusteil "mikrotik", nie in Logs); bei .rsc gibt es keine Benutzer.
  l.zugangsdaten = { benutzer: rsc ? 'admin' : benutzer, passwort: rsc ? wegwerfPasswort : passwort };
  if (rsc) hinweis(l, 'Export (.rsc) ist Beta: Zugang admin mit Wegwerf-Passwort, der Import bricht beim ersten Fehler ab – .backup ist die sicherere Wahl.');
  setze(l, 'vorbereiten', 'fertig', `${rsc ? 'RouterOS-Export (.rsc)' : 'RouterOS-Backup'} · ${groesse(eingabe.length)} · CHR ${chrVersion} · Zugang ${zugang.modus === 'wan' ? 'WAN (DHCP über den Uplink)' : `${zugang.ip}/${zugang.prefix}`}`);

  setze(l, 'laden', 'laeuft', `RouterOS ${chrVersion}`);
  if (!await docker.imageInfo(CHR_IMAGE)) throw new Error('Vorschau-Image fehlt – auf dem NAS ./manage.sh rebuild ausführen.');
  pruefe(l);
  let zuletztProzent = -1;
  await imageSicherstellen(chrVersion, (geladen, gesamt, stufe) => {
    if (stufe === 'entpacken') { setze(l, 'laden', 'laeuft', `RouterOS ${chrVersion} wird entpackt …`); return; }
    const prozent = Math.min(100, Math.round((geladen / Math.max(gesamt, 1)) * 100));
    if (prozent - zuletztProzent >= 2 || prozent === 100) {
      zuletztProzent = prozent;
      setze(l, 'laden', 'laeuft', `RouterOS ${chrVersion} wird einmalig geladen … ${prozent} %`);
    }
  });
  pruefe(l);
  await docker.volumeSicherstellen(CHR_CACHE_VOLUME);
  const netz = await kern.netz();
  pruefe(l);
  setze(l, 'laden', 'fertig', `RouterOS ${chrVersion}`);

  setze(l, 'starten', 'laeuft', 'Vorschau-Container wird erstellt');
  const start = Date.now();
  // Keine Nutzereingabe landet hier: Image, Binds, Env und Geräte kommen nur aus Konstanten/Env.
  const konfiguration = (mitKvm) => ({
    Image: CHR_IMAGE, Labels: labels(l, art),
    Env: ['AUFTRAG=/auftrag/auftrag.json', `TZ=${process.env.TZ || 'Europe/Berlin'}`],
    HostConfig: hostKonfig(netz, 1, CHR_MEMORY_GB, { Binds: [`${CHR_CACHE_VOLUME}:/cache:ro`], ...(mitKvm ? { Devices: [KVM] } : {}) })
  });
  let kvm = true;
  let id;
  try { id = await docker.containerErstellen(l.app, konfiguration(true)); } catch (f) {
    if (!/kvm/i.test(f.message)) throw f;
    kvm = false;
    l.mikrotik.kvm = false;
    hinweis(l, 'ohne KVM – deutlich langsamer (/dev/kvm fehlt auf dem Host)');
    console.log(`[vorschau] ${l.app}: /dev/kvm nicht verfügbar – Rückfall auf TCG`);
    id = await docker.containerErstellen(l.app, konfiguration(false));
  }
  pruefe(l);
  const auftrag = {
    dateiart, datei: `/auftrag/${rsc ? 'kunde.rsc' : 'kunde.backup'}`, chrVersion,
    benutzer: l.zugangsdaten.benutzer, passwort: rsc ? '' : passwort, wegwerfPasswort,
    zugang, ports: rsc ? ports : null, ramMb: CHR_RAM_MB, kvm
  };
  await docker.archivHochladen(id, '/auftrag', tarPacken([
    { name: 'auftrag.json', daten: Buffer.from(JSON.stringify(auftrag)), mode: 0o600 },
    { name: rsc ? 'kunde.rsc' : 'kunde.backup', daten: eingabe, mode: 0o600 }
  ]));
  pruefe(l);
  const zustand = { bereit: false, fehler: null };
  await docker.containerStarten(id);
  setze(l, 'starten', 'laeuft', 'Virtueller Router bootet');
  // Erst nach dem Start mitlesen: Docker beendet "follow" bei einem noch nicht
  // laufenden Container sofort. tail=all liefert die ersten Zeilen nach.
  const logs = docker.logsFolgen(id, (zeile) => markerAuswerten(l, zeile, zustand));
  try {
    try {
      await bisBereit(l, () => (l.mikrotik.kvm ? 10 : 20) * 60000, () => {
        if (zustand.fehler) throw new Error(zustand.fehler);
        return zustand.bereit;
      }, bezeichnung, 2000);
    } catch (f) {
      // Hat sich der Container beendet, bevor seine Meldung ankam: die letzte
      // FAH-FEHLER-Zeile aus dem Protokoll ist die genauere Ursache.
      if (!/Exit-Code/.test(f.message)) throw f;
      const protokoll = await docker.containerLogs(id, 80).catch(() => '');
      const meldung = protokoll.split('\n').reverse().map((z) => /^FAH-FEHLER (.+)$/.exec(z.trim())?.[1]).find(Boolean);
      throw meldung ? Object.assign(new Error(meldung.slice(0, 500)), { container: f.container }) : f;
    }
    // Eigene Probe über das Vorschau-Netz (Relay im Container auf Port 80).
    let antwort = null;
    for (let versuch = 0; versuch < 5 && antwort?.status !== 200; versuch++) {
      if (versuch) await warte(2000);
      pruefe(l);
      antwort = await httpAbruf(l.ziel, '/');
    }
    if (antwort?.status !== 200) throw new Error(`WebFig ist über das Vorschau-Netz nicht erreichbar (HTTP ${antwort?.status ?? 'keine Antwort'}).`);
  } finally {
    logs.beenden();
  }
  const anmelden = l.schritte.find((s) => s.key === 'anmelden');
  if (anmelden.status !== 'fertig') setze(l, 'anmelden', 'fertig', anmelden.detail);
  console.log(`[vorschau] ${l.app} bereit nach ${Math.round((Date.now() - start) / 1000)} s (${l.mikrotik.identitaet || 'ohne Identität'}, www ${l.mikrotik.wwwPort})`);
}
