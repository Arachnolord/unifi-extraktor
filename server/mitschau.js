// FAH-Extraktor · Urheber: Fabian Hammer
import { randomBytes } from 'node:crypto';

// Mitschau & Co-Browsing (internes Admin-Werkzeug). Der Server ist die Vermittlung zwischen den
// offenen Oberflächen-Sitzungen (je eine WebSocket-Verbindung). Grundsätze:
//  - Zusehen und Steuern starten IMMER erst nach ausdrücklicher Zustimmung der gastgebenden Seite.
//  - Während einer Mitschau sieht die gastgebende Seite durchgehend, wer zusieht/steuert.
//  - Der Gast (Host) schickt den Bild-Spiegel seiner Oberfläche; der Beobachter rendert ihn.
//  - Steuerung nur, solange der Host sie gewährt; Host und Beobachter können sie jederzeit beenden.
// Rollen: Admins sehen die Sitzungsliste und dürfen zusehen ANFRAGEN. Jeder darf jemanden in die
// eigene Sitzung EINLADEN. Niemand sieht ohne Zustimmung mit.

const verbindungen = new Map(); // verbId -> Eintrag
const offene = new Map();       // token -> { art, vonId, anId, modus, frist }
const ANFRAGE_FRIST = 60000;

function neueId() { return randomBytes(6).toString('hex'); }

// Ein kurzer, menschenlesbarer Steckbrief einer Sitzung (für die Admin-Liste).
function steckbrief(e) {
  const p = e.praesenz || {};
  return {
    id: e.id, name: e.user.name, rolle: e.user.rolle, selbst: false,
    integration: p.integration || null, backupName: p.backupName || null, ansicht: p.ansicht || null,
    vorschauAktiv: Boolean(p.vorschauAktiv), seit: e.seit,
    beobachterZahl: e.beobachtetVon.size, beobachtetGerade: Boolean(e.beobachtet), wirdGesteuert: Boolean(e.gesteuertVon),
  };
}

function sendeListe(e) {
  if (e.user.rolle !== 'admin') return;
  const liste = [...verbindungen.values()].filter((x) => x.id !== e.id).map(steckbrief);
  e.verb.sende({ t: 'liste', sitzungen: liste });
}

// Die Admin-Listen aller Admins auffrischen (nach jeder Zustandsänderung).
function listenAuffrischen() {
  for (const e of verbindungen.values()) if (e.user.rolle === 'admin') sendeListe(e);
}

const nameVon = (id) => verbindungen.get(id)?.user.name || 'jemand';

// Beendet eine laufende Mitschau (Host h, Beobachter b) und meldet es beiden.
function trenne(hostId, obsId, grund) {
  const h = verbindungen.get(hostId);
  const b = verbindungen.get(obsId);
  if (h) {
    h.beobachtetVon.delete(obsId);
    if (h.gesteuertVon === obsId) h.gesteuertVon = null;
    h.verb.sende({ t: 'mitschau-aus', wer: obsId, name: b?.user.name || 'jemand', grund });
    if (!h.beobachtetVon.size) h.verb.sende({ t: 'spiegel-stopp' });
  }
  if (b && b.beobachtet === hostId) {
    b.beobachtet = null; b.steuert = null;
    b.verb.sende({ t: 'zusehen-aus', host: hostId, name: h?.user.name || 'jemand', grund });
  }
  listenAuffrischen();
}

// Eine Verbindung komplett lösen (beim Trennen des Sockets).
function entferne(id) {
  const e = verbindungen.get(id);
  if (!e) return;
  for (const obsId of [...e.beobachtetVon]) trenne(id, obsId, 'Sitzung beendet');
  if (e.beobachtet) trenne(e.beobachtet, id, 'Sitzung beendet');
  for (const [token, a] of offene) if (a.vonId === id || a.anId === id) offene.delete(token);
  verbindungen.delete(id);
  listenAuffrischen();
}

// Eine Anfrage/Einladung an die Zielseite stellen.
function frageAn(vonId, anId, art, modus) {
  const von = verbindungen.get(vonId); const an = verbindungen.get(anId);
  if (!von || !an) return { fehler: 'Die andere Sitzung ist nicht mehr da.' };
  if (vonId === anId) return { fehler: 'Das ergibt mit der eigenen Sitzung keinen Sinn.' };
  const token = neueId();
  offene.set(token, { art, vonId, anId, modus, frist: Date.now() + ANFRAGE_FRIST });
  // art 'einladen': von teilt, an soll zusehen → Frage bei an: "von lädt dich ein, bei von zuzusehen".
  // art 'zusehen':  von will zusehen, an ist Gastgeber → Frage bei an: "von möchte dir zusehen".
  an.verb.sende({ t: 'anfrage', token, art, modus, von: { id: vonId, name: von.user.name, rolle: von.user.rolle } });
  setTimeout(() => { if (offene.delete(token)) von.verb.sende({ t: 'hinweis', text: `${an.user.name} hat nicht reagiert.` }); }, ANFRAGE_FRIST);
  return { ok: true };
}

