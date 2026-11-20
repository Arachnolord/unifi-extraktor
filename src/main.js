// FAH-Extraktor · src/main.js — Urheber: Fabian Hammer © 2026
// Oberfläche: Kachelübersicht der Integrationen, Drop-Zone je Hersteller, Arbeitsplatz
// (UniFi: Übersicht/Vorschau/Sites/MongoDB/…, MikroTik: Übersicht/Virtualisieren/Baum/Hex),
// virtuelle Vorschau mit Dialog, Schrittanzeige und Fenster (iframe). Kein Router:
// der ganze Zustand lebt in Modulvariablen, Sektionen werden per Klasse „hidden“ geschaltet.
import './style.css';
import { openBackup, jsonValue, exportRawZip, exportSite, downloadBlob, detectedVersion } from './backup.js';
import { netzwerkPaket, istSiteExport, verbleibendeGeheimnisse, UEBERGABE_OPTIONEN } from './vorschau-paket.js';
import { kontoStarten, zurAnmeldung, angemeldet, api } from './konto.js';
import { oeffneMikrotik, hexDump, suche as mikrotikSuche, istChrVersion } from './mikrotik.js';
import { oeffneKonfig } from './konfig.js';
import { oeffneOmada } from './omada.js';
import { mitschauStarten, praesenzSenden } from './mitschau.js';
import { indexVon, sucheAlles, markiere, spaltenFuer, wertVon, wichtigstesHtml, felderHtml } from './ansicht.js';

let backup = null;
let activeCollection = null;
let aktiveRubrik = null;
let integration = null; // null | 'unifi' | 'mikrotik' | 'aruba' | 'fortinet'
let aktuelleAnsicht = null;
let suchbegriff = '';
let offeneZeile = null; // { rubrik, nr } – Sprung aus der Suche in den Baum
// Geladene Backups je Integration: zurück zur Übersicht und wieder hinein zeigt das alte Backup.
const geladen = new Map(); // id -> { backup, ansicht, rubrik, collection }
const app = document.querySelector('#app');

// Integrationen A–Z. Nur Hersteller, die ohne Lizenz gehen (Barracuda, Securepoint und Fortinet
// entfallen – Fortinet virtuell nur mit Kauflizenz). Jede Virtualisierung läuft in einem Wegwerf-Container.
const KONFIG_ARTEN = ['aruba', 'fortinet']; // nur durchsuchen (Klartext-Konfigurationen); fortinet ohne Kachel
const NUR_LESEN = 'Gelesen wird nur im Browser – die Datei verlässt deinen Rechner nicht.';
const INTEGRATIONEN = [
  { id: 'aruba', name: 'Aruba', mark: 'A', aktiv: true, badge: 'nur durchsuchen', accept: '.cfg,.conf,.txt,.gz,.tgz,.tar,text/plain,application/octet-stream', titel: 'Aruba-Konfiguration öffnen', text: 'running-config (.cfg, .txt) oder flashbackup.tar.gz hier ablegen', klein: NUR_LESEN, hinweis: 'Konfigurationen von AOS-S, AOS-CX, Instant AP und ArubaOS 8 (auch flashbackup.tar.gz) durchsuchen. Keine Virtualisierung – Aruba bietet kein frei nutzbares Abbild.' },
  { id: 'mikrotik', name: 'MikroTik', mark: 'M', aktiv: true, badge: 'verfügbar', accept: '.backup,.rsc', titel: 'MikroTik-Backup öffnen', text: '.backup oder .rsc hier ablegen', klein: 'Gelesen wird im Browser. Für die Virtualisierung geht die Datei an deinen NAS.', hinweis: 'RouterOS-Backups (.backup, .rsc) durchsuchen und als virtuellen Router (CHR) im Wegwerf-Container starten – wird beim Beenden gelöscht.' },
  { id: 'omada', name: 'Omada', mark: 'O', aktiv: true, badge: 'verfügbar', accept: '.cfg,application/octet-stream', titel: 'Omada-Backup öffnen', text: '.cfg (Backup des Omada-Controllers) hier ablegen', klein: 'Entschlüsselt wird im Browser. Für die Virtualisierung geht die Datei an deinen NAS.', hinweis: 'Omada-Controller-Backups (.cfg) durchsuchen und im Wegwerf-Container (Omada-Controller) öffnen – wird beim Beenden gelöscht.' },
  { id: 'unifi', name: 'UniFi', mark: 'U', aktiv: true, badge: 'verfügbar', accept: '.unf,.unifi,application/octet-stream', titel: 'UniFi-Backup öffnen', text: '.unf oder .unifi hier ablegen', klein: 'Entschlüsselt wird im Browser. Nur für virtuelle Vorschau und Kundenübergabe geht der Network-Teil an deinen NAS.', hinweis: 'Network-Backups (.unf, .unifi) durchsuchen und im Wegwerf-Container (UniFi-Controller) öffnen – wird beim Beenden gelöscht.' },
];
const ART_NAME = { unifi: 'UniFi', mikrotik: 'MikroTik', aruba: 'Aruba', fortinet: 'Fortinet', omada: 'Omada' };
const istKonfig = (b = backup) => KONFIG_ARTEN.includes(b?.art);

app.innerHTML = `
  <header><div class="brand"><span class="mark">F</span><div><strong>FAH-Extraktor</strong><small>Backups lesen · virtuell öffnen</small><small class="credit">by Fabian Hammer © 2026 · Build ${typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'dev'}</small></div></div><div class="kopf-rechts"><span id="integration-pille" class="integration-pille hidden"></span><span class="privacy">● Entschlüsselung im Browser</span><div id="benutzermenue"></div></div></header>
  <div id="konto-hinweis" class="konto-hinweis hidden"></div>
  <main>
    <section id="kacheln" class="kacheln-seite"><h1>Welches Backup möchtest du öffnen?</h1><p>Gelesen wird immer im Browser; nur die virtuelle Vorschau läuft auf deinem NAS.</p><div class="kacheln">${INTEGRATIONEN.map((k) => `<button type="button" class="kachel ${k.aktiv ? 'aktiv' : 'geplant'}" data-i="${k.id}"${k.aktiv ? '' : ' disabled'}><span class="kachel-mark" aria-hidden="true">${k.mark}</span><strong>${k.name}</strong><em class="kachel-badge${k.aktiv ? ' aktiv' : ''}">${k.badge}</em><small class="kachel-hinweis">${escapeHtml(k.hinweis)}</small></button>`).join('')}</div><div id="vorschau-leiste" class="vorschau-leiste hidden"></div></section>
    <section id="drop" class="drop hidden"><div class="upload-icon">⇧</div><h1 id="drop-titel">Backup öffnen</h1><p id="drop-text">Datei hier ablegen</p><button type="button" id="drop-knopf">Datei auswählen</button><input id="picker" type="file" accept=".unf,.unifi,application/octet-stream" hidden><small id="drop-hinweis"></small><button type="button" id="zur-uebersicht-drop" class="secondary-inline">Zur Übersicht</button></section>
    <section id="workspace" class="workspace hidden">
      <aside><div id="file-info" class="file-info"></div><input id="global-suche" class="global-suche" type="search" placeholder="Im ganzen Backup suchen …" autocomplete="off"><nav id="nav"></nav><div class="aside-knoepfe"><button type="button" id="new-file" class="secondary">Anderes Backup</button><button type="button" id="zur-uebersicht" class="secondary">Zur Übersicht</button></div></aside>
      <article id="content"></article>
    </section>
    <section id="konten" class="konten hidden"></section>
    <section id="vorschau-fenster" class="fenster hidden"></section>
  </main>
  <div id="status" class="status hidden"></div>`;

const drop = document.querySelector('#drop');
const picker = document.querySelector('#picker');
document.querySelector('#drop-knopf').onclick = () => picker.click();
document.querySelector('#new-file').onclick = () => picker.click();
document.querySelector('#zur-uebersicht').onclick = zurUebersicht;
document.querySelector('#zur-uebersicht-drop').onclick = zurUebersicht;
picker.onchange = () => picker.files[0] && load(picker.files[0]);
// Suchfeld links: tippen springt in „Suchen“ und zeigt die Treffer sofort.
let suchTakt = null;
document.querySelector('#global-suche').oninput = (e) => {
  suchbegriff = e.target.value;
  clearTimeout(suchTakt);
  suchTakt = setTimeout(() => { if (aktuelleAnsicht === 'suche') { const f = document.querySelector('#such-feld'); if (f) f.value = suchbegriff; sucheZeichnen(); } else select('suche'); }, 180);
};
for (const event of ['dragenter', 'dragover']) drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const event of ['dragleave', 'drop']) drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.remove('over'); });
drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && load(e.dataTransfer.files[0]));
document.querySelectorAll('.kachel.aktiv').forEach((k) => k.onclick = () => integrationWaehlen(k.dataset.i));

// Kachel gewählt: Drop-Zone mit passendem Dateifilter und Texten, Hersteller im Kopf.
function integrationWaehlen(id) {
  const k = INTEGRATIONEN.find((x) => x.id === id);
  if (!k || !k.aktiv) return;
  integration = id;
  picker.accept = k.accept;
  picker.value = '';
  document.querySelector('#drop-titel').textContent = k.titel;
  document.querySelector('#drop-text').textContent = k.text;
  document.querySelector('#drop-hinweis').textContent = k.klein;
  const pille = document.querySelector('#integration-pille');
  pille.textContent = k.name;
  pille.classList.remove('hidden');
  document.querySelector('#kacheln').classList.add('hidden');
  window.scrollTo(0, 0);
  praesenzMelden();
  const g = geladen.get(id);
  if (g) {
    backup = g.backup; aktiveRubrik = g.rubrik; activeCollection = g.collection; vorschauAnsicht = '';
    return arbeitsplatzZeigen(g.ansicht);
  }
  drop.classList.remove('hidden');
}

// Zurück zur Kachelübersicht; das Status-Polling läuft weiter, eine laufende Vorschau bleibt.
function zurUebersicht() {
  if (backup && integration) geladen.set(integration, { backup, ansicht: aktuelleAnsicht, rubrik: aktiveRubrik, collection: activeCollection });
  backup = null; activeCollection = null; aktiveRubrik = null; integration = null;
  fensterSchliessen();
  document.querySelector('#workspace').classList.add('hidden');
  drop.classList.add('hidden');
  document.querySelector('#integration-pille').classList.add('hidden');
  document.querySelector('#kacheln').classList.remove('hidden');
  renderVorschauLeiste();
  window.scrollTo(0, 0);
  aktuelleAnsicht = null; praesenzMelden();
}

