// FAH-Extraktor · src/mitschau.js — Urheber: Fabian Hammer © 2026
// Mitschau & Co-Browsing: eine WebSocket-Verbindung je Oberfläche zum Backend-Hub. Zusehen und
// Steuern starten erst nach ausdrücklicher Zustimmung der gastgebenden Seite; währenddessen zeigt
// ein Balken, wer zusieht/steuert, und beide Seiten können jederzeit beenden. Passwörter werden nie
// mitgespiegelt. Dieses Modul bringt sein eigenes Overlay, seine Banner und Dialoge mit.
import { escapeHtml, istGeheim } from './ansicht.js';

let sock = null, meineId = null, meineRolle = 'benutzer';
let letztePraesenz = { integration: null, backupName: null, ansicht: null, vorschauAktiv: false };
let beobachteMich = new Map(); // obsId -> { name, modus } (wer mir gerade zusieht)
let steuertMich = null;        // { id, name } des Steuernden
let ichBeobachte = null;       // { host, name } wen ich gerade sehe
let ichSteuere = false;        // steuere ich den Host, dem ich zusehe?
let teilen = null;             // Aufräumer, solange ich meinen Bildschirm spiegle
let listeOffen = false, letzteListe = [];

const sende = (m) => { try { sock?.readyState === 1 && sock.send(JSON.stringify(m)); } catch { /* egal */ } };

export function mitschauStarten(rolle) {
  meineRolle = rolle || 'benutzer';
  stileEinspielen();
  verbinde();
  window.addEventListener('beforeunload', () => sock?.close());
}

