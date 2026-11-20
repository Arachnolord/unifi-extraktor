import { randomBytes } from 'node:crypto';
import * as docker from './docker.js';
import * as unifi from './arten/unifi.js';
import * as mikrotik from './arten/mikrotik.js';
import * as omada from './arten/omada.js';

// Lebenszyklus der virtuellen Vorschauen, unabhängig von der Art (UniFi-Controller
// oder MikroTik-CHR): Jedes Konto hat höchstens eine Vorschau (eine neue ersetzt
// die eigene alte), insgesamt laufen höchstens VORSCHAU_MAX gleichzeitig - beide
// Arten zusammen. Jede Vorschau bekommt eigene Container im abgeschotteten Netz;
// welche Vorschau eine Anfrage bekommt, entscheidet die Anmeldung im Explorer.
// Den eigentlichen Ablauf kennt die Art (server/arten/*.js).
export const ARTEN = { unifi, mikrotik, omada };
const KURZ = { unifi: 'app', mikrotik: 'chr', omada: 'omada' };
const NETZ = process.env.VORSCHAU_NETZ || 'unifi-vorschau';
const PRAEFIX = process.env.VORSCHAU_PRAEFIX || 'unifi-vorschau';
const LEERLAUF_MIN = Number(process.env.VORSCHAU_LEERLAUF_MIN || 30);
const HOECHSTDAUER_STD = Number(process.env.VORSCHAU_HOECHSTDAUER_STD || 8);
export const MAX = Math.max(1, Number(process.env.VORSCHAU_MAX) || 6);

const laeufe = new Map(); // Konto-ID -> Lauf
const zuletzt = new Map(); // Konto-ID -> { name, art, grund, zeit }
let kette = Promise.resolve();

// Start, Ende und Netzaufbau nacheinander abarbeiten, damit sich schnelle Klicks
// und gleichzeitige Starts mehrerer Konten nicht in die Quere kommen.
function exklusiv(aufgabe) {
  const ergebnis = kette.then(aufgabe, aufgabe);
  kette = ergebnis.catch(() => {});
  return ergebnis;
}

// Fehlgeschlagene Läufe haben keine Container mehr und belegen keinen Platz.
const belegt = (l) => l.phase !== 'fehler';

// Die eigene Vorschau wird beim Start ersetzt, fremde laufende zählen gegen die Obergrenze.
export function grenzeErreicht(alle, kontoId, max = MAX) {
  return alle.filter((l) => l.kontoId !== kontoId && belegt(l)).length >= max;
}

export const artVon = (l) => ARTEN[l?.art] || null;

const kurz = ({ id, art, name, gestartetVon, phase, gestartet, letzteAktivitaet, offeneSockets }) =>
  ({ id, art, name, gestartetVon, phase, gestartet, letzteAktivitaet, offeneSockets });

export function status(konto) {
  const lauf = laeufe.get(konto.id);
  const gemeinsam = {
    max: MAX, andere: [...laeufe.values()].filter((l) => l !== lauf && belegt(l)).map(kurz),
    leerlaufMin: LEERLAUF_MIN, hoechstdauerStd: HOECHSTDAUER_STD, jetzt: Date.now()
  };
  if (!lauf) return { aktiv: false, zuletzt: zuletzt.get(konto.id) || null, ...gemeinsam };
  const A = artVon(lauf);
  const { id, art, name, gestartetVon, phase, schritte, fehler, gestartet, bereitSeit, offeneSockets } = lauf;
  return {
    aktiv: true, id, art, name, gestartetVon, phase, schritte, fehler, gestartet, bereitSeit, offeneSockets,
    ...A.statusExtra(lauf), zugang: phase === 'bereit' ? A.zugang(lauf) : null, ...gemeinsam
  };
}

export const laufVon = (kontoId) => laeufe.get(kontoId) || null;
export const laufMitId = (id) => [...laeufe.values()].find((l) => l.id === id) || null;
export const bereit = (l) => l?.phase === 'bereit';
export function aktivitaet(l) { l.letzteAktivitaet = Date.now(); }
// Offene WebSockets = Oberfläche ist in einem Tab offen; gezählt je Lauf, damit
// Verbindungen einer ersetzten Vorschau den neuen Lauf nicht verfälschen.
export function socketAuf(l) {
  l.offeneSockets++;
  l.letzteAktivitaet = Date.now();
  return l;
}
export function socketZu(l) {
  if (!l) return;
  l.offeneSockets = Math.max(0, l.offeneSockets - 1);
  l.letzteAktivitaet = Date.now();
}

// Abgeschottetes Netz anlegen/prüfen (serialisiert); liefert den Netznamen.
export const netzSicherstellen = () => exklusiv(() => docker.vorschauNetz(NETZ)).then(() => NETZ);
const kern = { netz: netzSicherstellen };

