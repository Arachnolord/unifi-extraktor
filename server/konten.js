import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

// Benutzerkonten und Sitzungen des Explorers. Beides liegt als JSON im
// Datenordner (Docker: ./daten -> /data) und übersteht Updates. Passwörter nur
// als scrypt-Hash, Sitzungen nur als SHA-256 des Cookie-Werts.
export const COOKIE = 'fah_explorer';
const N_STANDARD = 32768;
const SITZUNG_TAGE = 30;
const FEHLVERSUCHE = 10;
const SPERRE_MIN = 15;
const NAME = /^[\p{L}\p{N}._@-]{2,40}$/u;

function fehler(text, status) { return Object.assign(new Error(text), { status }); }

function scryptAsync(passwort, salz, n, laenge) {
  return new Promise((resolve, reject) => scrypt(passwort, salz, laenge, { N: n, r: 8, p: 1, maxmem: 128 * 1024 * 1024 },
    (f, schluessel) => (f ? reject(f) : resolve(schluessel))));
}

export async function passwortHash(passwort, n = N_STANDARD) {
  const salz = randomBytes(16);
  const hash = await scryptAsync(String(passwort).normalize('NFC'), salz, n, 32);
  return `scrypt$${n}$${salz.toString('base64')}$${hash.toString('base64')}`;
}

export async function passwortPruefen(passwort, gespeichert) {
  const [art, n, salz, hash] = String(gespeichert || '').split('$');
  if (art !== 'scrypt' || !salz || !hash) return false;
  const soll = Buffer.from(hash, 'base64');
  const ist = await scryptAsync(String(passwort).normalize('NFC'), Buffer.from(salz, 'base64'), Number(n), soll.length);
  return timingSafeEqual(ist, soll);
}

const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex');
const vergleichsName = (name) => String(name).trim().toLocaleLowerCase('de');

function pruefeName(name) {
  const sauber = String(name ?? '').trim();
  if (!NAME.test(sauber)) throw fehler('Der Benutzername braucht 2–40 Zeichen: Buchstaben, Ziffern sowie . _ @ -', 400);
  return sauber;
}

function pruefePasswort(passwort) {
  if (typeof passwort !== 'string' || passwort.length < 8) throw fehler('Das Passwort braucht mindestens 8 Zeichen.', 400);
  if (passwort.length > 200) throw fehler('Das Passwort ist zu lang (höchstens 200 Zeichen).', 400);
  return passwort;
}

function oeffentlich(b) {
  const { id, name, rolle, standardPasswort, angelegt, herkunft, letzteAnmeldung } = b;
  return { id, name, rolle, standardPasswort: Boolean(standardPasswort), angelegt, herkunft, letzteAnmeldung: letzteAnmeldung || null };
}

async function jsonLesen(datei, ersatz) {
  try { return JSON.parse(await readFile(datei, 'utf8')); } catch (f) {
    if (f.code === 'ENOENT') return ersatz;
    throw fehler(`${path.basename(datei)} ist beschädigt: ${f.message}`, 500);
  }
}

// Atomar schreiben (erst Hilfsdatei, dann umbenennen), damit ein Absturz nie eine
// halbe Kontendatei hinterlässt.
async function jsonSchreiben(datei, daten) {
  const hilf = `${datei}.${process.pid}.neu`;
  await writeFile(hilf, JSON.stringify(daten, null, 2), { mode: 0o600 });
  await rename(hilf, datei);
}