function verbinde() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/_explorer/ws/mitschau`;
  try { sock = new WebSocket(url); } catch { return; }
  sock.onopen = () => praesenzSenden(letztePraesenz);
  sock.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } behandle(m); };
  sock.onclose = () => { sock = null; aufraeumenAlles(); setTimeout(verbinde, 4000); };
  sock.onerror = () => { try { sock.close(); } catch { /* egal */ } };
}

// Von main.js bei jedem Ansichtswechsel aufgerufen.
export function praesenzSenden(p) {
  letztePraesenz = { integration: p.integration ?? null, backupName: p.backupName ?? null, ansicht: p.ansicht ?? null, vorschauAktiv: Boolean(p.vorschauAktiv) };
  sende({ t: 'praesenz', ...letztePraesenz });
}

function behandle(m) {
  switch (m.t) {
    case 'willkommen': meineId = m.id; meineRolle = m.rolle; break;
    case 'liste': letzteListe = m.sitzungen || []; if (listeOffen) listeZeichnen(); break;
    case 'hinweis': meldung(m.text); break;
    case 'anfrage': zustimmungFragen(m); break;

    case 'mitschau-an': beobachteMich.set(m.wer, { name: m.name, modus: m.modus }); teilenStarten(); hostBannerZeichnen(); break;
    case 'mitschau-aus': beobachteMich.delete(m.wer); if (steuertMich?.id === m.wer) steuertMich = null; if (!beobachteMich.size) teilenStoppen(); hostBannerZeichnen(); meldung(`${m.name} sieht nicht mehr zu (${m.grund}).`); break;
    case 'spiegel-start': teilenStarten(); break;
    case 'spiegel-stopp': teilenStoppen(); break;

    case 'zusehen-an': ichBeobachte = { host: m.host, name: m.name, darfSteuernAnfragen: m.darfSteuernAnfragen }; ichSteuere = false; overlayOeffnen(); break;
    case 'zusehen-aus': ichBeobachte = null; ichSteuere = false; overlaySchliessen(); meldung(`Mitschau bei ${m.name} beendet (${m.grund}).`); break;
    case 'spiegel': spiegelAnzeigen(m); break;
    case 'zeiger': zeigerAnzeigen(m.x, m.y); break;

    case 'steuern-an': steuertMich = { id: m.wer, name: m.name }; hostBannerZeichnen(); meldung(`${m.name} steuert jetzt mit.`); break;
    case 'steuern-aus': steuertMich = null; ichSteuere = false; hostBannerZeichnen(); overlaySteuerStand(); break;
    case 'steuern-du-an': ichSteuere = true; overlaySteuerStand(); meldung(`Du steuerst jetzt die Sitzung von ${m.name}.`); break;
    case 'steuern-du-aus': ichSteuere = false; overlaySteuerStand(); meldung(`Steuerung beendet.`); break;

    case 'eingabe': eingabeAnwenden(m); break;
    default: break;
  }
}

// =============================================================== Admin: Sitzungsliste
export function mitschauListeOeffnen() {
  listeOffen = true;
  sende({ t: 'liste' });
  const el = dialog('mitschau-liste');
  listeZeichnen();
}
function listeZeichnen() {
  const el = document.querySelector('#mitschau-liste .dlg-inhalt');
  if (!el) return;
  const ansichtsName = (a) => ({ uebersicht: 'Übersicht', overview: 'Übersicht', suche: 'Suchen', baum: 'Baum', mongo: 'Daten', vorschau: 'Virtualisieren', rohdatei: 'Rohdatei', exporttext: 'Textansicht', sites: 'Sites' }[a] || a || '–');
  const zeilen = letzteListe.map((s) => `<div class="ms-sitzung"><div class="ms-wer"><strong>${escapeHtml(s.name)}</strong>${s.rolle === 'admin' ? '<span class="rolle admin">Admin</span>' : ''}
    <small>${s.integration ? escapeHtml(s.integration) : 'keine Integration'}${s.backupName ? ` · ${escapeHtml(s.backupName)}` : ''} · ${escapeHtml(ansichtsName(s.ansicht))}${s.vorschauAktiv ? ' · Vorschau läuft' : ''}${s.beobachtetGerade ? ' · wird beobachtet' : ''}${s.wirdGesteuert ? ' · wird gesteuert' : ''}</small></div>
    <div class="ms-aktionen"><button type="button" class="secondary-inline" data-zusehen="${s.id}">Zusehen anfragen</button><button type="button" class="secondary-inline" data-einladen="${s.id}">In meine Sitzung einladen</button></div></div>`).join('');
  el.innerHTML = `<p class="feld-hilfe">Zusehen und Steuern starten erst, wenn die andere Seite zustimmt. Sie sieht durchgehend, wer dabei ist.</p>${zeilen || '<p class="empty">Gerade ist niemand sonst angemeldet.</p>'}`;
  el.querySelectorAll('[data-zusehen]').forEach((b) => b.onclick = () => { sende({ t: 'zusehen-anfrage', ziel: b.dataset.zusehen }); meldung('Anfrage gesendet – warte auf Zustimmung.'); });
  el.querySelectorAll('[data-einladen]').forEach((b) => b.onclick = () => { sende({ t: 'einladen', ziel: b.dataset.einladen, modus: 'zusehen' }); meldung('Einladung gesendet.'); });
}

// =============================================================== Zustimmungs-Dialog
function zustimmungFragen(m) {
  const wer = `${escapeHtml(m.von.name)}${m.von.rolle === 'admin' ? ' (Administrator)' : ''}`;
  const text = m.art === 'steuern'
    ? `${wer} möchte deine Sitzung mitsteuern. Du siehst jede Aktion und kannst die Steuerung jederzeit wieder entziehen.`
    : m.art === 'einladen'
      ? `${wer} lädt dich ein, bei seiner Sitzung zuzusehen.`
      : `${wer} möchte bei deiner Sitzung zusehen. Deine Oberfläche wird gespiegelt (ohne Passwörter), solange die Mitschau läuft.`;
  const el = dialog('mitschau-zustimmung', false);
  el.querySelector('.dlg-inhalt').innerHTML = `<p>${text}</p><div class="dlg-knoepfe"><button type="button" class="knopf" data-ja>${m.art === 'steuern' ? 'Steuerung erlauben' : 'Zusehen erlauben'}</button><button type="button" class="secondary-inline" data-nein>Ablehnen</button></div>`;
  const schliess = () => el.remove();
  el.querySelector('[data-ja]').onclick = () => { sende(m.art === 'steuern' ? { t: 'steuern-antwort', token: m.token, ja: true } : { t: 'antwort', token: m.token, ja: true }); schliess(); };
  el.querySelector('[data-nein]').onclick = () => { sende(m.art === 'steuern' ? { t: 'steuern-antwort', token: m.token, ja: false } : { t: 'antwort', token: m.token, ja: false }); schliess(); };
}

// =============================================================== Host: meinen Bildschirm teilen
function teilenStarten() {
  if (teilen) { schnappschussSenden(); return; }
  let taktTimer = null;
  const geplant = () => { if (taktTimer) return; taktTimer = setTimeout(() => { taktTimer = null; schnappschussSenden(); }, 300); };
  const mo = new MutationObserver(geplant);
  mo.observe(document.querySelector('main'), { subtree: true, childList: true, attributes: true, characterData: true });
  const beiScroll = () => sende({ t: 'spiegel', ...nurScroll() });
  let zeigerTimer = 0;
  const beiZeiger = (e) => { const jetzt = Date.now(); if (jetzt - zeigerTimer < 80) return; zeigerTimer = jetzt; sende({ t: 'zeiger', x: e.clientX, y: e.clientY }); };
  window.addEventListener('scroll', beiScroll, { passive: true });
  window.addEventListener('resize', geplant, { passive: true });
  document.addEventListener('pointermove', beiZeiger, { passive: true });
  teilen = () => { mo.disconnect(); clearTimeout(taktTimer); window.removeEventListener('scroll', beiScroll); window.removeEventListener('resize', geplant); document.removeEventListener('pointermove', beiZeiger); };
  schnappschussSenden();
}
function teilenStoppen() { if (teilen) { teilen(); teilen = null; } }

function nurScroll() { return { html: '', titel: '', route: '', breite: window.innerWidth, hoehe: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY, nurScroll: true }; }

// Schnappschuss der Oberfläche: #app klonen, Eingabewerte übertragen, Passwörter schwärzen,
// Skripte und das Vorschau-iframe (fremde Origin) herausnehmen.
function schnappschussSenden() {
  const wurzel = document.querySelector('main');
  if (!wurzel) return;
  const klon = wurzel.cloneNode(true);
  const quelle = wurzel.querySelectorAll('input, textarea, select');
  const ziel = klon.querySelectorAll('input, textarea, select');
  quelle.forEach((el, i) => {
    const z = ziel[i]; if (!z) return;
    if (istGeheim(el)) { z.setAttribute('value', ''); z.setAttribute('placeholder', '••••••'); }
    else if (el.tagName === 'INPUT') { if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) z.setAttribute('checked', ''); else z.removeAttribute('checked'); } else z.setAttribute('value', el.value); }
    else if (el.tagName === 'TEXTAREA') z.textContent = el.value;
    else if (el.tagName === 'SELECT') { const o = z.querySelectorAll('option'); z.querySelectorAll('option').forEach((opt, k) => { if (k === el.selectedIndex) opt.setAttribute('selected', ''); else opt.removeAttribute('selected'); }); }
  });
  klon.querySelectorAll('script').forEach((s) => s.remove());
  klon.querySelectorAll('iframe').forEach((f) => { const d = document.createElement('div'); d.className = 'ms-iframe-platz'; d.textContent = 'Fenster der virtuellen Vorschau – aus Datenschutzgründen nicht gespiegelt.'; f.replaceWith(d); });
  sende({ t: 'spiegel', html: klon.outerHTML, titel: document.title, route: letztePraesenz.ansicht || '', breite: window.innerWidth, hoehe: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY });
}

// =============================================================== Beobachter: Overlay mit Spiegel
let overlay = null, rahmen = null, zeigerEl = null;
function overlayOeffnen() {
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'ms-overlay';
  overlay.innerHTML = `<div class="ms-kopf"><strong>Mitschau: ${escapeHtml(ichBeobachte.name)}</strong>
    <span class="ms-steuerstand"></span>
    <span class="ms-kopf-knoepfe">${ichBeobachte.darfSteuernAnfragen ? '<button type="button" class="secondary-inline" data-ms="steuern">Steuerung anfragen</button>' : ''}<button type="button" class="secondary-inline gefahr" data-ms="beenden">Mitschau beenden</button></span></div>
    <div class="ms-buehne"><iframe class="ms-rahmen" sandbox="allow-same-origin"></iframe><div class="ms-zeiger" hidden></div></div>`;
  document.body.appendChild(overlay);
  rahmen = overlay.querySelector('.ms-rahmen');
  zeigerEl = overlay.querySelector('.ms-zeiger');
  overlay.querySelector('[data-ms="beenden"]').onclick = () => sende({ t: 'beenden' });
  const sb = overlay.querySelector('[data-ms="steuern"]');
  if (sb) sb.onclick = () => { if (ichSteuere) { sende({ t: 'steuern-stopp' }); } else { sende({ t: 'steuern-anfrage' }); meldung('Steuerung angefragt – warte auf Zustimmung.'); } };
  overlaySteuerStand();
}
function overlaySchliessen() { overlay?.remove(); overlay = rahmen = zeigerEl = null; }
function overlaySteuerStand() {
  if (!overlay) return;
  overlay.querySelector('.ms-steuerstand').textContent = ichSteuere ? 'Du steuerst mit' : 'Nur zusehen';
  overlay.classList.toggle('steuernd', ichSteuere);
  const sb = overlay.querySelector('[data-ms="steuern"]');
  if (sb) sb.textContent = ichSteuere ? 'Steuerung zurückgeben' : 'Steuerung anfragen';
  try { rahmen?.contentWindow?.postMessage({ __msSteuern: ichSteuere }, '*'); } catch { /* egal */ }
}

let cssHref = '';
function spiegelAnzeigen(m) {
  if (!rahmen) return;
  if (m.nurScroll) { try { rahmen.contentWindow.scrollTo(m.scrollX || 0, m.scrollY || 0); } catch { /* egal */ } return; }
  cssHref ||= document.querySelector('link[rel="stylesheet"]')?.getAttribute('href') || '';
  const doc = `<!doctype html><html><head><meta charset="utf-8">${cssHref ? `<link rel="stylesheet" href="${escapeHtml(cssHref)}">` : ''}
    <style>body{margin:0;background:#080d16}main{display:block}.ms-iframe-platz{display:grid;place-items:center;min-height:240px;border:1px dashed #33445e;border-radius:8px;color:#8da0bb;padding:24px;text-align:center}</style></head>
    <body data-ms-breite="${m.breite}">${m.html}
    <script>(function(){var STEUERN=false;var ROOT=document.body.querySelector('main');
      function pfad(el){var p=[];while(el&&el!==ROOT&&el.parentElement){var par=el.parentElement;p.unshift([].indexOf.call(par.children,el));el=par;}return el===ROOT?p.join(','):'';}
      function sendeEin(o){parent.postMessage({__ms:1,eingabe:o},'*');}
      document.addEventListener('click',function(e){if(!STEUERN)return;e.preventDefault();sendeEin({art:'klick',pfad:pfad(e.target)});},true);
      document.addEventListener('scroll',function(){if(!STEUERN)return;parent.postMessage({__ms:1,scroll:{y:window.scrollY,x:window.scrollX}},'*');},true);
      document.addEventListener('input',function(e){if(!STEUERN)return;var t=e.target;if(t&&t.type!=='password')sendeEin({art:'eingeben',pfad:pfad(t),wert:t.value});},true);
      document.addEventListener('keydown',function(e){if(!STEUERN)return;if(e.key==='Enter')sendeEin({art:'taste',pfad:pfad(e.target),taste:'Enter'});},true);
      window.addEventListener('message',function(e){if(e.data&&e.data.__msSteuern!==undefined)STEUERN=!!e.data.__msSteuern;});
    })();<\/script></body></html>`;
  rahmen.srcdoc = doc;
  rahmen.onload = () => { try { rahmen.contentWindow.scrollTo(m.scrollX || 0, m.scrollY || 0); rahmen.contentWindow.postMessage({ __msSteuern: ichSteuere }, '*'); } catch { /* egal */ } };
}
function zeigerAnzeigen(x, y) {
  if (!zeigerEl || !rahmen) return;
  const b = rahmen.getBoundingClientRect();
  zeigerEl.hidden = false;
  zeigerEl.style.left = `${b.left + x}px`;
  zeigerEl.style.top = `${b.top + y}px`;
}

// Nachrichten aus dem Spiegel-iframe (Steuerung) an den Hub schicken.
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || !d.__ms || !ichSteuere) return;
  if (d.eingabe) sende({ t: 'eingabe', ...d.eingabe });
  else if (d.scroll) sende({ t: 'eingabe', art: 'scroll', x: d.scroll.x, y: d.scroll.y });
});
// =============================================================== Host: Fremdeingaben anwenden
function knotenFinden(pfad) {
  let el = document.querySelector('main');
  if (!el || !pfad) return null;
  for (const teil of pfad.split(',')) { const i = Number(teil); if (!el.children || i < 0 || i >= el.children.length) return null; el = el.children[i]; }
  return el;
}
function eingabeAnwenden(m) {
  if (!steuertMich) return;
  if (m.art === 'scroll') { window.scrollTo(m.x || 0, m.y || 0); return; }
  const el = knotenFinden(m.pfad);
  if (!el) return;
  if (m.art === 'klick') { el.focus?.(); el.click?.(); }
  else if (m.art === 'eingeben' && 'value' in el && !istGeheim(el)) { el.value = m.wert; el.dispatchEvent(new Event('input', { bubbles: true })); }
  else if (m.art === 'taste' && m.taste === 'Enter') { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })); }
}

// =============================================================== Host-Banner (wer sieht zu / steuert)
let hostBanner = null;
function hostBannerZeichnen() {
  const zuseher = [...beobachteMich.values()].map((x) => x.name);
  if (!zuseher.length && !steuertMich) { hostBanner?.remove(); hostBanner = null; return; }
  if (!hostBanner) { hostBanner = document.createElement('div'); hostBanner.id = 'ms-host-banner'; document.body.appendChild(hostBanner); }
  const text = steuertMich ? `${escapeHtml(steuertMich.name)} steuert deine Sitzung mit` : `${zuseher.map(escapeHtml).join(', ')} ${zuseher.length === 1 ? 'sieht' : 'sehen'} gerade zu`;
  hostBanner.className = steuertMich ? 'steuernd' : '';
  hostBanner.innerHTML = `<span class="ms-punkt" aria-hidden="true"></span><span>${text}</span>${steuertMich ? '<button type="button" data-ms="stopp">Steuerung entziehen</button>' : ''}<button type="button" data-ms="alle">Beenden</button>`;
  hostBanner.querySelector('[data-ms="stopp"]')?.addEventListener('click', () => sende({ t: 'steuern-stopp' }));
  hostBanner.querySelector('[data-ms="alle"]').onclick = () => { for (const id of beobachteMich.keys()) sende({ t: 'beenden', wer: id }); };
}

function aufraeumenAlles() {
  teilenStoppen(); overlaySchliessen(); hostBanner?.remove(); hostBanner = null;
  beobachteMich.clear(); steuertMich = null; ichBeobachte = null; ichSteuere = false;
}

// =============================================================== kleine Helfer (Dialog, Meldung, Stil)
function dialog(id, schliessbar = true) {
  document.querySelector(`#${id}`)?.remove();
  const el = document.createElement('div');
  el.id = id; el.className = 'ms-dialog';
  el.innerHTML = `<div class="ms-karte"><button type="button" class="ms-zu" aria-label="Schließen"${schliessbar ? '' : ' hidden'}>×</button><div class="dlg-inhalt"></div></div>`;
  document.body.appendChild(el);
  el.querySelector('.ms-zu').onclick = () => { el.remove(); if (id === 'mitschau-liste') listeOffen = false; };
  el.addEventListener('click', (e) => { if (e.target === el && schliessbar) { el.remove(); if (id === 'mitschau-liste') listeOffen = false; } });
  return el;
}
function meldung(text) {
  let el = document.querySelector('#ms-meldung');
  if (!el) { el = document.createElement('div'); el.id = 'ms-meldung'; document.body.appendChild(el); }
  el.textContent = text; el.classList.add('an');
  clearTimeout(meldung.t); meldung.t = setTimeout(() => el.classList.remove('an'), 4500);
}