// Nach Zustimmung: Beobachter b beginnt Host h zu spiegeln.
function starteMitschau(hostId, obsId, modus) {
  const h = verbindungen.get(hostId); const b = verbindungen.get(obsId);
  if (!h || !b) return;
  if (b.beobachtet && b.beobachtet !== hostId) trenne(b.beobachtet, obsId, 'andere Mitschau begonnen');
  h.beobachtetVon.add(obsId);
  b.beobachtet = hostId;
  h.verb.sende({ t: 'spiegel-start' }); // Host soll ab jetzt seinen Bild-Spiegel senden
  h.verb.sende({ t: 'mitschau-an', wer: obsId, name: b.user.name, modus });
  b.verb.sende({ t: 'zusehen-an', host: hostId, name: h.user.name, darfSteuernAnfragen: true });
  listenAuffrischen();
}

function behandle(e, text) {
  let m; try { m = JSON.parse(text); } catch { return; }
  if (!m || typeof m !== 'object') return;
  const ich = e.id;
  switch (m.t) {
    case 'praesenz': {
      e.praesenz = {
        integration: str(m.integration, 24), backupName: str(m.backupName, 120),
        ansicht: str(m.ansicht, 40), vorschauAktiv: Boolean(m.vorschauAktiv),
      };
      // Dem spiegelt-gerade-Beobachter reicht der Bild-Spiegel; die Liste nur den Admins.
      listenAuffrischen();
      break;
    }
    case 'liste': sendeListe(e); break;

    case 'einladen': { // ich teile, Ziel soll zusehen (jede Rolle darf das für die eigene Sitzung)
      const r = frageAn(ich, str(m.ziel, 16), 'einladen', m.modus === 'steuern' ? 'steuern' : 'zusehen');
      if (r.fehler) e.verb.sende({ t: 'hinweis', text: r.fehler });
      break;
    }
    case 'zusehen-anfrage': { // ich will zusehen; nur Admins dürfen das anfragen
      if (e.user.rolle !== 'admin') { e.verb.sende({ t: 'hinweis', text: 'Nur Administratoren dürfen Zusehen anfragen.' }); break; }
      const r = frageAn(ich, str(m.ziel, 16), 'zusehen', 'zusehen');
      if (r.fehler) e.verb.sende({ t: 'hinweis', text: r.fehler });
      break;
    }
    case 'antwort': { // Antwort auf eine Anfrage/Einladung an MICH
      const a = offene.get(m.token);
      if (!a || a.anId !== ich) break;
      offene.delete(m.token);
      const von = verbindungen.get(a.vonId);
      if (!m.ja) { von?.verb.sende({ t: 'hinweis', text: `${e.user.name} hat abgelehnt.` }); break; }
      // einladen: Gastgeber = ich (a.vonId lud mich ein, bei IHM zuzusehen) → Host a.vonId, Beobachter ich
      // zusehen:  Gastgeber = ich → Host ich, Beobachter a.vonId
      if (a.art === 'einladen') starteMitschau(a.vonId, ich, a.modus);
      else starteMitschau(ich, a.vonId, 'zusehen');
      break;
    }

    case 'steuern-anfrage': { // Beobachter bittet seinen Host um die Steuerung
      const hostId = e.beobachtet;
      const h = verbindungen.get(hostId);
      if (!h) { e.verb.sende({ t: 'hinweis', text: 'Du siehst gerade niemandem zu.' }); break; }
      const token = neueId();
      offene.set(token, { art: 'steuern', vonId: ich, anId: hostId, modus: 'steuern', frist: Date.now() + ANFRAGE_FRIST });
      h.verb.sende({ t: 'anfrage', token, art: 'steuern', modus: 'steuern', von: { id: ich, name: e.user.name, rolle: e.user.rolle } });
      setTimeout(() => { if (offene.delete(token)) e.verb.sende({ t: 'hinweis', text: `${h.user.name} hat nicht reagiert.` }); }, ANFRAGE_FRIST);
      break;
    }
    case 'steuern-antwort': { // Host beantwortet eine Steuerungsanfrage
      const a = offene.get(m.token);
      if (!a || a.anId !== ich || a.art !== 'steuern') break;
      offene.delete(m.token);
      const b = verbindungen.get(a.vonId);
      if (!b || b.beobachtet !== ich) break;
      if (!m.ja) { b.verb.sende({ t: 'hinweis', text: `${e.user.name} hat die Steuerung nicht freigegeben.` }); break; }
      e.gesteuertVon = a.vonId;
      b.steuert = ich;
      e.verb.sende({ t: 'steuern-an', wer: a.vonId, name: b.user.name });
      b.verb.sende({ t: 'steuern-du-an', host: ich, name: e.user.name });
      listenAuffrischen();
      break;
    }
    case 'steuern-stopp': { // Host entzieht die Steuerung, oder der Beobachter gibt sie zurück
      if (e.gesteuertVon) {
        const b = verbindungen.get(e.gesteuertVon);
        e.gesteuertVon = null;
        if (b) { b.steuert = null; b.verb.sende({ t: 'steuern-du-aus', name: e.user.name }); }
        e.verb.sende({ t: 'steuern-aus' });
      } else if (e.steuert) {
        const h = verbindungen.get(e.steuert);
        const hostName = h?.user.name || 'der Gastgeber';
        if (h) { h.gesteuertVon = null; h.verb.sende({ t: 'steuern-aus' }); }
        e.steuert = null;
        e.verb.sende({ t: 'steuern-du-aus', name: hostName });
      }
      listenAuffrischen();
      break;
    }

    case 'beenden': { // Mitschau von beiden Seiten beendbar
      if (e.beobachtet) trenne(e.beobachtet, ich, 'beendet');
      const ziel = str(m.wer, 16);
      if (ziel && e.beobachtetVon.has(ziel)) trenne(ich, ziel, 'vom Gastgeber beendet');
      break;
    }

    case 'spiegel': { // Host → alle seine Beobachter (Bild-Spiegel, bereits bereinigt)
      if (!e.beobachtetVon.size) break;
      const nachricht = { t: 'spiegel', ...reinSpiegel(m) };
      for (const obsId of e.beobachtetVon) verbindungen.get(obsId)?.verb.sende(nachricht);
      break;
    }
    case 'zeiger': { // Zeigerposition des Hosts an seine Beobachter
      if (!e.beobachtetVon.size) break;
      const n = { t: 'zeiger', x: zahl(m.x), y: zahl(m.y) };
      for (const obsId of e.beobachtetVon) verbindungen.get(obsId)?.verb.sende(n);
      break;
    }
    case 'eingabe': { // steuernder Beobachter → Host (nur bei aktiver Freigabe)
      const h = verbindungen.get(e.steuert);
      if (!h || h.gesteuertVon !== ich) break;
      h.verb.sende({ t: 'eingabe', ...reinEingabe(m) });
      break;
    }
    default: break;
  }
}