export async function kontenLaden(verzeichnis, { n = N_STANDARD, jetzt = () => Date.now() } = {}) {
  await mkdir(verzeichnis, { recursive: true });
  const kontenDatei = path.join(verzeichnis, 'benutzer.json');
  const sitzungenDatei = path.join(verzeichnis, 'sitzungen.json');
  const stand = await jsonLesen(kontenDatei, null) || { version: 1, registrierung: false, benutzer: [] };
  const sitzungen = new Map(Object.entries(await jsonLesen(sitzungenDatei, {})));
  const versuche = new Map();
  let kette = Promise.resolve();
  let sitzungenTimer = null;
  let attrappe = null;

  // Schreibvorgänge nacheinander, damit sich zwei Änderungen nicht überholen; ein
  // gescheiterter Vorgang hält die folgenden nicht auf.
  function schreiben(datei, daten) {
    const auftrag = kette.catch(() => {}).then(() => jsonSchreiben(datei, daten()));
    kette = auftrag;
    return auftrag;
  }
  const speichern = () => schreiben(kontenDatei, () => stand);
  const sitzungenSpeichern = () => schreiben(sitzungenDatei, () => Object.fromEntries(sitzungen));
  function sitzungenBald() {
    if (sitzungenTimer) return;
    sitzungenTimer = setTimeout(() => { sitzungenTimer = null; sitzungenSpeichern().catch((f) => console.error('[konten]', f.message)); }, 1000);
    sitzungenTimer.unref?.();
  }

  const finde = (id) => stand.benutzer.find((b) => b.id === id);
  const findeName = (name) => stand.benutzer.find((b) => vergleichsName(b.name) === vergleichsName(name));
  const admins = () => stand.benutzer.filter((b) => b.rolle === 'admin');
  function nameFrei(name, ausser) {
    const vorhanden = findeName(name);
    if (vorhanden && vorhanden.id !== ausser) throw fehler(`Den Benutzernamen „${name}“ gibt es schon.`, 409);
  }

  async function neuesKonto({ name, passwort, rolle, herkunft, standardPasswort = false }) {
    const konto = {
      id: randomBytes(8).toString('hex'), name, rolle: rolle === 'admin' ? 'admin' : 'benutzer',
      hash: await passwortHash(passwort, n), standardPasswort, angelegt: jetzt(), herkunft, letzteAnmeldung: null
    };
    stand.benutzer.push(konto);
    return konto;
  }

  function sitzungAnlegen(konto) {
    const token = randomBytes(32).toString('base64url');
    sitzungen.set(sha256(token), { benutzer: konto.id, angelegt: jetzt(), zuletzt: jetzt() });
    sitzungenBald();
    return token;
  }

  function sitzungenBeenden(kontoId, ausserToken) {
    const behalten = ausserToken ? sha256(ausserToken) : null;
    for (const [schluessel, s] of sitzungen) if (s.benutzer === kontoId && schluessel !== behalten) sitzungen.delete(schluessel);
    sitzungenBald();
  }

  // Bremse gegen Durchprobieren: je Absender und je Benutzername höchstens
  // FEHLVERSUCHE Fehlversuche in SPERRE_MIN Minuten.
  function sperreCheck(schluessel) {
    for (const k of schluessel) {
      const v = versuche.get(k);
      if (v && jetzt() - v.start < SPERRE_MIN * 60000 && v.anzahl >= FEHLVERSUCHE) {
        const minuten = Math.ceil((v.start + SPERRE_MIN * 60000 - jetzt()) / 60000);
        throw fehler(`Zu viele Fehlversuche. Bitte in ${minuten} ${minuten === 1 ? 'Minute' : 'Minuten'} erneut versuchen.`, 429);
      }
    }
  }
  function fehlversuch(schluessel) {
    for (const k of schluessel) {
      const v = versuche.get(k);
      if (!v || jetzt() - v.start >= SPERRE_MIN * 60000) versuche.set(k, { anzahl: 1, start: jetzt() });
      else v.anzahl++;
    }
  }

  // Erststart: admin / admin (der Hinweis in der App bleibt, bis es geändert ist).
  if (!stand.benutzer.length) {
    await neuesKonto({ name: 'admin', passwort: 'admin', rolle: 'admin', herkunft: 'start', standardPasswort: true });
    await speichern();
  }
  // Abgelaufene Sitzungen und solche gelöschter Konten wegräumen.
  for (const [schluessel, s] of sitzungen) {
    if (!finde(s.benutzer) || jetzt() - s.zuletzt > SITZUNG_TAGE * 86400e3) sitzungen.delete(schluessel);
  }

  return {
    einstellungen: () => ({ registrierung: Boolean(stand.registrierung) }),

    async einstellungenSetzen({ registrierung }) {
      stand.registrierung = Boolean(registrierung);
      await speichern();
      return { registrierung: stand.registrierung };
    },

    async anmelden(name, passwort, absender = '') {
      const schluessel = [`absender:${absender}`, `name:${vergleichsName(name ?? '')}`];
      sperreCheck(schluessel);
      const konto = findeName(name ?? '');
      // Auch für unbekannte Namen rechnen, damit die Antwortzeit nichts verrät.
      attrappe ||= await passwortHash(randomBytes(12).toString('hex'), n);
      const passt = await passwortPruefen(String(passwort ?? ''), konto ? konto.hash : attrappe);
      if (!konto || !passt) { fehlversuch(schluessel); throw fehler('Benutzername oder Passwort stimmt nicht.', 401); }
      for (const k of schluessel) versuche.delete(k);
      konto.letzteAnmeldung = jetzt();
      await speichern();
      return { benutzer: oeffentlich(konto), token: sitzungAnlegen(konto) };
    },

    async registrieren(name, passwort) {
      if (!stand.registrierung) throw fehler('Die Registrierung ist ausgeschaltet. Ein Administrator kann dir ein Konto anlegen.', 403);
      const sauber = pruefeName(name);
      nameFrei(sauber);
      const konto = await neuesKonto({ name: sauber, passwort: pruefePasswort(passwort), rolle: 'benutzer', herkunft: 'registrierung' });
      konto.letzteAnmeldung = jetzt();
      await speichern();
      return { benutzer: oeffentlich(konto), token: sitzungAnlegen(konto) };
    },

    // Prüft das Cookie. Die Sitzung gilt SITZUNG_TAGE ab der letzten Nutzung; die
    // Nutzungszeit wird höchstens stündlich gespeichert.
    sitzung(token) {
      if (!token) return null;
      const schluessel = sha256(token);
      const s = sitzungen.get(schluessel);
      if (!s) return null;
      const konto = finde(s.benutzer);
      if (!konto || jetzt() - s.zuletzt > SITZUNG_TAGE * 86400e3) { sitzungen.delete(schluessel); sitzungenBald(); return null; }
      if (jetzt() - s.zuletzt > 3600e3) { s.zuletzt = jetzt(); sitzungenBald(); }
      return { benutzer: oeffentlich(konto), token };
    },

    abmelden(token) {
      if (token && sitzungen.delete(sha256(token))) sitzungenBald();
    },

    // Eigenes Konto: Name und/oder Passwort, immer mit dem aktuellen Passwort.
    async kontoAendern(id, { name, passwortAlt, passwortNeu }, token) {
      const konto = finde(id);
      if (!konto) throw fehler('Das Konto gibt es nicht mehr.', 404);
      if (!await passwortPruefen(String(passwortAlt ?? ''), konto.hash)) throw fehler('Das aktuelle Passwort stimmt nicht.', 403);
      const neuerName = name !== undefined && name !== konto.name ? pruefeName(name) : null;
      if (neuerName) nameFrei(neuerName, konto.id);
      if (passwortNeu) {
        konto.hash = await passwortHash(pruefePasswort(passwortNeu), n);
        konto.standardPasswort = false;
        sitzungenBeenden(konto.id, token);
      }
      if (neuerName) konto.name = neuerName;
      await speichern();
      return oeffentlich(konto);
    },

    liste: () => stand.benutzer.map(oeffentlich),

    async anlegen({ name, passwort, rolle }) {
      const sauber = pruefeName(name);
      nameFrei(sauber);
      const konto = await neuesKonto({ name: sauber, passwort: pruefePasswort(passwort), rolle, herkunft: 'verwaltung' });
      await speichern();
      return oeffentlich(konto);
    },

    // Verwaltung: Name, Rolle, neues Passwort. Der letzte Administrator bleibt
    // Administrator; ändert ein Admin sich selbst, bleibt seine Sitzung (ausserToken).
    async bearbeiten(id, { name, rolle, passwort }, ausserToken) {
      const konto = finde(id);
      if (!konto) throw fehler('Das Konto gibt es nicht mehr.', 404);
      const neuerName = name !== undefined && name !== konto.name ? pruefeName(name) : null;
      if (neuerName) nameFrei(neuerName, konto.id);
      const neueRolle = rolle === undefined ? konto.rolle : rolle === 'admin' ? 'admin' : 'benutzer';
      if (konto.rolle === 'admin' && neueRolle !== 'admin' && admins().length === 1) {
        throw fehler('Das ist der letzte Administrator – ernenne zuerst ein anderes Konto zum Administrator.', 409);
      }
      if (passwort) {
        konto.hash = await passwortHash(pruefePasswort(passwort), n);
        konto.standardPasswort = false;
        sitzungenBeenden(konto.id, ausserToken);
      }
      if (neuerName) konto.name = neuerName;
      konto.rolle = neueRolle;
      await speichern();
      return oeffentlich(konto);
    },

    async loeschen(id, ausfuehrender) {
      const konto = finde(id);
      if (!konto) throw fehler('Das Konto gibt es nicht mehr.', 404);
      if (konto.id === ausfuehrender) throw fehler('Das eigene Konto kann nicht gelöscht werden.', 409);
      if (konto.rolle === 'admin' && admins().length === 1) throw fehler('Der letzte Administrator kann nicht gelöscht werden.', 409);
      stand.benutzer = stand.benutzer.filter((b) => b.id !== id);
      sitzungenBeenden(id);
      await speichern();
    },

    // Notfall (manage.sh admin-reset): "admin" / "admin" wieder als Administrator.
    async adminZuruecksetzen() {
      let konto = findeName('admin');
      if (konto) {
        konto.hash = await passwortHash('admin', n);
        konto.rolle = 'admin';
        konto.standardPasswort = true;
        sitzungenBeenden(konto.id);
      } else konto = await neuesKonto({ name: 'admin', passwort: 'admin', rolle: 'admin', herkunft: 'start', standardPasswort: true });
      await speichern();
      await sitzungenSpeichern();
      return oeffentlich(konto);
    },

    // Für Tests und das Herunterfahren: ausstehende Schreibvorgänge abwarten.
    async fertig() {
      if (sitzungenTimer) { clearTimeout(sitzungenTimer); sitzungenTimer = null; await sitzungenSpeichern(); }
      await kette;
    }
  };
}
