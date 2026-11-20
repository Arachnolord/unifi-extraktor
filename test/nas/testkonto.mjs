// © 2026 Fabian Hammer – FAH-Extraktor. Admin-Testkonto DIREKT in daten/benutzer.json anlegen oder
// entfernen, damit die NAS-Tests (mikrotik.mjs, klick-mikrotik.mjs, parallel.mjs) ohne das
// Betreiber-Passwort von „fabian“ laufen. Nutzt die Kontofunktionen aus server/konten.js
// (scrypt$N$salz$hash, atomares Schreiben) – es landet kein Klartext in der Datei.
//
//   node testkonto.mjs anlegen    legt TESTKONTO_NAME (Standard fah-testadmin) als Administrator an;
//                                 Passwort = TESTKONTO_PW, sonst zufällig – wird EINMAL ausgegeben.
//   node testkonto.mjs entfernen  entfernt dieses Konto und liegengebliebene mt-test*/mt-klick*-Konten.
//
// WICHTIG: Das Backend hält benutzer.json im Speicher und schreibt bei jeder Änderung die ganze Datei
// neu. Ein direkter Eingriff gilt deshalb nur, wenn das Backend dabei GESTOPPT ist oder danach NEU
// STARTET. Beides beendet ALLE laufenden Vorschauen (UniFi und MikroTik) – also vorher prüfen, dass
// keine echte Vorschau läuft (docker ps | grep unifi-vorschau).
//
// Weg A – Backend gestoppt, Skript im API-Image (empfohlen, DATEN = /data):
//   cd /volume3/docker/unifi-extraktor
//   docker compose stop unifi-backup-explorer-api
//   docker run --rm -v "$PWD/daten:/data" -v /tmp/fahtest:/t:ro unifi-extraktor-unifi-backup-explorer-api node /t/testkonto.mjs anlegen
//   docker compose start unifi-backup-explorer-api
// Weg B – im laufenden Container, danach Neustart:
//   docker exec unifi-backup-explorer-api mkdir -p /tmp/fahtest
//   docker cp /tmp/fahtest/testkonto.mjs unifi-backup-explorer-api:/tmp/fahtest/
//   docker exec -w /app unifi-backup-explorer-api node /tmp/fahtest/testkonto.mjs anlegen && docker restart unifi-backup-explorer-api
// Hinweis: test/nas liegt nicht in der Release-ZIP (export-ignore) – die Datei vom Mac nach /tmp/fahtest
// auf dem NAS kopieren (siehe test/nas/README.md).
import { randomBytes } from 'node:crypto';
import { kontenLaden } from '/app/server/konten.js';

const modus = process.argv[2];
const DATEN = process.env.DATEN || '/data';
const NAME = process.env.TESTKONTO_NAME || 'fah-testadmin';
const RESTE = /^(mt-test|mt-klick)\d+$/;
if (!['anlegen', 'entfernen'].includes(modus)) { console.error('Aufruf: node testkonto.mjs anlegen|entfernen'); process.exit(2); }

const konten = await kontenLaden(DATEN);
const liste = konten.liste();
const gleich = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

if (modus === 'anlegen') {
  const passwort = process.env.TESTKONTO_PW || randomBytes(12).toString('base64url');
  if (passwort.length < 8) { console.error('FEHL TESTKONTO_PW braucht mindestens 8 Zeichen.'); process.exit(2); }
  const vorhanden = liste.find((b) => gleich(b.name, NAME));
  try {
    if (vorhanden) await konten.bearbeiten(vorhanden.id, { rolle: 'admin', passwort });
    else await konten.anlegen({ name: NAME, passwort, rolle: 'admin' });
  } catch (f) { console.error(`FEHL ${f.message}`); process.exit(1); }
  await konten.fertig();
  console.log(`OK   Admin-Testkonto ${NAME} ${vorhanden ? 'aktualisiert' : 'angelegt'} in ${DATEN}/benutzer.json`);
  console.log(`     Für die Tests: ADMIN_NAME=${NAME} ADMIN_PW=${passwort}`);
  console.log('     Gilt erst nach dem (Neu-)Start des Backends – das beendet laufende Vorschauen.');
}

if (modus === 'entfernen') {
  const weg = liste.filter((b) => gleich(b.name, NAME) || RESTE.test(b.name));
  for (const b of weg) {
    try { await konten.loeschen(b.id, null); console.log(`OK   ${b.name} entfernt`); }
    catch (f) { console.log(`FEHL ${b.name}: ${f.message}`); process.exitCode = 1; }
  }
  if (!weg.length) console.log('OK   nichts zu entfernen');
  await konten.fertig();
}