function stileEinspielen() {
  if (document.querySelector('#ms-stil')) return;
  const s = document.createElement('style'); s.id = 'ms-stil';
  s.textContent = `
  #ms-host-banner{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:2147483600;display:flex;align-items:center;gap:10px;padding:8px 10px 8px 14px;border-radius:999px;background:#1e9e5a;color:#fff;font:600 13px/1.3 system-ui,sans-serif;box-shadow:0 8px 28px #0007}
  #ms-host-banner.steuernd{background:#d08a1a}
  #ms-host-banner .ms-punkt{width:9px;height:9px;border-radius:50%;background:#fff;animation:mspuls 1.4s infinite}
  #ms-host-banner button{border:1px solid #ffffff66;background:#ffffff22;color:#fff;border-radius:999px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer}
  @keyframes mspuls{0%,100%{opacity:1}50%{opacity:.35}}
  #ms-overlay{position:fixed;inset:0;z-index:2147483500;background:#05080f;display:flex;flex-direction:column}
  #ms-overlay .ms-kopf{display:flex;align-items:center;gap:14px;padding:10px 16px;background:#0e1727;border-bottom:1px solid #223650;color:#dbe6f7;font-size:14px;flex-wrap:wrap}
  #ms-overlay .ms-steuerstand{color:#9fb3d1;font-size:12px}
  #ms-overlay.steuernd .ms-kopf{background:#2c230f;border-color:#66501f}
  #ms-overlay .ms-kopf-knoepfe{margin-left:auto;display:flex;gap:8px}
  #ms-overlay .ms-buehne{position:relative;flex:1;overflow:hidden}
  #ms-overlay .ms-rahmen{width:100%;height:100%;border:0;background:#080d16}
  #ms-overlay .ms-zeiger{position:fixed;width:16px;height:16px;margin:-3px 0 0 -3px;border-radius:50%;background:#ffd34d99;border:2px solid #ffd34d;pointer-events:none;z-index:2147483550;transition:left .06s linear,top .06s linear}
  .ms-dialog{position:fixed;inset:0;z-index:2147483600;background:#04070d99;display:grid;place-items:center;padding:16px}
  .ms-karte{position:relative;width:100%;max-width:440px;background:#0e1727;border:1px solid #223650;border-radius:12px;padding:22px;color:#dbe6f7;box-shadow:0 30px 80px #0008}
  .ms-karte .ms-zu{position:absolute;top:10px;right:12px;border:0;background:none;color:#8da0bb;font-size:22px;line-height:1;cursor:pointer}
  .ms-karte p{margin:4px 0 16px;line-height:1.5}
  .dlg-knoepfe{display:flex;gap:10px;flex-wrap:wrap}
  .ms-sitzung{display:flex;align-items:center;gap:12px;justify-content:space-between;flex-wrap:wrap;border:1px solid #223047;border-radius:8px;padding:10px 12px;margin-bottom:8px;background:#0f1929}
  .ms-sitzung .ms-wer small{display:block;color:#8da0bb;font-size:12px;margin-top:3px}
  .ms-sitzung .ms-aktionen{display:flex;gap:8px;flex-wrap:wrap}
  #ms-meldung{position:fixed;left:50%;top:14px;transform:translate(-50%,-20px);z-index:2147483646;background:#132036;color:#dbe6f7;border:1px solid #2a3c57;border-radius:8px;padding:9px 14px;font:500 13px system-ui,sans-serif;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;max-width:90vw}
  #ms-meldung.an{opacity:1;transform:translate(-50%,0)}`;
  document.head.appendChild(s);
}
