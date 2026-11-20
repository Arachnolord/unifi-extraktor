// FAH-Extraktor · Urheber: Fabian Hammer
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

// Betreiber-Einstellungen außerhalb der Kontendatei: daten/einstellungen.json
// (mode 0600, atomar geschrieben). Heute nur der Standard-Zugang MikroTik, der
// im Virtualisieren-Dialog vorbelegt wird. Die Datei wird bei JEDER Anfrage
// gelesen, damit Änderungen von Hand ohne Neustart gelten - sie ist winzig.
const BENUTZER = /^[A-Za-z0-9._@-]{1,64}$/;
const STEUERZEICHEN = /[\x00-\x1f\x7f]/;

function fehler(text, status = 400) { return Object.assign(new Error(text), { status }); }

const leer = () => ({ version: 1, mikrotikZugang: { benutzer: '', passwort: '' } });

export function zugangPruefen(zugang) {
  const benutzer = String(zugang?.benutzer ?? '').trim();
  const passwort = String(zugang?.passwort ?? '');
  if (benutzer && !BENUTZER.test(benutzer)) throw fehler('Benutzername: 1–64 Zeichen aus Buchstaben, Ziffern und . _ @ - (kein + und kein Leerzeichen).');
  if (passwort.length > 128) throw fehler('Das Passwort ist zu lang (höchstens 128 Zeichen).');
  if (STEUERZEICHEN.test(passwort)) throw fehler('Das Passwort darf keine Steuerzeichen oder Zeilenumbrüche enthalten.');
  return { benutzer, passwort };
}

export async function einstellungenLaden(verzeichnis) {
  await mkdir(verzeichnis, { recursive: true });
  const datei = path.join(verzeichnis, 'einstellungen.json');
  let kette = Promise.resolve();

  async function roh() {
    try {
      const stand = JSON.parse(await readFile(datei, 'utf8'));
      return { ...leer(), ...stand, mikrotikZugang: { ...leer().mikrotikZugang, ...(stand.mikrotikZugang || {}) } };
    } catch (f) {
      if (f.code !== 'ENOENT') console.error(`[einstellungen] ${path.basename(datei)} nicht lesbar: ${f.message}`);
      return leer();
    }
  }

  async function lesen() {
    const stand = await roh();
    return {
      mikrotikZugang: {
        benutzer: String(stand.mikrotikZugang.benutzer || '').slice(0, 64),
        passwort: String(stand.mikrotikZugang.passwort || '').slice(0, 128)
      }
    };
  }

  // Schreibvorgänge nacheinander; erst Hilfsdatei, dann umbenennen.
  function setzen({ mikrotikZugang }) {
    const auftrag = kette.catch(() => {}).then(async () => {
      const stand = await roh();
      if (mikrotikZugang !== undefined) stand.mikrotikZugang = zugangPruefen(mikrotikZugang);
      const hilf = `${datei}.${process.pid}.neu`;
      await writeFile(hilf, JSON.stringify(stand, null, 2), { mode: 0o600 });
      await rename(hilf, datei);
      return lesen();
    });
    kette = auftrag;
    return auftrag;
  }

  return { lesen, setzen };
}