async function load(file) {
  const art = integration;
  setStatus(art === 'unifi' ? 'Backup wird lokal entschlüsselt und analysiert …' : 'Datei wird im Browser gelesen …');
  try {
    const neu = art === 'mikrotik' ? await oeffneMikrotik(file) : KONFIG_ARTEN.includes(art) ? await oeffneKonfig(file, art) : art === 'omada' ? await oeffneOmada(file) : await openBackup(file);
    if (art === 'unifi') neu.art = 'unifi';
    backup = neu; activeCollection = null; aktiveRubrik = null; vorschauAnsicht = '';
    geladen.set(integration, { backup });
    suchbegriff = ''; document.querySelector('#global-suche').value = '';
    arbeitsplatzZeigen();
    setStatus('Backup erfolgreich geöffnet.', true);
  } catch (error) { setStatus(error.message, false, true); }
}

// Arbeitsplatz für das aktuelle Backup; ansicht = zuletzt offene Ansicht (sonst Übersicht).
function arbeitsplatzZeigen(ansicht) {
  const mikrotik = backup.art !== 'unifi'; // MikroTik und Konfigs: gleiche Kopfzeile, Übersicht „uebersicht“
  drop.classList.add('hidden'); document.querySelector('#workspace').classList.remove('hidden');
  document.querySelector('#file-info').innerHTML = `<strong>${escapeHtml(backup.name)}</strong><span>${escapeHtml(backup.type)}</span><span>${mikrotik ? `${formatBytes(backup.size)}${backup.identitaet ? ` · ${escapeHtml(backup.identitaet)}` : ''}` : `${formatBytes(backup.size)} · ${backup.files.size} Dateien`}</span>`;
  renderNav();
  select(ansicht || (mikrotik ? 'uebersicht' : 'overview'));
  renderVorschauLeiste();
}

function renderNav() {
  const items = backup.art === 'omada'
    ? [['uebersicht', 'Übersicht'], ['suche', 'Suchen'], ['vorschau', 'Virtualisieren'], ['baum', `Baum (${backup.rubriken.length} Rubriken)`], ['exporttext', 'Inhalt (JSON)'], ['rohdatei', 'Rohdatei (Hex)']]
    : istKonfig()
    ? [['uebersicht', 'Übersicht'], ['suche', 'Suchen'], ['baum', `Baum (${backup.rubriken.length} Rubriken)`], ['exporttext', 'Konfiguration (Text)'], ['rohdatei', 'Rohdatei (Hex)']]
    : backup.art === 'mikrotik'
    ? [['uebersicht', 'Übersicht'], ['suche', 'Suchen'], ['vorschau', 'Virtualisieren'], ['baum', `Baum (${backup.rubriken.length} Rubriken)`], ...(backup.dateiart === 'rsc' ? [['exporttext', 'Export (Text)']] : []), ['rohdatei', 'Rohdatei (Hex)']]
    : [
      ['overview', 'Übersicht'], ['suche', 'Suchen'], ['vorschau', 'Virtuelle Vorschau'], ['sites', `Sites exportieren (${backup.sites.length})`],
      ...(istSiteExport(backup) ? [['uebergabe', 'Kundenübergabe']] : []),
      ['mongo', `MongoDB (${backup.collections.size})`], ['properties', 'system.properties'],
      ['postgres', `PostgreSQL (${backup.pgTables.length})`], ['files', `Rohdateien (${backup.files.size})`]
    ];
  document.querySelector('#nav').innerHTML = items.map(([id, label]) => `<button type="button" data-id="${id}">${label}</button>`).join('');
  document.querySelectorAll('#nav button').forEach((button) => button.onclick = () => select(button.dataset.id));
}

function select(id) {
  selectActive(id);
  ({ overview: showOverview, vorschau: showVorschau, sites: showSites, uebergabe: showUebergabe, mongo: showMongo, properties: showProperties, postgres: showPostgres, files: showFiles,
    suche: showSuche, uebersicht: () => (istKonfig() || backup.art === 'omada' ? showKonfigUebersicht() : showMikrotikUebersicht()), baum: showBaum, rohdatei: showRohdatei, exporttext: showExportText })[id]();
}

function panel(title, sub, body, action = '') { document.querySelector('#content').innerHTML = `<div class="title"><div><h2>${title}</h2><p>${sub}</p></div>${action}</div>${body}`; }

// --- UniFi-Ansichten --------------------------------------------------------
function showOverview() {
  selectActive('overview');
  const cards = [
    ['Sites', backup.sites.length], ['MongoDB Collections', backup.collections.size], ['System Properties', Object.keys(backup.properties.values).length], ['UCore Datendateien', backup.pgTables.length]
  ];
  panel('Backup-Übersicht', 'Erkannter Inhalt und Metadaten', `<div class="vorschau-karte"><div><strong>In der UniFi-Oberfläche ansehen</strong><p>Startet einen abgeschotteten UniFi-Controller mit genau diesem Backup – ohne Verbindung zu echten Geräten.</p></div><button type="button" id="zur-vorschau">Virtuell öffnen</button></div><div class="cards">${cards.map(([a,b]) => `<div><span>${a}</span><strong>${b}</strong></div>`).join('')}</div><h3>Das Wichtigste</h3>${wichtigstesHtml(backup)}<h3>Metadaten</h3><pre>${escapeHtml(jsonValue(backup.metadata))}</pre>`, '<button type="button" id="raw">Rohdaten als ZIP</button>');
  document.querySelector('#raw').onclick = () => exportRawZip(backup);
  document.querySelector('#zur-vorschau').onclick = () => { select('vorschau'); if ((!vorschauGehoertZumBackup() || vorschauStatus.phase === 'fehler') && !vorschauVoll()) vorschauStarten(); };
}
function showSites() {
  panel('Sites exportieren', 'Einzelne Sites als native, importierbare .unf-Datei erzeugen',
    `<div class="version-picker">
      <label for="target-version">Ziel-Controller-Version</label>
      <input id="target-version" type="text" value="${escapeHtml(detectedVersion(backup))}" placeholder="z. B. 9.0.114">
      <small>Wird als <code>version</code> im Export hinterlegt. Für Abwärtskompatibilität hier die Version des Ziel-Controllers eintragen, falls dieser älter als die Quelle ist.</small>
    </div>
    <div class="list">${backup.sites.map((site) => `<div><div><strong>${escapeHtml(site.description)}</strong><span>${escapeHtml(site.name)} · ${escapeHtml(site.id)}</span></div><button type="button" data-site="${escapeHtml(site.id)}">Als .unf exportieren</button></div>`).join('') || '<p>Keine Sites gefunden.</p>'}</div>`);
  document.querySelectorAll('[data-site]').forEach((button) => button.onclick = async () => {
    setStatus('Site-Backup wird erzeugt …');
    try {
      const targetVersion = document.querySelector('#target-version').value;
      const { siteName } = await exportSite(backup, backup.sites.find((s) => s.id === button.dataset.site), targetVersion);
      setStatus(`Importierbare .unf für Site "${siteName}" erstellt – exakt im nativen Single-Site-Format (identisch zu einem Controller-Download). Import ohne Fehler und ohne Re-Login; alle Geräte, Netzwerke und Einstellungen sind enthalten.`, true);
    } catch (error) { setStatus(error.message, false, true); }
  });
}
function zufallsPasswort() {
  const zeichen = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const wert = [...crypto.getRandomValues(new Uint8Array(20))].map((b) => zeichen[b % zeichen.length]).join('');
    if (/[a-z]/.test(wert) && /[A-Z]/.test(wert) && /\d/.test(wert)) return wert;
  }
}

function showUebergabe() {
  const geheimnisse = verbleibendeGeheimnisse(backup);
  const konsole = (backup.collections.get('device') || []).some((geraet) => geraet.type === 'udm');
  panel('Kundenübergabe', 'Einspielbares Backup dieser Site mit eigenem Admin, ohne eure Zugänge',
    `<p class="vorschau-hinweis">Für die Ersteinrichtung eines neuen Controllers, Version ${escapeHtml(detectedVersion(backup))} oder neuer. Eure Admins und euer Geräte-Login sind nicht enthalten.</p>
    ${geheimnisse.length ? `<details class="uebergabe-felder"><summary>Enthält Zugangsdaten der Site, etwa WLAN-Passwörter</summary><p>Gehört etwas davon zu euren Zugängen? ${geheimnisse.map((g) => `<code>${escapeHtml(g.feld)}</code> (${g.anzahl})`).join(', ')}</p></details>` : ''}
    ${konsole ? '<div class="notice">Enthält eine UniFi-OS-Konsole, die ein eigenständiger Controller nicht anzeigt.</div>' : ''}
    <div class="version-picker">
      <label for="kunde-name">Benutzername</label>
      <input id="kunde-name" type="text" autocomplete="off" spellcheck="false" placeholder="z. B. hotel-admin">
      <small>Neuer Admin des Kunden. Gilt auch als Benutzer für Geräte-SSH.</small>
      <label for="kunde-passwort">Passwort</label>
      <input id="kunde-passwort" type="password" data-geheim autocomplete="new-password" spellcheck="false">
      <small>Für die Anmeldung am Controller. Zufällig vorbelegt, du kannst es überschreiben. Beim Erstellen landet es in deiner Zwischenablage, in der Datei steht nur der Hash.</small>
      <button type="button" class="secondary-inline" id="kunde-zeigen">Passwort anzeigen</button>
      <label for="kunde-mail">E-Mail (optional)</label>
      <input id="kunde-mail" type="email" autocomplete="off" spellcheck="false" placeholder="it@kunde.de">
      <small>Adresse des neuen Admins. Ohne Angabe steht dort ein Platzhalter, den der Kunde selbst ändern kann.</small>
    </div>
    <button type="button" id="kunde-erstellen">Backup für Kunden erstellen</button>
    <div id="kunde-ergebnis"></div>`);
  // data-geheim hält das Feld aus der Mitschau heraus, auch solange es sichtbar ist.
  const passwort = document.querySelector('#kunde-passwort');
  const zeigen = document.querySelector('#kunde-zeigen');
  passwort.value = zufallsPasswort();
  zeigen.onclick = () => {
    const verdeckt = passwort.type === 'password';
    passwort.type = verdeckt ? 'text' : 'password';
    zeigen.textContent = verdeckt ? 'Passwort verbergen' : 'Passwort anzeigen';
  };
  document.querySelector('#kunde-erstellen').onclick = uebergabeErstellen;
}

