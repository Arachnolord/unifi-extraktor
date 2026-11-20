// FAH-Extraktor · test/backup.test.mjs — Urheber: Fabian Hammer © 2026
// .unf öffnen: Site-Exporte verlieren den letzten angefangenen AES-Block (bis 15 Byte des ZIP-Endes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { serialize } from 'bson';
import { encryptUnf, openBackup } from '../src/backup.js';

const FEHLER = /kein gültiges ZIP-Archiv/;

function datenbank() {
  const teile = [
    serialize({ __cmd: 'select', collection: 'site' }),
    serialize({ _id: 'abc123', name: 'default', desc: 'Testsite' })
  ];
  const roh = new Uint8Array(teile.reduce((summe, teil) => summe + teil.length, 0));
  let pos = 0;
  for (const teil of teile) { roh.set(teil, pos); pos += teil.length; }
  return gzipSync(roh);
}

function zipMitFueller(fuellBytes) {
  return zipSync({
    'db.gz': [datenbank(), { level: 0 }],
    version: [strToU8('7.5.187'), { level: 0 }],
    fueller: [new Uint8Array(fuellBytes), { level: 0 }]
  });
}

function unf(name, bytes) {
  return { name, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer };
}

test('.unf: vollständiges Archiv öffnet wie bisher', async () => {
  const zip = zipMitFueller(0);
  const backup = await openBackup(unf('voll.unf', await encryptUnf(zip)));
  assert.equal(backup.sites[0].description, 'Testsite');
  assert.equal(strFromU8(backup.files.get('version')), '7.5.187');
});

test('.unf: fehlender letzter Block (1–15 Byte des ZIP-Endes) wird ergänzt', async () => {
  const gesehen = new Set();
  for (let fuell = 0; fuell < 32; fuell++) {
    const zip = zipMitFueller(fuell);
    const rest = zip.length % 16;
    if (rest === 0 || gesehen.has(rest)) continue;
    gesehen.add(rest);
    const voll = await encryptUnf(zip);
    const backup = await openBackup(unf(`rest-${rest}.unf`, voll.slice(0, zip.length - rest)));
    assert.equal(backup.sites[0].description, 'Testsite', `Rest ${rest}`);
    assert.equal(strFromU8(backup.files.get('version')), '7.5.187', `Rest ${rest}`);
    assert.equal(backup.files.get('fueller').length, fuell, `Rest ${rest}`);
  }
  assert.equal(gesehen.size, 15, 'alle 15 möglichen Reste geprüft');
});

test('.unf: Datei ohne ZIP-Inhalt bleibt ein Fehler', async () => {
  const bytes = await encryptUnf(new Uint8Array(4096).fill(7));
  await assert.rejects(openBackup(unf('muell.unf', bytes)), FEHLER);
});

test('.unf: beschädigtes Zentralverzeichnis wird nicht schöngerechnet', async () => {
  const zip = zipMitFueller(1);
  const rest = zip.length % 16;
  assert.notEqual(rest, 0);
  const kaputt = zip.slice();
  const ende = kaputt.length - 22;
  let start = ende - 1;
  while (!(kaputt[start] === 0x50 && kaputt[start + 1] === 0x4b && kaputt[start + 2] === 0x01 && kaputt[start + 3] === 0x02)) start--;
  // Länge des Dateinamens im letzten Eintrag verfälschen: Die Kette trifft das Endverzeichnis nicht mehr.
  kaputt[start + 28] += 1;
  const bytes = await encryptUnf(kaputt);
  await assert.rejects(openBackup(unf('kaputt.unf', bytes.slice(0, kaputt.length - rest))), FEHLER);
});