// eingabe: rohe Datei (UniFi: ZIP des Network-Teils, MikroTik: .backup/.rsc);
// optionen: geprüfte Optionen der Art (MikroTik: optionenPruefen).
export function starte(art, eingabe, name, konto, optionen = {}) {
  const A = ARTEN[art];
  if (!A) throw Object.assign(new Error('Unbekannte Vorschau-Art.'), { status: 400 });
  return exklusiv(async () => {
    const fremde = [...laeufe.values()].filter((l) => l.kontoId !== konto.id && belegt(l));
    if (grenzeErreicht(fremde, konto.id)) {
      const liste = fremde.map((l) => `„${l.name}“ (${l.gestartetVon})`).join(', ');
      throw Object.assign(new Error(`Es laufen schon ${MAX} virtuelle Vorschauen: ${liste}. Sobald eine endet, kannst du deine starten.`), { status: 409 });
    }
    // Arten mit eigenem Deckel (Omada braucht viel Speicher): fremde Läufe derselben Art zählen.
    const gleicheArt = fremde.filter((l) => l.art === art);
    if (A.MAX_GLEICHZEITIG && gleicheArt.length >= A.MAX_GLEICHZEITIG) {
      throw Object.assign(new Error(`Es laufen schon ${gleicheArt.length} ${art === 'omada' ? 'Omada-' : ''}Vorschauen (${gleicheArt.map((l) => l.gestartetVon).join(', ')}) – mehr gleichzeitig lässt der Speicher des NAS nicht zu.`), { status: 409 });
    }
    await beendeIntern(konto.id, 'durch eine neue Vorschau ersetzt');
    const id = randomBytes(6).toString('hex');
    const neu = {
      id, art, kontoId: konto.id, name, gestartetVon: konto.name, phase: 'vorbereiten', fehler: null,
      app: `${PRAEFIX}-${KURZ[art] || art}-${id}`, db: art === 'unifi' ? `${PRAEFIX}-db-${id}` : null,
      schritte: A.SCHRITTE.map(([key, text]) => ({ key, text, status: 'offen', detail: '' })),
      gestartet: Date.now(), letzteAktivitaet: Date.now(), offeneSockets: 0,
      passwort: randomBytes(18).toString('base64url'), abgebrochen: false
    };
    neu.ziel = A.zielFuer(neu);
    laeufe.set(konto.id, neu);
    A.ablauf(neu, eingabe, optionen, kern).then(() => bereitMelden(neu), (fehler) => scheitern(neu, fehler));
    return status(konto);
  });
}

// Mit "laufId" nur genau diesen Lauf beenden (nicht einen inzwischen neu gestarteten).
export const beende = (kontoId, grund = 'beendet', laufId) => exklusiv(() => beendeIntern(kontoId, grund, laufId));

async function beendeIntern(kontoId, grund, laufId) {
  const l = laeufe.get(kontoId);
  if (!l || (laufId && l.id !== laufId)) return;
  l.abgebrochen = true;
  laeufe.delete(kontoId);
  zuletzt.set(kontoId, { name: l.name, art: l.art, grund, zeit: Date.now() });
  await laufAufraeumen(l);
}

const laufAufraeumen = async (l) => {
  for (const container of await docker.eigeneContainer(l.id)) await docker.containerEntfernen(container.Id);
};

// Beim Start des Backends: Reste aller früheren Vorschauen entfernen (beide Arten tragen das Label).
export async function aufraeumen() {
  for (const container of await docker.eigeneContainer()) await docker.containerEntfernen(container.Id);
}

// Ziel für "Vorschau öffnen": { location, cookie? } oder null, wenn nichts bereit ist.
// optionen.eigenesKonto: ohne automatische Anmeldung (Anmeldeseite der Oberfläche, eigene Zugangsdaten).
export async function oeffnenZiel(l, optionen = {}) {
  if (!bereit(l)) return null;
  return artVon(l).oeffnenZiel(l, optionen);
}

function bereitMelden(l) {
  if (l.abgebrochen || laeufe.get(l.kontoId) !== l) return;
  l.phase = 'bereit';
  l.bereitSeit = Date.now();
  l.letzteAktivitaet = Date.now();
}

async function scheitern(l, fehler) {
  // Abgebrochen: Container, die nach dem Aufräumen noch entstanden sind, mitnehmen.
  if (fehler.abgebrochen || l.abgebrochen) return laufAufraeumen(l).catch(() => {});
  const log = await docker.containerLogs(fehler.container || l.app, 80).catch(() => '');
  const laufend = l.schritte.find((s) => s.status === 'laeuft');
  if (laufend) laufend.status = 'fehler';
  l.fehler = { text: fehler.message, log: artVon(l).logAuszug(log) };
  l.phase = 'fehler';
  console.error(`[vorschau] ${l.app} fehlgeschlagen: ${fehler.message}`);
  await laufAufraeumen(l).catch(() => {});
}

// Wächter: Leerlauf, Höchstdauer und unerwartet beendete Vorschauen - je Lauf.
export function waechter() {
  setInterval(async () => {
    for (const l of [...laeufe.values()]) {
      if (l.phase !== 'bereit') continue;
      const jetzt = Date.now();
      if (l.offeneSockets === 0 && jetzt - l.letzteAktivitaet > LEERLAUF_MIN * 60000) {
        await beende(l.kontoId, `nach ${LEERLAUF_MIN} Minuten ohne Nutzung automatisch beendet`, l.id);
      } else if (jetzt - l.gestartet > HOECHSTDAUER_STD * 3600e3) {
        await beende(l.kontoId, `nach ${HOECHSTDAUER_STD} Stunden automatisch beendet`, l.id);
      } else {
        const info = await docker.containerInfo(l.app).catch(() => null);
        if (laeufe.get(l.kontoId) === l && !l.abgebrochen && !info?.State?.Running) {
          const A = artVon(l);
          l.phase = 'fehler';
          l.fehler = { text: `${A.bezeichnung} wurde unerwartet beendet.`, log: A.logAuszug(await docker.containerLogs(l.app, 80).catch(() => '')) };
          await laufAufraeumen(l).catch(() => {});
        }
      }
    }
  }, 60000).unref();
}