async function uebergabeErstellen() {
  const benutzer = document.querySelector('#kunde-name').value;
  const passwort = document.querySelector('#kunde-passwort').value;
  const email = document.querySelector('#kunde-mail').value;
  const ergebnis = document.querySelector('#kunde-ergebnis');
  ergebnis.replaceChildren();
  setStatus('Backup für den Kunden wird erstellt …');
  try {
    // Ohne Passwort in der Hand wäre die Datei wertlos, deshalb zuerst kopieren.
    try { await navigator.clipboard.writeText(passwort); } catch { throw new Error('Das Passwort konnte nicht in die Zwischenablage. Erlaube den Zugriff und versuche es erneut.'); }
    const angaben = new TextEncoder().encode(JSON.stringify({ benutzer, passwort, email }));
    const antwort = await fetch('/_explorer/api/uebergabe', {
      method: 'POST', body: netzwerkPaket(backup, { [UEBERGABE_OPTIONEN]: angaben }),
      headers: { 'Content-Type': 'application/zip', 'X-Explorer': '1' }
    });
    if (antwort.status === 401) return zurAnmeldung();
    if (!antwort.ok) throw new Error((await antwort.json().catch(() => ({}))).fehler || `Die Datei konnte nicht erstellt werden (HTTP ${antwort.status}).`);
    downloadBlob(await antwort.arrayBuffer(), `${backup.name.replace(/\.unf$/i, '')}-kunde.unf`);
    // Admin-Ereignisse fehlen immer gewollt. Gemeldet wird nur, was wirklich auffällt.
    const ausgelassen = (antwort.headers.get('x-uebergabe-ausgelassen') || '').split(', ').filter((name) => name && name !== 'event: Admin-Ereignisse');
    if (ausgelassen.length) {
      const hinweis = document.createElement('div');
      hinweis.className = 'notice';
      hinweis.textContent = `Unbekannte Daten nicht übernommen: ${ausgelassen.join(', ')}.`;
      ergebnis.append(hinweis);
    }
    setStatus(`Backup für Admin „${benutzer}“ erstellt, das Passwort liegt in der Zwischenablage. Die Datei enthält Zugangsdaten der Site, gib beides getrennt und sicher weiter.`, true);
  } catch (error) { setStatus(error.message, false, true); }
}

function showMongo() { selectActive('mongo'); rubrikBrowser(); }
function showProperties() { panel('system.properties', 'Controller-Konfiguration und interne Parameter', `<div class="table">${Object.entries(backup.properties.values).map(([k,v]) => `<div><code>${escapeHtml(k)}</code><span>${escapeHtml(v)}</span></div>`).join('')}</div><h3>Originaldatei</h3><pre>${escapeHtml(backup.properties.text)}</pre>`); }
function showPostgres() { panel('PostgreSQL / UCore', 'Im Console-Backup enthaltene PostgreSQL-Datendateien', `<div class="notice">Die UCore-Dateien werden unverändert angezeigt und sind im Rohdaten-ZIP enthalten. Die für Network-Exporte relevanten Daten liegen in MongoDB.</div><div class="list compact">${backup.pgTables.map((path) => `<div><code>${path}</code><span>${formatBytes(backup.files.get(path).length)}</span></div>`).join('') || '<p>Keine UCore-PostgreSQL-Daten vorhanden.</p>'}</div>`); }
function showFiles() { panel('Rohdateien', 'Vollständiger entschlüsselter Containerinhalt', `<div class="list compact">${[...backup.files].sort(([a],[b]) => a.localeCompare(b)).map(([path,data]) => `<div><code>${escapeHtml(path)}</code><span>${formatBytes(data.length)}</span></div>`).join('')}</div>`, '<button type="button" id="raw">Alles als ZIP</button>'); document.querySelector('#raw').onclick = () => exportRawZip(backup); }

// Hex-Dumps erst beim Aufklappen erzeugen (500 Datensätze × Hex wären sonst viel DOM).
function hexLazy(ziel, bytesVon) {
  ziel.querySelectorAll('.hex-block').forEach((block) => block.addEventListener('toggle', () => {
    const pre = block.querySelector('pre');
    if (block.open && pre && !pre.textContent) pre.textContent = hexDump(bytesVon(Number(block.dataset.hex)) || new Uint8Array(0));
  }));
}

// --- MikroTik-Ansichten -----------------------------------------------------
function adressText(a) {
  return `${a.adresse}/${a.prefix}${a.name ? ` · ${a.name}` : ''}${a.schnittstelle ? ` · ${a.schnittstelle}` : ''}${a.hotspot ? ' (Hotspot – kein WebFig erreichbar)' : a.vlan ? ' (VLAN – als Zugangsweg ungeeignet)' : a.disabled ? ' (deaktiviert)' : ''}`;
}
// Omada: Start mit optionalem eigenem Konto (Omada übernimmt die Konten aus dem Backup nicht).
let omadaMerker = null;
function omadaStartHtml() {
  const vorschlag = omadaMerker?.benutzer || backup.admins?.[0]?.benutzer || 'admin';
  return `<div class="vorschau-start"><ul>
      <li>Auf dem NAS startet ein Omada-Controller im Wegwerf-Container, das Backup wird eingespielt und du wirst automatisch angemeldet.</li>
      <li>Abgeschottet: keine Verbindung zu echten Geräten oder zur TP-Link-Cloud; beim Beenden wird alles gelöscht.</li></ul>
      <div class="omada-konto"><label class="feld"><span>Benutzer</span><input id="omada-benutzer" autocomplete="off" autocapitalize="none" spellcheck="false" value="${escapeHtml(vorschlag)}"></label>
      <label class="feld"><span>Passwort (optional)</span><input id="omada-passwort" type="password" autocomplete="new-password" value="${escapeHtml(omadaMerker?.passwort || '')}"></label></div>
      <small class="vorschau-hinweis">Leer lassen = automatisches Wegwerf-Konto. Mit Passwort bekommt die Vorschau genau dieses Konto – so meldest du dich wie gewohnt an (Groß-/Kleinbuchstaben, Ziffer, Sonderzeichen).</small>
      <button type="button" data-v="start">Virtuell öffnen</button><small>Dauert etwa 1–2 Minuten, beim allerersten Mal länger (Controller wird geladen).${belegtText()}</small></div>`;
}
function omadaOptionenLesen() {
  const b = document.querySelector('#omada-benutzer'), p = document.querySelector('#omada-passwort');
  if (!b || !p) return omadaMerker || {};
  const benutzer = b.value.trim(), passwort = p.value;
  if (passwort && !/^[\x21-\x7E]{1,64}$/.test(benutzer)) { setStatus('Benutzername: 1–64 Zeichen, keine Leerzeichen.', false, true); return null; }
  if (passwort && !(passwort.length >= 8 && passwort.length <= 64 && /[A-Z]/.test(passwort) && /[a-z]/.test(passwort) && /\d/.test(passwort) && /[^A-Za-z0-9]/.test(passwort) && /^[\x21-\x7E]+$/.test(passwort))) {
    setStatus('Omada verlangt 8–64 Zeichen mit Groß- und Kleinbuchstaben, Ziffer und Sonderzeichen (ohne Leerzeichen).', false, true); return null;
  }
  omadaMerker = { benutzer, passwort };
  return omadaMerker;
}
// MikroTik im neuen Tab über die Rahmen-Seite (WebFig braucht "/" aus einem Frame), UniFi direkt.
function tabPfad() { return vorschauArt() === 'unifi' ? '/_explorer/api/vorschau/oeffnen' : '/_explorer/api/vorschau/tab'; }
function virtualisierungGesperrt() {
  if (backup.unbekannt) return 'Die Datei ist keine RouterOS-Sicherung (unbekannter Dateikopf) – bitte ein .backup oder einen .rsc-Export vom Router öffnen.';
  if (backup.verschluesselt) return 'Verschlüsselte Backups lassen sich noch nicht virtuell öffnen – auf dem Router mit <code>/system backup save dont-encrypt=yes</code> erneut sichern. Die Baumansicht bleibt bis zur Entschlüsselung leer.';
  if (backup.version.hauptversion === '6') return 'RouterOS-6-Backups: die Virtualisierung folgt in einer späteren Stufe. Die Baumansicht steht bereit.';
  return null;
}
function showMikrotikUebersicht() {
  selectActive('uebersicht');
  const b = backup;
  const saetze = b.rubriken.reduce((n, r) => n + r.saetze.length, 0);
  const versionKurz = b.version.genau || (b.version.hauptversion ? `${b.version.hauptversion}${b.version.mindestens ? ` · ≥ ${b.version.mindestens}` : ''}` : '?');
  const cards = [['Rubriken', b.rubriken.length], ['Datensätze', saetze], ['IP-Adressen', b.adressen.length], ['RouterOS', versionKurz]];
  const gesperrt = virtualisierungGesperrt();
  panel('Backup-Übersicht', `${escapeHtml(b.type)} · ${escapeHtml(b.version.anzeige)}${b.identitaet ? ` · Identität <strong>${escapeHtml(b.identitaet)}</strong>` : ''}`,
    `${gesperrt ? `<div class="notice">${gesperrt}</div>` : `<div class="vorschau-karte"><div><strong>Als virtuellen Router öffnen</strong><p>Startet RouterOS (CHR) mit genau diesem Backup in einem abgeschotteten Netz – WebFig im Fenster, ohne Verbindung zu echten Geräten.</p></div><button type="button" id="zur-vorschau">Virtuell öffnen</button></div>`}
    <div class="cards">${cards.map(([a, w]) => `<div><span>${a}</span><strong class="${String(w).length > 6 ? 'klein' : ''}">${escapeHtml(w)}</strong></div>`).join('')}</div>
    <h3>Hinweise</h3><ul class="hinweise">${b.version.hinweise.map((h) => `<li>${escapeHtml(h)}</li>`).join('') || '<li>Keine.</li>'}</ul>
    <h3>Das Wichtigste</h3>${wichtigstesHtml(b)}`,
    '<button type="button" id="json-alles">Alles als JSON</button>');
  document.querySelector('#zur-vorschau')?.addEventListener('click', () => select('vorschau'));
  document.querySelector('#json-alles').onclick = () => downloadBlob(JSON.stringify({
    name: b.name, type: b.type, version: b.version, identitaet: b.identitaet, adressen: b.adressen, ports: b.ports,
    rubriken: b.rubriken.map((r) => ({ schluessel: r.schluessel, pfad: r.pfad, saetze: r.saetze.map(satzJson) })),
  }, null, 2), `${b.name.replace(/\.[^.]+$/, '')}.json`, 'application/json');
}
// Aruba/Fortinet: nur durchsuchen – Gerät, Hinweise, Adressen, WLANs.
function showKonfigUebersicht() {
  selectActive('uebersicht');
  const b = backup;
  const saetze = b.rubriken.reduce((n, r) => n + r.saetze.length, 0);
  const g = b.geraet || {};
  const cards = [['Rubriken', b.rubriken.length], ['Datensätze', saetze], ['Zeilen', b.zeilen || 0], ['Firmware', b.version.genau || '?']];
  const zeilen = [['Hersteller', g.hersteller], ['Variante', g.variante], ['Modell', g.modell], ['Firmware', g.firmware], ['Hostname', g.hostname], ['Datei', b.quelle !== b.name ? b.quelle : null]].filter(([, w]) => w);
  const adresse = (a) => `${a.adresse}${a.prefix != null ? `/${a.prefix}` : ''} · ${a.schnittstelle}${a.name ? ` · ${a.name}` : ''}${a.vdom ? ` · VDOM ${a.vdom}` : ''}`;
  panel('Konfigurations-Übersicht', `${escapeHtml(b.type)} · ${escapeHtml(b.version.anzeige)}${b.identitaet ? ` · <strong>${escapeHtml(b.identitaet)}</strong>` : ''}`,
    `${b.art === 'omada' ? '<div class="vorschau-karte"><div><strong>Im Omada-Controller ansehen</strong><p>Startet einen abgeschotteten Omada-Controller (Wegwerf-Container) mit genau diesem Backup – automatisch angemeldet, ohne Verbindung zu echten Geräten.</p></div><button type="button" id="zur-vorschau">Virtuell öffnen</button></div>' : `<div class="notice">Nur durchsuchen: ${escapeHtml(b.nichtVirtuell || '')}</div>`}
    <div class="cards">${cards.map(([a, w]) => `<div><span>${a}</span><strong class="${String(w).length > 6 ? 'klein' : ''}">${escapeHtml(w)}</strong></div>`).join('')}</div>
    <h3>Gerät</h3><div class="table">${zeilen.map(([a, w]) => `<div><code>${a}</code><span>${escapeHtml(w)}</span></div>`).join('') || '<div><span>Keine Angaben in der Datei.</span></div>'}</div>
    <h3>Hinweise</h3><ul class="hinweise">${b.version.hinweise.map((h) => `<li>${escapeHtml(h)}</li>`).join('') || '<li>Keine.</li>'}</ul>
    <h3>Das Wichtigste</h3>${wichtigstesHtml(b)}`,
    '<button type="button" id="json-alles">Alles als JSON</button>');
  document.querySelector('#zur-vorschau')?.addEventListener('click', () => select('vorschau'));
  document.querySelector('#json-alles').onclick = () => downloadBlob(JSON.stringify({
    name: b.name, type: b.type, geraet: b.geraet, version: b.version, adressen: b.adressen, wlans: b.wlans,
    rubriken: b.rubriken.map((r) => ({ pfad: r.pfad, saetze: r.saetze.map(satzJson) })),
  }, null, 2), `${b.name.replace(/\.[^.]+$/, '')}.json`, 'application/json');
}
function satzJson(s) { return { nr: s.nr, titel: s.titel, felder: s.felder.map(({ name, idHex, typName, anzeige }) => ({ name, idHex, typName, anzeige })) }; }