// --- Bereinigung der weitergereichten Daten (nur erwartete Felder, Größen begrenzt) -------------
const str = (w, max) => (typeof w === 'string' ? w.slice(0, max) : '');
const zahl = (w) => (Number.isFinite(w) ? Math.round(w) : 0);
function reinSpiegel(m) {
  return {
    html: typeof m.html === 'string' ? m.html.slice(0, 3 * 1024 * 1024) : '',
    titel: str(m.titel, 80), route: str(m.route, 40),
    breite: zahl(m.breite), hoehe: zahl(m.hoehe), scrollX: zahl(m.scrollX), scrollY: zahl(m.scrollY),
  };
}
function reinEingabe(m) {
  const art = ['klick', 'scroll', 'eingeben', 'taste'].includes(m.art) ? m.art : null;
  if (!art) return { art: 'none' };
  return { art, x: zahl(m.x), y: zahl(m.y), pfad: str(m.pfad, 400), wert: str(m.wert, 400), taste: str(m.taste, 20) };
}

// Vom Server aufgerufen, wenn eine neue Mitschau-WebSocket angenommen wurde.
export function verbinde(verb, user) {
  const id = neueId();
  const e = { id, verb, user, praesenz: null, seit: Date.now(), beobachtetVon: new Set(), beobachtet: null, gesteuertVon: null, steuert: null };
  verbindungen.set(id, e);
  verb.sende({ t: 'willkommen', id, rolle: user.rolle });
  verb.on('nachricht', (text) => { try { behandle(e, text); } catch (f) { console.error('[mitschau]', f.message); } });
  verb.on('zu', () => entferne(id));
  listenAuffrischen();
}

export const anzahl = () => verbindungen.size;
