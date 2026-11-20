// FAH-Extraktor · Urheber: Fabian Hammer
import { randomBytes } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { sha512crypt } from './sha512crypt.js';
import { md5crypt } from './md5crypt.js';
import { uebergabeUnf, UEBERGABE_OPTIONEN } from '../src/vorschau-paket.js';

// Kundenübergabe: Die Angaben kommen als Eintrag im hochgeladenen Paket, nie in einem
// Kopf (Köpfe landen im Protokoll des Proxys). Das Admin-Passwort wird nur gehasht. Der
// Controller legt das Geräte-SSH-Passwort im Klartext ab, deshalb ist es ein eigener Zufallswert.
const fehler400 = (text) => Object.assign(new Error(text), { status: 400 });

export function optionenPruefen(roh) {
  let o;
  try { o = JSON.parse(String(roh ?? '')); } catch { throw fehler400('Die Angaben zur Übergabe sind unvollständig.'); }
  const benutzer = String(o?.benutzer ?? '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/.test(benutzer) || benutzer.toLowerCase() === 'root') {
    throw fehler400('Benutzername: 3–32 Zeichen aus Buchstaben, Ziffern, Punkt, Binde- oder Unterstrich, nicht „root“.');
  }
  const passwort = String(o?.passwort ?? '');
  if (!/^[\x21-\x7E]{10,64}$/.test(passwort) || !/[a-z]/.test(passwort) || !/[A-Z]/.test(passwort) || !/\d/.test(passwort)) {
    throw fehler400('Passwort: 10–64 Zeichen mit Groß- und Kleinbuchstaben und Ziffer, ohne Leerzeichen und Umlaute.');
  }
  const email = String(o?.email ?? '').trim();
  if (email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw fehler400('Die E-Mail-Adresse ist nicht gültig.');
  return { benutzer, passwort, email };
}

export async function uebergabeDatei(zip) {
  let dateien;
  try { dateien = unzipSync(zip); } catch { throw fehler400('Das hochgeladene Paket ist kein gültiges ZIP.'); }
  const roh = dateien[UEBERGABE_OPTIONEN];
  delete dateien[UEBERGABE_OPTIONEN];
  const { benutzer, passwort, email } = optionenPruefen(roh ? strFromU8(roh) : '');
  const geraetePasswort = randomBytes(18).toString('base64url');
  return uebergabeUnf(dateien, {
    benutzer, email: email || `${benutzer}@kunde.invalid`, shadow: sha512crypt(passwort),
    geraeteLogin: { benutzer, passwort: geraetePasswort, sha512: sha512crypt(geraetePasswort), md5: md5crypt(geraetePasswort) }
  });
}