function showBaum() { selectActive('baum'); rubrikBrowser(); }

// Rubrik-Browser für alle Arten: links Rubriken (UniFi: Collections), rechts eine Tabelle mit den
// aussagekräftigsten Spalten; ein Klick auf eine Zeile zeigt alle Felder direkt darunter.
function rubrikBrowser() {
  const unifi = backup.art === 'unifi';
  const rubriken = indexVon(backup);
  let aktiv = unifi ? activeCollection : aktiveRubrik;
  if (!rubriken.find((r) => r.schluessel === aktiv)) aktiv = (rubriken.find((r) => r.saetze.length > 1) || rubriken.find((r) => r.saetze.length) || rubriken[0])?.schluessel || null;
  const merke = (k) => { aktiv = k; if (unifi) activeCollection = k; else aktiveRubrik = k; };
  merke(aktiv);
  const art = ART_NAME[backup.art];
  const gesperrt = backup.verschluesselt ? '<div class="notice">Das Backup ist verschlüsselt – es gibt noch keine Rubriken zu zeigen.</div>' : backup.unbekannt ? `<div class="notice">Keine passende ${escapeHtml(art)}-Datei erkannt – es gibt keine Rubriken zu zeigen.</div>` : '';
  panel(unifi ? 'Daten (MongoDB)' : 'Baumansicht', 'Rubrik wählen – die Datensätze stehen als Tabelle da, ein Klick auf eine Zeile zeigt alle Felder. Über alles suchen: Feld links oben.',
    `${gesperrt}<div class="mongo"><div class="collections"><input id="rubrik-suche" placeholder="Rubrik suchen …">${rubriken.map((r) => `<button type="button" data-r="${escapeHtml(r.schluessel)}" class="${r.schluessel === aktiv ? 'active' : ''}${r.saetze.length ? '' : ' leer'}"><span class="rubrik-name">${escapeHtml(r.pfad)}${r.pfad !== r.schluessel ? `<small>${escapeHtml(r.schluessel)}</small>` : ''}</span><span class="zaehler">${r.saetze.length}</span></button>`).join('')}</div><div class="documents"><div class="toolbar"><input id="doc-search" placeholder="In dieser Rubrik filtern …"><button type="button" id="json-export">JSON speichern</button></div><div id="docs"></div></div></div>`);
  const zeichnen = () => {
    const woerter = document.querySelector('#doc-search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rubrik = rubriken.find((r) => r.schluessel === aktiv);
    const ziel = document.querySelector('#docs');
    if (!rubrik) { ziel.innerHTML = '<p class="empty">Keine Rubrik vorhanden.</p>'; return; }
    const saetze = rubrik.saetze.filter((x) => woerter.every((w) => x.text.includes(w)));
    if (rubrik.saetze.length === 1 && !woerter.length) {
      ziel.innerHTML = `<div class="einzel"><h3>${escapeHtml(rubrik.saetze[0].titel)}</h3>${detailHtml(rubrik.saetze[0], rubrik, [])}</div>`;
      hexLazy(ziel, () => rohVon(rubrik.saetze[0], rubrik));
      return;
    }
    const spalten = spaltenFuer(rubrik);
    ziel.innerHTML = `${rubrik.gekuerzt ? `<div class="notice">Diese Collection hat ${rubrik.gekuerzt} Dokumente – Tabelle und Suche zeigen die ersten ${rubrik.saetze.length}.</div>` : ''}<p class="treffer-zahl">${saetze.length} von ${rubrik.saetze.length} Datensätzen${saetze.length > 500 ? ' (die ersten 500 angezeigt)' : ''}</p>`
      + (saetze.length ? `<div class="tabelle-rahmen"><table class="daten klickbar"><thead><tr><th>Nr</th><th>Bezeichnung</th>${spalten.map((sp) => `<th>${escapeHtml(sp)}</th>`).join('')}</tr></thead><tbody>${saetze.slice(0, 500).map((x, i) => `<tr class="zeile" data-z="${i}"><td>${x.nr}</td><td>${markiere(x.titel, woerter)}</td>${spalten.map((sp) => `<td>${markiere(wertVon(x, sp), woerter)}</td>`).join('')}</tr><tr class="detail hidden"><td colspan="${spalten.length + 2}"></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Keine Treffer in dieser Rubrik.</p>');
    ziel.querySelectorAll('tr.zeile').forEach((tr) => tr.onclick = () => zeileUmschalten(tr, saetze[Number(tr.dataset.z)], rubrik, woerter));
    if (offeneZeile && offeneZeile.rubrik === rubrik.schluessel) {
      const i = saetze.findIndex((x) => x.nr === offeneZeile.nr);
      offeneZeile = null;
      const tr = i >= 0 && i < 500 ? ziel.querySelector(`tr.zeile[data-z="${i}"]`) : null;
      if (tr) { zeileUmschalten(tr, saetze[i], rubrik, []); tr.scrollIntoView({ block: 'center' }); }
    }
  };
  document.querySelectorAll('[data-r]').forEach((button) => button.onclick = () => {
    merke(button.dataset.r);
    document.querySelectorAll('[data-r]').forEach((b) => b.classList.toggle('active', b.dataset.r === aktiv));
    zeichnen();
  });
  document.querySelector('#rubrik-suche').oninput = (e) => { const q = e.target.value.toLowerCase(); document.querySelectorAll('[data-r]').forEach((b) => b.hidden = !(b.dataset.r.toLowerCase().includes(q) || b.textContent.toLowerCase().includes(q))); };
  document.querySelector('#doc-search').oninput = zeichnen;
  document.querySelector('#json-export').onclick = () => {
    const rubrik = rubriken.find((r) => r.schluessel === aktiv);
    if (!rubrik) return;
    const inhalt = unifi ? jsonValue(backup.collections.get(rubrik.schluessel)) : JSON.stringify(rubrik.saetze.map(satzJson), null, 2);
    downloadBlob(inhalt, `${rubrik.schluessel.replace(/^\//, '').replace(/[\/ ›]+/g, '_')}.json`, 'application/json');
  };
  zeichnen();
}
const rohVon = (satz, rubrik) => (backup.art === 'unifi' ? backup.rawCollections?.get(rubrik.schluessel)?.[satz.docIndex] : satz.roh) || null;
function detailHtml(satz, rubrik, woerter) {
  const roh = rohVon(satz, rubrik);
  const quelleTitel = backup.art === 'omada' ? 'JSON' : `Originalzeilen${satz.zeileNr ? ` (ab Zeile ${satz.zeileNr})` : ''}`;
  return `${felderHtml(satz, woerter)}${satz.quelle ? `<details class="quelle-block"><summary>${quelleTitel}</summary><pre class="exporttext">${escapeHtml(satz.quelle)}</pre></details>` : ''}`
    + `${satz.objekt ? `<details class="quelle-block"><summary>JSON</summary><pre class="exporttext">${escapeHtml(JSON.stringify(satz.objekt, null, 2))}</pre></details>` : ''}`
    + `${roh ? `<details class="hex-block" data-hex="0"><summary>Rohdaten (Hex, ${roh.length} Byte)</summary><pre class="hex"></pre></details>` : ''}`;
}
function zeileUmschalten(tr, satz, rubrik, woerter) {
  const detail = tr.nextElementSibling;
  const zu = detail.classList.toggle('hidden');
  tr.classList.toggle('offen', !zu);
  if (!zu && !detail.dataset.gefuellt) {
    detail.firstElementChild.innerHTML = detailHtml(satz, rubrik, woerter);
    detail.dataset.gefuellt = '1';
    hexLazy(detail, () => rohVon(satz, rubrik));
  }
}

// Suche über das ganze Backup: Treffer nach Rubrik, je Datensatz die passenden Felder markiert.
function showSuche() {
  selectActive('suche');
  panel('Suchen', 'Durchsucht alle Rubriken, Datensätze, Feldnamen und Werte – mehrere Wörter müssen alle vorkommen.',
    `<input id="such-feld" class="such-gross" type="search" placeholder="z. B. gast, 192.168.250, vlan 20, passphrase …" autocomplete="off" value="${escapeHtml(suchbegriff)}"><div id="such-treffer"></div>`);
  const feld = document.querySelector('#such-feld');
  let takt = null;
  feld.oninput = () => { suchbegriff = feld.value; document.querySelector('#global-suche').value = feld.value; clearTimeout(takt); takt = setTimeout(sucheZeichnen, 150); };
  sucheZeichnen();
  if (document.activeElement?.id !== 'global-suche') feld.focus();
}
function sucheZeichnen() {
  const ziel = document.querySelector('#such-treffer');
  if (!ziel || !backup) return;
  const { woerter, treffer, mehr } = sucheAlles(backup, suchbegriff);
  if (woerter.join('').length < 2) { ziel.innerHTML = '<p class="empty">Mindestens 2 Zeichen eingeben. Feldnamen gehen auch – z. B. „ssid“, „vlan“, „passphrase“, „dhcp“.</p>'; return; }
  if (!treffer.length) { ziel.innerHTML = '<p class="empty">Keine Treffer. Weniger oder kürzere Wörter versuchen.</p>'; return; }
  const gruppen = new Map();
  treffer.forEach((t, i) => { if (!gruppen.has(t.rubrik)) gruppen.set(t.rubrik, []); gruppen.get(t.rubrik).push({ ...t, i }); });
  ziel.innerHTML = `<p class="treffer-zahl">${treffer.length}${mehr ? '+' : ''} Treffer in ${gruppen.size} ${gruppen.size === 1 ? 'Rubrik' : 'Rubriken'}${mehr ? ' – genauer suchen, um alle zu sehen' : ''}</p>`
    + [...gruppen].map(([r, liste]) => `<section class="treffer-gruppe"><h3>${markiere(r.pfad, woerter)} <small>${liste.length}</small></h3>${liste.map((t) => `<div class="treffer"><div class="treffer-kopf"><span>${markiere(t.satz.titel, woerter)}</span><button type="button" class="secondary-inline" data-sprung="${t.i}">im Baum zeigen</button></div>${felderHtml(t.satz, woerter, t.felder.length ? t.felder.slice(0, 12) : t.satz.felder.slice(0, 6))}${t.felder.length > 12 ? `<p class="empty">… ${t.felder.length - 12} weitere passende Felder im Baum</p>` : ''}</div>`).join('')}</section>`).join('');
  ziel.querySelectorAll('[data-sprung]').forEach((b) => b.onclick = () => {
    const t = treffer[Number(b.dataset.sprung)];
    offeneZeile = { rubrik: t.rubrik.schluessel, nr: t.satz.nr };
    if (backup.art === 'unifi') { activeCollection = t.rubrik.schluessel; select('mongo'); } else { aktiveRubrik = t.rubrik.schluessel; select('baum'); }
  });
}

function showRohdatei() {
  selectActive('rohdatei');
  let grenze = 65536;
  panel('Rohdatei (Hex)', `${escapeHtml(backup.name)} · ${formatBytes(backup.size)}`, '<pre class="hex" id="rohdatei-hex"></pre><button type="button" class="secondary-inline" id="rohdatei-mehr">Mehr anzeigen</button>');
  const zeichnen = () => {
    document.querySelector('#rohdatei-hex').textContent = hexDump(backup.roh, grenze);
    document.querySelector('#rohdatei-mehr').hidden = grenze >= backup.roh.length;
  };
  document.querySelector('#rohdatei-mehr').onclick = () => { grenze += 65536; zeichnen(); };
  zeichnen();
}

function showExportText() {
  selectActive('exporttext');
  const konfig = istKonfig() || backup.art === 'omada';
  panel(backup.art === 'omada' ? 'Inhalt (JSON)' : konfig ? 'Konfiguration (Text)' : 'Export (Text)', backup.art === 'omada' ? `Entschlüsselter Inhalt von ${escapeHtml(backup.name)} · ${backup.zeilen} Zeilen` : konfig ? `Original: ${escapeHtml(backup.quelle)} · ${backup.zeilen} Zeilen` : 'Der .rsc-Export im Original', `<pre class="exporttext">${escapeHtml(backup.exportText || '')}</pre>`, `<button type="button" id="rsc-speichern">${konfig ? 'Als Textdatei speichern' : 'Als .rsc speichern'}</button>`);
  document.querySelector('#rsc-speichern').onclick = () => downloadBlob(backup.exportText || '', backup.art === 'omada' ? backup.name.replace(/\.cfg$/i, '') + '.json' : konfig ? `${String(backup.quelle).split('/').pop().replace(/\.(gz|tgz|tar)$/i, '')}${/\.(cfg|conf|txt)$/i.test(backup.quelle) ? '' : '.txt'}` : backup.name, 'text/plain');
}

// --- Virtuelle Vorschau: Backup in einem abgeschotteten Wegwerf-Controller/-Router ---
let vorschauStatus = { aktiv: false };
let vorschauTimer = null;
let vorschauAnsicht = '';
let leisteAnsicht = '';
let chrVorbereitung = null; // letzte Antwort von GET mikrotik/vorbereitung
let chrMerker = {};         // getippte Dialogwerte, damit Ansichtswechsel und „Erneut versuchen“ nichts verlieren
let pulsTimer = null;
const LAUFEND = ['vorbereiten', 'laden', 'starten', 'einspielen', 'anmelden'];

function vorschauArt(s = vorschauStatus) { return s.art || 'unifi'; }
function vorschauGehoertZumBackup() { return Boolean(backup && vorschauStatus.aktiv && vorschauStatus.name === backup.name && vorschauArt() === backup.art); }
// Die eigene Vorschau wird ersetzt; voll ist es nur durch die der anderen Konten.
function vorschauVoll() { return (vorschauStatus.andere || []).length >= (vorschauStatus.max || 6); }
function belegtText() { const s = vorschauStatus; return s.andere?.length ? ` Gerade belegt: ${s.andere.length} von ${s.max} Vorschauen.` : ''; }
function kopierenMoeglich() { return Boolean(navigator.clipboard && window.isSecureContext); }
function kopierKnopf(text) { return kopierenMoeglich() && text ? `<button type="button" class="kopieren" data-kopie="${escapeHtml(text)}">Kopieren</button>` : ''; }
async function kopieren(text) {
  try { await navigator.clipboard.writeText(text); setStatus('Kopiert.', true); } catch { setStatus('Kopieren nicht möglich – bitte markieren und kopieren.', false, true); }
}

function showVorschau() {
  selectActive('vorschau');
  const mikrotik = backup.art === 'mikrotik';
  const omada = backup.art === 'omada';
  panel(mikrotik || omada ? 'Virtualisieren' : 'Virtuelle Vorschau',
    mikrotik ? 'Das Backup als virtuellen Router (CHR) im Wegwerf-Container starten und in WebFig ansehen – abgeschottet, ohne Verbindung zu echten Geräten'
      : omada ? 'Das Backup in einem Omada-Controller im Wegwerf-Container ansehen – automatisch angemeldet, abgeschottet, ohne Verbindung zu echten Geräten'
        : 'Das Backup in der echten UniFi-Oberfläche (Wegwerf-Container) ansehen – abgeschottet, ohne Verbindung zu echten Geräten',
    '<div id="vorschau-inhalt"></div>');
  vorschauAnsicht = '';
  renderVorschau();
}

function vorschauZustand() {
  const s = vorschauStatus;
  if (!vorschauGehoertZumBackup()) {
    if (vorschauVoll()) return 'voll';
    if (backup.art === 'mikrotik') return virtualisierungGesperrt() ? 'gesperrt' : 'dialog';
    return 'start';
  }
  return s.phase === 'bereit' ? 'bereit' : s.phase === 'fehler' ? 'fehler' : 'lauf';
}

function renderVorschau() {
  renderVorschauLeiste();
  fensterPruefen();
  const ziel = document.querySelector('#vorschau-inhalt');
  if (!ziel || !backup) return;
  const zustand = vorschauZustand();
  // Der Dialog bleibt beim Polling stehen (getippte Werte); nur die Belegungszeile wird nachgeführt.
  if (zustand === 'dialog' && ziel.querySelector('#chr-dialog')) {
    const b = ziel.querySelector('#chr-belegt');
    if (b) b.textContent = belegtText();
    return;
  }
  const html = vorschauHtml(zustand);
  if (html === vorschauAnsicht) return;
  const offen = ziel.querySelector('details')?.open;
  ziel.innerHTML = html;
  vorschauAnsicht = html;
  if (offen && ziel.querySelector('details')) ziel.querySelector('details').open = true;
  ziel.querySelectorAll('[data-v="start"]').forEach((b) => b.onclick = () => vorschauStarten());
  ziel.querySelectorAll('[data-v="ende"]').forEach((b) => b.onclick = () => vorschauBeenden());
  ziel.querySelectorAll('[data-v="fenster"]').forEach((b) => b.onclick = fensterOeffnen);
  ziel.querySelectorAll('.kopieren').forEach((b) => b.onclick = () => kopieren(b.dataset.kopie));
  ziel.querySelectorAll('[data-v="fremd-ende"]').forEach((b) => b.onclick = () => {
    if (!b.classList.contains('bestaetigen')) {
      b.classList.add('bestaetigen');
      b.textContent = 'Wirklich beenden?';
      setTimeout(() => { b.classList.remove('bestaetigen'); b.textContent = 'Beenden'; }, 4000);
      return;
    }
    vorschauBeenden(b.dataset.id);
  });
  if (zustand === 'dialog') dialogEinrichten(ziel.querySelector('#chr-dialog'));
}

// Wenn alle Plätze belegt sind: wer gerade welche Vorschau nutzt. Administratoren
// können eine fremde Vorschau beenden, um Platz zu schaffen.
function andereVorschauen(s) {
  const admin = angemeldet()?.rolle === 'admin';
  // Nur minutengenau, damit die Abfrage alle 10 s die Rückfrage am Knopf nicht wegwischt.
  const jetzt = s.jetzt || Date.now();
  return `<div class="list vorschau-andere">${s.andere.map((v) => `<div><div><strong>${escapeHtml(v.name)}</strong><span>${escapeHtml(ART_NAME[vorschauArt(v)] || '')} · ${escapeHtml(v.gestartetVon)} · ${v.phase === 'bereit' ? `${v.offeneSockets ? 'gerade geöffnet' : `zuletzt genutzt vor ${Math.max(1, Math.round((jetzt - v.letzteAktivitaet) / 60000))} min`}` : 'startet gerade'}</span></div>${admin ? `<button type="button" class="secondary-inline gefahr" data-v="fremd-ende" data-id="${escapeHtml(v.id)}">Beenden</button>` : ''}</div>`).join('')}</div>`;
}

function vorschauHtml(zustand) {
  const s = vorschauStatus;
  if (zustand === 'voll' || zustand === 'start' || zustand === 'dialog' || zustand === 'gesperrt') {
    const zuletzt = !s.aktiv && s.zuletzt && s.zuletzt.name === backup.name && (s.zuletzt.art || 'unifi') === backup.art ? `<p class="vorschau-hinweis">Die letzte Vorschau dieses Backups wurde ${escapeHtml(s.zuletzt.grund)}.</p>` : '';
    if (zustand === 'voll') {
      return `${zuletzt}<div class="notice">Es laufen schon ${s.max} virtuelle Vorschauen – mehr verkraftet der NAS nicht gleichzeitig. Sobald eine endet, kannst du hier starten.</div>${andereVorschauen(s)}`;
    }
    const eigene = s.aktiv && s.phase !== 'fehler' ? `<div class="notice">Deine Vorschau „${escapeHtml(s.name)}“ (${ART_NAME[vorschauArt()]}) läuft noch. Sie wird beim Start ersetzt – jedes Konto hat eine Vorschau.</div>` : '';
    if (zustand === 'gesperrt') return `${eigene}${zuletzt}<div class="notice">${virtualisierungGesperrt()}</div>`;
    if (zustand === 'dialog') return `${eigene}${zuletzt}${dialogHtml()}`;
    if (backup.art === 'omada') return `${eigene}${zuletzt}${omadaStartHtml()}`;
    return `${eigene}${zuletzt}<div class="vorschau-start"><ul>
      <li>Auf dem NAS startet ein UniFi-Controller in der Version des Backups, das Backup wird eingespielt und du wirst automatisch angemeldet.</li>
      <li>Er läuft in einem abgeschotteten Netz: Geräte erscheinen getrennt, nichts erreicht echte Hardware.</li>
      <li>Übertragen wird nur der Network-Teil des Backups; beim Beenden wird alles gelöscht.</li>${istSiteExport(backup) ? '<li>Das ist ein Site-Export: Du siehst nur diese eine Site, ohne Einstellungen des ganzen Controllers.</li>' : ''}</ul>
      <button type="button" data-v="start">Virtuell öffnen</button><small>Dauert etwa 1–3 Minuten, wenn eine Controller-Version erst geladen werden muss, länger.${belegtText()}</small></div>`;
  }
  const dauer = formatDauer((s.jetzt || Date.now()) - s.gestartet);
  const schritte = `<ol class="schritte">${(s.schritte || []).map((x) => `<li class="${x.status}"><span class="punkt" aria-hidden="true"></span><div><strong>${escapeHtml(x.text)}</strong>${x.detail ? `<small>${escapeHtml(x.detail)}</small>` : ''}</div></li>`).join('')}</ol>`;
  const mikrotik = vorschauArt() === 'mikrotik';
  if (zustand === 'bereit') {
    const v = s.version || {};
    const m = s.mikrotik || {};
    const z = s.zugang || {};
    const zeile = mikrotik
      ? `${m.identitaet || 'RouterOS'} · RouterOS ${m.routerosVersion || '?'}${m.chrVersion ? ` · CHR ${m.chrVersion}` : ''} · ${m.modus === 'wan' ? 'WAN' : 'lokal'}${m.zugangIp ? ` ${m.zugangIp}` : ''}${m.wwwPort ? `:${m.wwwPort}` : ''}${m.kvm === false ? ' · ohne KVM' : ''}`
      : vorschauArt() === 'omada'
        ? `${(s.omada?.sites || []).join(', ') || 'keine Site'} · Omada Controller ${s.omada?.controllerVersion || ''}${s.omada?.backupVersion ? ` (Backup aus ${s.omada.backupVersion})` : ''}${(s.omada?.hinweise || []).map((h) => ` · ${h}`).join('')}`
        : `${s.geraete} ${s.geraete === 1 ? 'Gerät' : 'Geräte'} · ${(s.sites || []).join(', ') || 'default'} · UniFi Network ${v.controller || ''}`;
    const zugang = mikrotik
      ? `<span>WebFig fragt nach der Anmeldung: <code>${escapeHtml(z.benutzer || '')}</code>${kopierKnopf(z.benutzer)} / <code>${escapeHtml(z.passwort || '')}</code>${kopierKnopf(z.passwort)}</span>${(m.hinweise || []).map((h) => `<span>${escapeHtml(h)}</span>`).join('')}`
      : `<span>Fragt die Oberfläche nach einer Anmeldung, einfach erneut öffnen – oder <code>${escapeHtml(z.benutzer || '')}</code> / <code>${escapeHtml(z.passwort || '')}</code>.</span>`;
    return `<div class="vorschau-bereit"><div><strong>Bereit</strong><span>${escapeHtml(zeile)}</span></div>
      <div class="vorschau-knoepfe"><button type="button" data-v="fenster">Im Fenster öffnen</button><a class="knopf secondary-inline" href="${tabPfad()}" target="_blank" rel="noopener">Neuer Tab</a></div></div>
      ${!mikrotik && v.angeglichen ? `<div class="notice">Für UniFi Network ${escapeHtml(v.backup)} gibt es kein Controller-Programm – die Vorschau läuft mit ${escapeHtml(v.controller)} und kann leicht abweichen.</div>` : ''}
      <div class="vorschau-info">${zugang}<span>Endet ${s.leerlaufMin} Minuten ohne Nutzung, spätestens nach ${s.hoechstdauerStd} Stunden.</span></div>
      <details><summary>Ablauf (${dauer})</summary>${schritte}</details>
      <button type="button" class="secondary-inline" data-v="ende">Vorschau beenden</button>`;
  }
  if (zustand === 'fehler') {
    return `<div class="vorschau-fehler"><strong>Vorschau fehlgeschlagen</strong><p>${escapeHtml(s.fehler?.text || 'Unbekannter Fehler')}</p></div>${schritte}
      ${s.fehler?.log ? `<details><summary>Protokoll</summary><pre>${escapeHtml(s.fehler.log)}</pre></details>` : ''}
      <div class="vorschau-knoepfe">${mikrotik ? '<button type="button" data-v="ende">Erneut versuchen</button><small class="vorschau-hinweis">Öffnet wieder den Dialog mit deinen Angaben.</small>' : '<button type="button" data-v="start">Erneut versuchen</button><button type="button" class="secondary-inline" data-v="ende">Schließen</button>'}</div>`;
  }
  return `<div class="vorschau-lauf"><strong>${mikrotik ? 'Virtueller Router wird vorbereitet' : 'Vorschau wird vorbereitet'}</strong><span>${dauer}</span></div>${schritte}<button type="button" class="secondary-inline" data-v="ende">Abbrechen</button>`;
}

// --- MikroTik-Dialog „Virtualisieren“ --------------------------------------
function versionOptionen(v, gewaehlt) {
  const optionen = [];
  if (v) {
    const lokal = v.lokal || [];
    for (const k of v.kanaele || []) optionen.push([k.version, `${k.version} (${k.kanal}${lokal.includes(k.version) ? ', im Cache' : ''})${versionAlt(k.version)}`]);
    for (const l of lokal) if (!optionen.some(([w]) => w === l)) optionen.push([l, `${l} (im Cache)${versionAlt(l)}`]);
  } else optionen.push(['', 'Versionen werden geladen …']);
  optionen.push(['andere', 'Andere Version …']);
  const auswahl = gewaehlt && optionen.some(([w]) => w === gewaehlt) ? gewaehlt : (v?.vorschlag && optionen.some(([w]) => w === v.vorschlag) ? v.vorschlag : optionen[0][0]);
  return optionen.map(([w, t]) => `<option value="${escapeHtml(w)}"${w === auswahl ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('');
}
function versionAlt(version) {
  const m = backup?.version?.mindestens;
  return m && versionVergleich(version, m) < 0 ? ' – älter als das Backup' : '';
}
function versionVergleich(a, b) {
  const pa = String(a).split(/[.]|(?=rc|beta)/).map((x) => Number.parseInt(x, 10) || 0), pb = String(b).split(/[.]|(?=rc|beta)/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

function dialogHtml() {
  const b = backup; const m = chrMerker; const v = chrVorbereitung;
  const rsc = b.dateiart === 'rsc';
  const adressen = b.adressen || [];
  const vorgabe = m.zugangIp && adressen.some((a) => `${a.adresse}/${a.prefix}` === m.zugangIp) ? m.zugangIp : (b.zugangVorschlag ? `${b.zugangVorschlag.ip}/${b.zugangVorschlag.prefix}` : '');
  const modus = m.modus === 'wan' || !adressen.length ? 'wan' : 'lokal';
  const ipOptionen = `${vorgabe ? '' : '<option value="" selected>Bitte wählen …</option>'}${adressen.map((a) => { const w = `${a.adresse}/${a.prefix}`; return `<option value="${escapeHtml(w)}"${w === vorgabe ? ' selected' : ''}>${escapeHtml(adressText(a))}</option>`; }).join('')}`;
  return `<form class="vorschau-dialog konto-form" id="chr-dialog" novalidate>
    <div class="breit dialog-erkannt">Erkannt: <strong>${escapeHtml(b.version.anzeige)}</strong>${b.identitaet ? ` · Identität <strong>${escapeHtml(b.identitaet)}</strong>` : ''} · ${adressen.length} IP-Adresse${adressen.length === 1 ? '' : 'n'}</div>
    ${rsc ? '<div class="notice breit">Ein .rsc-Export enthält keine Benutzer: die Vorschau läuft mit <code>admin</code> und einem Wegwerf-Passwort (wird unter Zugang angezeigt). Der Import bricht beim ersten Fehler ab – ein .backup ist die sicherere Wahl.</div>' : ''}
    <label class="feld breit"><span>RouterOS-Version (CHR)</span><select id="chr-version">${versionOptionen(v, m.version)}</select>
      <small class="feld-hilfe">Vorgeschlagen ist die neueste stabile Version deiner Hauptversion (von upgrade.mikrotik.com, zwischengespeichert). Fehlt sie im Cache, lädt der NAS sie einmalig (~45 MB).</small>
      <small class="feld-hilfe hinweis-gelb" id="chr-version-hinweis">${escapeHtml(v?.hinweis || '')}</small></label>
    <label class="feld breit${(m.version || v?.vorschlag) === 'andere' ? '' : ' hidden'}" id="chr-version-frei-feld"><span>Andere Version</span><input id="chr-version-frei" autocomplete="off" spellcheck="false" placeholder="z. B. 7.19.4" value="${escapeHtml(m.versionFrei || '')}"><small class="feld-hilfe">Muss bei MikroTik als CHR-Image existieren (z. B. 7.19.4 oder 7.25rc1); RouterOS 6 wird noch nicht unterstützt.</small></label>
    <fieldset class="auswahl breit"><legend>Zugangsweg zu WebFig</legend>
      <label class="auswahl-zeile"><input type="radio" name="zugang" value="lokal"${modus === 'lokal' ? ' checked' : ''}${adressen.length ? '' : ' disabled'}><div><strong>Lokal über eine Router-Adresse</strong><select id="zugang-ip"${adressen.length ? '' : ' disabled'}>${ipOptionen}</select><small>WebFig wird über diese Adresse erreicht; der Vorschau-Zugang hängt sich als Port in deren Bridge. Vorgabe 192.168.250.1, sonst die erste Bridge-Adresse.${adressen.length ? '' : ' Im Backup wurde keine IP-Adresse gefunden – es bleibt der WAN-Weg.'}</small></div></label>
      <label class="auswahl-zeile"><input type="radio" name="zugang" value="wan"${modus === 'wan' ? ' checked' : ''}><div><strong>WAN/Remote (DHCP über den Uplink)</strong><small>Zugang wie von außen über den Uplink-Port${b.wan?.schnittstelle ? ` (${escapeHtml(b.wan.schnittstelle)})` : ''}. Achtung: dann laufen die Skripte des Routers scharf (VPN/DDNS-Versuche, mehr CPU-Last).</small></div></label>
    </fieldset>
    ${rsc ? '' : `<label class="feld"><span>Benutzer</span><input name="benutzer" autocomplete="off" autocapitalize="none" spellcheck="false" value="${escapeHtml(m.benutzer || '')}"></label>
    <label class="feld"><span>Passwort</span><input name="passwort" type="password" autocomplete="off" value="${escapeHtml(m.passwort || '')}"></label>
    <small class="feld-hilfe breit">Zugang des Router-Admins aus dem Backup (nach dem Einspielen gelten die Benutzer des Backups). Vorbelegung: Benutzerverwaltung → Standard-Zugang MikroTik.</small>`}
    <p class="meldung hidden breit" role="alert"></p>
    <div class="knoepfe"><button type="submit">Virtuell öffnen</button></div>
    <small class="breit dialog-fuss">Dauert etwa 1 Minute; beim ersten Laden einer RouterOS-Version länger.<span id="chr-belegt">${belegtText()}</span></small>
  </form>`;
}

function dialogEinrichten(form) {
  if (!form) return;
  const select = form.querySelector('#chr-version');
  const freiFeld = form.querySelector('#chr-version-frei-feld');
  const frei = form.querySelector('#chr-version-frei');
  const meldung = (text) => { const z = form.querySelector('.meldung'); z.textContent = text; z.classList.toggle('hidden', !text); };
  const merke = () => {
    chrMerker = { ...chrMerker, version: select.value, versionFrei: frei.value, modus: form.querySelector('[name="zugang"]:checked')?.value, zugangIp: form.querySelector('#zugang-ip')?.value || chrMerker.zugangIp,
      benutzer: form.querySelector('[name="benutzer"]')?.value ?? chrMerker.benutzer, passwort: form.querySelector('[name="passwort"]')?.value ?? chrMerker.passwort };
  };
  const freiZeigen = () => { freiFeld.classList.toggle('hidden', select.value !== 'andere'); if (select.value === 'andere') frei.focus(); };
  select.onchange = () => { select.dataset.gewaehlt = '1'; freiZeigen(); merke(); };
  form.querySelectorAll('input, select').forEach((el) => el.addEventListener('input', merke));
  form.querySelectorAll('[name="zugang"]').forEach((r) => r.addEventListener('change', merke));
  freiZeigen();
  form.onsubmit = (e) => { e.preventDefault(); merke(); dialogAbsenden(form, meldung); };

  // Versionsliste und Vorbelegung holen; getippte Werte werden nie überschrieben.
  const hv = backup.version.hauptversion || '7';
  const pfad = `mikrotik/vorbereitung?hauptversion=${encodeURIComponent(hv)}${backup.version.mindestens ? `&mindestens=${encodeURIComponent(backup.version.mindestens)}` : ''}`;
  api(pfad).then((v) => {
    chrVorbereitung = v;
    if (!form.isConnected) return;
    const gewaehlt = select.dataset.gewaehlt ? select.value : chrMerker.version;
    select.innerHTML = versionOptionen(v, gewaehlt);
    freiZeigen();
    form.querySelector('#chr-version-hinweis').textContent = v.hinweis || '';
    for (const name of ['benutzer', 'passwort']) {
      const feld = form.querySelector(`[name="${name}"]`);
      if (feld && !feld.value && v.zugang?.[name]) feld.value = v.zugang[name];
    }
    if (v.image === false) { meldung('Vorschau-Image fehlt – auf dem NAS „./manage.sh rebuild“ ausführen.'); form.querySelector('[type="submit"]').disabled = true; }
    const belegt = form.querySelector('#chr-belegt');
    if (belegt && typeof v.belegt === 'number' && v.max) belegt.textContent = v.belegt ? ` Gerade belegt: ${v.belegt} von ${v.max} Vorschauen.` : '';
  }).catch((fehler) => {
    if (!form.isConnected) return;
    if (!chrVorbereitung) { select.innerHTML = versionOptionen(null, 'andere'); select.value = 'andere'; freiZeigen(); }
    meldung(`Versionsliste nicht verfügbar (${fehler.message}) – Version bitte von Hand eintragen.`);
  });
}

function dialogAbsenden(form, meldung) {
  const b = backup;
  const select = form.querySelector('#chr-version');
  let chrVersion = select.value === 'andere' ? form.querySelector('#chr-version-frei').value.trim() : select.value;
  if (!chrVersion) return meldung('Bitte eine RouterOS-Version wählen oder eintragen.');
  if (!istChrVersion(chrVersion)) return meldung('Version bitte wie „7.24.5“ angeben (auch 7.25rc1 oder 7.26beta1).');
  if (chrVersion.split('.')[0] === '6') return meldung('RouterOS 6 wird für die Vorschau noch nicht unterstützt.');
  const modus = form.querySelector('[name="zugang"]:checked')?.value || 'lokal';
  let ip = '', prefix = null;
  if (modus === 'lokal') {
    const w = form.querySelector('#zugang-ip')?.value || '';
    if (!w) return meldung('Bitte eine Router-Adresse wählen – oder den WAN-Weg nehmen.');
    [ip, prefix] = w.split('/'); prefix = Number(prefix);
  }
  let benutzer = 'admin', passwort = '';
  if (b.dateiart === 'backup') {
    benutzer = form.querySelector('[name="benutzer"]').value.trim();
    passwort = form.querySelector('[name="passwort"]').value;
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(benutzer)) return meldung('Benutzername: 1–64 Zeichen aus Buchstaben, Ziffern und . _ @ - (kein Leerzeichen, kein +).');
    if (passwort.length > 128 || /[\r\n\u0000-\u001f]/.test(passwort)) return meldung('Passwort: höchstens 128 Zeichen, keine Zeilenumbrüche.');
  }
  const optionen = { dateiart: b.dateiart, chrVersion, benutzer, passwort, zugang: { modus, ip, prefix } };
  if (b.dateiart === 'rsc') optionen.ports = (b.ports || []).filter((p) => p.defaultName).map((p) => ({ defaultName: p.defaultName }));
  meldung('');
  const knopf = form.querySelector('[type="submit"]');
  knopf.disabled = true;
  vorschauStarten(optionen).finally(() => { if (form.isConnected) knopf.disabled = false; });
}

// --- Fenster: die Vorschau-Oberfläche als iframe unter dem Kopf ---------------
function fensterOffen() { return !document.querySelector('#vorschau-fenster').classList.contains('hidden'); }
function fensterOeffnen() {
  const s = vorschauStatus;
  if (!s.aktiv || s.phase !== 'bereit') return setStatus('Die Vorschau ist noch nicht bereit.', false, true);
  const art = vorschauArt();
  const z = s.zugang || {};
  const url = `${location.origin}${tabPfad()}`;
  const f = document.querySelector('#vorschau-fenster');
  f.innerHTML = `<div class="fenster-kopf">
    <div class="fenster-titel"><strong>${art === 'unifi' ? 'UniFi-Oberfläche' : art === 'omada' ? 'Omada-Oberfläche' : 'WebFig'}</strong><span>${escapeHtml(s.name)} · ${ART_NAME[art]}</span></div>
    <div class="fenster-status">${art === 'mikrotik'
      ? `<span>WebFig fragt separat nach Benutzer und Passwort: <code>${escapeHtml(z.benutzer || '')}</code>${kopierKnopf(z.benutzer)} / <code>${escapeHtml(z.passwort || '')}</code>${kopierKnopf(z.passwort)}</span>`
      : `<span>Automatisch angemeldet · sonst <code>${escapeHtml(z.benutzer || '')}</code> / <code>${escapeHtml(z.passwort || '')}</code></span>`}
      <span class="fenster-url">Zugangs-URL <code>${escapeHtml(url)}</code>${kopierKnopf(url)}</span></div>
    <div class="fenster-knoepfe"><a class="knopf secondary-inline" href="${tabPfad()}" target="_blank" rel="noopener">Neuer Tab</a><button type="button" class="secondary-inline" data-f="neu">Neu laden</button>${art === 'omada' ? '<button type="button" class="secondary-inline" data-f="eigen" title="Ohne automatische Anmeldung – Benutzer und Passwort aus dem Backup eingeben">Mit eigenem Konto anmelden</button>' : ''}<button type="button" class="secondary-inline" data-f="schliessen">Fenster schließen</button><button type="button" class="secondary-inline gefahr" data-f="ende">Vorschau beenden</button></div>
  </div><iframe class="fenster-rahmen" src="/_explorer/api/vorschau/oeffnen?eingebettet=1" allow="clipboard-read; clipboard-write" title="Virtuelle Vorschau"></iframe>`;
  f.querySelector('[data-f="neu"]').onclick = () => { const r = f.querySelector('iframe'); r.src = `/_explorer/api/vorschau/oeffnen?eingebettet=1&t=${Date.now()}`; };
  f.querySelector('[data-f="eigen"]')?.addEventListener('click', () => { f.querySelector('iframe').src = `/_explorer/api/vorschau/oeffnen?eingebettet=1&konto=eigen&t=${Date.now()}`; });
  f.querySelector('[data-f="schliessen"]').onclick = () => { fensterSchliessen(); setStatus('Fenster geschlossen – die Vorschau läuft weiter.', true); };
  const ende = f.querySelector('[data-f="ende"]');
  ende.onclick = () => {
    if (!ende.classList.contains('bestaetigen')) {
      ende.classList.add('bestaetigen');
      ende.textContent = 'Wirklich beenden?';
      setTimeout(() => { ende.classList.remove('bestaetigen'); ende.textContent = 'Vorschau beenden'; }, 4000);
      return;
    }
    fensterSchliessen();
    vorschauBeenden();
  };
  f.querySelectorAll('.kopieren').forEach((b) => b.onclick = () => kopieren(b.dataset.kopie));
  f.classList.remove('hidden');
  document.body.classList.add('fenster-offen');
  clearInterval(pulsTimer);
  // Lebenszeichen alle 5 Minuten: WebFig hält keinen WebSocket offen, ohne Puls endet der Lauf im Leerlauf.
  pulsTimer = setInterval(() => fetch('/_explorer/api/vorschau/puls', { method: 'POST', headers: { 'X-Explorer': '1' } }).catch(() => {}), 300000);
}
function fensterSchliessen() {
  const f = document.querySelector('#vorschau-fenster');
  if (!f) return;
  f.innerHTML = '';
  f.classList.add('hidden');
  document.body.classList.remove('fenster-offen');
  clearInterval(pulsTimer);
  pulsTimer = null;
}
// Fenster zu, sobald die Vorschau nicht mehr bereit ist (beendet, fehlgeschlagen, ersetzt).
function fensterPruefen() {
  if (!fensterOffen()) return;
  const s = vorschauStatus;
  if (!s.aktiv || s.phase !== 'bereit') { fensterSchliessen(); setStatus(s.phase === 'fehler' ? 'Die Vorschau ist fehlgeschlagen – das Fenster wurde geschlossen.' : 'Die Vorschau ist beendet – das Fenster wurde geschlossen.', false, s.phase === 'fehler'); }
}

// Hinweis auf der Kachelübersicht, wenn die eigene Vorschau noch läuft.
function renderVorschauLeiste() {
  const leiste = document.querySelector('#vorschau-leiste');
  const s = vorschauStatus;
  if (!s.aktiv || backup) { leiste.classList.add('hidden'); leisteAnsicht = ''; return; }
  const bereit = s.phase === 'bereit';
  const schritt = (s.schritte || []).find((x) => x.status === 'laeuft')?.text;
  const text = bereit ? 'Virtuelle Vorschau läuft' : s.phase === 'fehler' ? 'Virtuelle Vorschau fehlgeschlagen' : `Virtuelle Vorschau startet …${schritt ? ` (${escapeHtml(schritt)})` : ''}`;
  const html = `<span>${text}: <strong>${escapeHtml(s.name)}</strong> <em>${ART_NAME[vorschauArt()]}</em></span>${bereit ? '<button type="button" data-v="fenster">Im Fenster öffnen</button>' : ''}<button type="button" class="secondary-inline" data-v="ende">${bereit ? 'Beenden' : s.phase === 'fehler' ? 'Schließen' : 'Abbrechen'}</button>`;
  leiste.classList.remove('hidden');
  if (html === leisteAnsicht) return;
  leiste.innerHTML = html;
  leisteAnsicht = html;
  leiste.querySelector('[data-v="ende"]').onclick = () => vorschauBeenden();
  leiste.querySelector('[data-v="fenster"]')?.addEventListener('click', fensterOeffnen);
}

async function vorschauAbfragen() {
  clearTimeout(vorschauTimer);
  try {
    const antwort = await fetch('/_explorer/api/vorschau', { cache: 'no-store' });
    if (antwort.status === 401) { fensterSchliessen(); return zurAnmeldung(); }
    if (antwort.ok) { vorschauStatus = await antwort.json(); renderVorschau(); praesenzMelden(); }
  } catch { /* Backend nicht erreichbar - beim nächsten Durchlauf erneut */ }
  const laeuft = vorschauStatus.aktiv && LAUFEND.includes(vorschauStatus.phase);
  vorschauTimer = setTimeout(vorschauAbfragen, laeuft ? 1500 : 10000);
}

// UniFi: Network-Teil als ZIP; MikroTik: Rohdatei plus Optionen aus dem Dialog im Kopf.
async function vorschauStarten(optionen) {
  if (!backup) return;
  const mikrotik = backup.art === 'mikrotik';
  if (mikrotik && !optionen) return;
  if (backup.art === 'omada' && !optionen) { optionen = omadaOptionenLesen(); if (!optionen) return; }
  setStatus(backup.art === 'unifi' ? 'Network-Teil wird an den NAS übertragen …' : 'Backup wird an den NAS übertragen …');
  try {
    const rohdatei = backup.art !== 'unifi'; // MikroTik und Omada: Datei unverändert, UniFi: Network-Teil als ZIP
    const headers = { 'Content-Type': rohdatei ? 'application/octet-stream' : 'application/zip', 'X-Explorer': '1', 'X-Backup-Name': encodeURIComponent(backup.name) };
    if (mikrotik || backup.art === 'omada') headers['X-Vorschau-Optionen'] = encodeURIComponent(JSON.stringify(optionen));
    const antwort = await fetch(`/_explorer/api/vorschau?art=${backup.art}`, { method: 'POST', body: rohdatei ? backup.roh : netzwerkPaket(backup), headers });
    if (antwort.status === 401) { fensterSchliessen(); return zurAnmeldung(); }
    const daten = await antwort.json().catch(() => ({}));
    if (!antwort.ok) throw new Error(daten.fehler || `Die Vorschau konnte nicht gestartet werden (HTTP ${antwort.status}).`);
    vorschauStatus = daten;
    renderVorschau();
    setStatus('Vorschau wird gestartet …', true);
    vorschauAbfragen();
  } catch (error) { setStatus(error.message, false, true); }
}

// Ohne id die eigene Vorschau, mit id eine fremde (nur Administratoren).
async function vorschauBeenden(id) {
  try {
    const antwort = await fetch(`/_explorer/api/vorschau${id ? `?id=${encodeURIComponent(id)}` : ''}`, { method: 'DELETE', headers: { 'X-Explorer': '1' } });
    if (antwort.status === 401) { fensterSchliessen(); return zurAnmeldung(); }
    const daten = await antwort.json().catch(() => ({}));
    if (!antwort.ok) throw new Error(daten.fehler || `Die Vorschau konnte nicht beendet werden (HTTP ${antwort.status}).`);
    vorschauStatus = daten;
    renderVorschau();
  } catch (error) { setStatus(error.message, false, true); }
}

function formatDauer(ms) { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min`; }

function praesenzMelden() {
  const art = integration ? (ART_NAME[integration] || integration) : (backup ? ART_NAME[backup.art] : null);
  try { praesenzSenden({ art, integration: art, backupName: backup?.name || null, ansicht: aktuelleAnsicht, vorschauAktiv: Boolean(vorschauStatus?.aktiv && vorschauGehoertZumBackup()) }); } catch { /* vor dem Start egal */ }
}
function selectActive(id) { aktuelleAnsicht = id; document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.id === id)); praesenzMelden(); }
function setStatus(text, success = false, error = false) { const el = document.querySelector('#status'); el.textContent = text; el.className = `status ${success ? 'success' : ''} ${error ? 'error' : ''}`; clearTimeout(setStatus.timer); setStatus.timer = setTimeout(() => el.classList.add('hidden'), error ? 7000 : 3500); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function formatBytes(value) { if (!value) return '0 B'; const i = Math.floor(Math.log(value) / Math.log(1024)); return `${(value / 1024 ** i).toFixed(i ? 1 : 0)} ${['B','KB','MB','GB'][i]}`; }

kontoStarten().then(() => { const u = angemeldet(); if (u) { mitschauStarten(u.rolle); praesenzMelden(); } });
vorschauAbfragen();
