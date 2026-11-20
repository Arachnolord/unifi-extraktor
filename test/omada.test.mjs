// FAH-Extraktor · test/omada.test.mjs — Urheber: Fabian Hammer © 2026
// Omada-Leser mit einem im Test verschlüsselten Backup (RC4 + gzip, ein v2#-Wert per AES-128-CBC).
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { pbkdf2Sync, createCipheriv } from 'node:crypto';
import { omadaAusBytes, rc4, rc4Schluessel } from '../src/omada.js';
import { sucheAlles, spaltenFuer, wichtigstes, indexVon } from '../src/ansicht.js';

const KSI = 'a'.repeat(32) + '00112233445566778899aabbccddeeff' + 'ffeeddccbbaa99887766554433221100';
function v2(klar) {
  const schluessel = pbkdf2Sync(Buffer.from('v0hGiXNmbzJdhMvx8BRMrg==' + KSI.slice(0, 32)), Buffer.from(KSI.slice(32, 64), 'hex'), 1000, 16, 'sha256');
  const c = createCipheriv('aes-128-cbc', schluessel, Buffer.from(KSI.slice(64, 96), 'hex'));
  return 'v2#' + Buffer.concat([c.update(klar, 'utf8'), c.final()]).toString('base64');
}
const JSON_INHALT = {
  mainInfo: { ver: '6.2.14', softVer: '6.2.14.11', controllerType: 'Local Controller' },
  systemSetting: { pbkdf2KeySaltIv: KSI },
  omadacSetting: { omadacSetting: { name: 'Kunde-Controller', timeZone: 'UTC' } },
  sites: [{
    site: { name: 'Zentrale', region: 'Germany', timeZone: 'Europe/Amsterdam', scenario: 'Office' },
    wired: { lanNetworks: [{ name: 'LAN', vlan: 1, gatewaySubnet: '192.168.250.1/24' }, { name: 'Gast', vlan: 20, gatewaySubnet: '10.20.0.1/24' }] },
    wireless: { ssids: [{ name: 'Firma', ssid: 'Firma', security: 3, vlanId: 1, enable: true, pskSetting: { securityKey: v2('Geheim-PSK-123') } }, { name: 'Gast', ssid: 'Gast WLAN', security: 0, vlanId: 20, enable: true }] },
    ap: [{ name: 'AP-Flur', mac: 'AA-BB-CC-00-11-22', model: 'EAP650', ip: '192.168.250.10' }],
  }],
};
const verschluesseln = (o) => rc4(rc4Schluessel(), new Uint8Array(gzipSync(Buffer.from(JSON.stringify(o)))));

test('Omada: entschlüsseln, v2#-Werte, Version, Sites, Netze, WLANs, Geräte', async () => {
  const b = await omadaAusBytes('omada_backup_6.2.14.11.cfg', verschluesseln(JSON_INHALT));
  assert.equal(b.art, 'omada');
  assert.equal(b.version.genau, '6.2.14.11');
  assert.equal(b.identitaet, 'Kunde-Controller');
  assert.equal(b.entschluesselteFelder, 1);
  assert.equal(b.json.sites[0].wireless.ssids[0].pskSetting.securityKey, 'Geheim-PSK-123');
  assert.deepEqual(b.sites.map((s) => s.name), ['Zentrale']);
  assert.deepEqual(b.netze.map((n) => [n.name, n.vlan, n.subnetz]), [['LAN', 1, '192.168.250.1/24'], ['Gast', 20, '10.20.0.1/24']]);
  assert.deepEqual(b.wlans.map((w) => w.ssid), ['Firma', 'Gast WLAN']);
  assert.deepEqual(b.geraete.map((g) => [g.name, g.modell]), [['AP-Flur', 'EAP650']]);
  assert.ok(b.rubriken.some((r) => r.pfad === 'Site Zentrale › wireless › ssids' && r.saetze.length === 2));
  assert.ok(b.rubriken[0].pfad.startsWith('Site Zentrale'), 'Sites stehen vor dem Controller');
});

test('Fremde Datei: klare Meldung statt Absturz', async () => {
  await assert.rejects(omadaAusBytes('x.cfg', new Uint8Array(200).fill(7)), /Keine Omada-Sicherung/);
});

test('Ansicht: Suche über alles, Tabellenspalten, Das Wichtigste', async () => {
  const b = await omadaAusBytes('o.cfg', verschluesseln(JSON_INHALT));
  const { treffer } = sucheAlles(b, 'gast vlan');
  assert.ok(treffer.length >= 2, 'Netz und WLAN „Gast“');
  assert.ok(treffer.every((t) => t.felder.length > 0), 'je Treffer die passenden Felder');
  assert.equal(sucheAlles(b, 'Geheim-PSK').treffer[0].felder[0].anzeige, 'Geheim-PSK-123', 'entschlüsselte Werte sind durchsuchbar');
  assert.deepEqual(sucheAlles(b, 'x').treffer, [], 'unter 2 Zeichen keine Suche');
  const ssids = indexVon(b).find((r) => r.pfad.endsWith('ssids'));
  const spalten = spaltenFuer(ssids);
  assert.ok(spalten.includes('name') && spalten.includes('ssid'), `Spalten: ${spalten}`);
  assert.ok(!spalten.some((s) => /securityKey/i.test(s)), 'Schlüssel nicht als Spalte');
  const w = wichtigstes(b);
  assert.deepEqual(w.map((t) => t.titel.replace(/ \(\d+\)$/, '')), ['Sites', 'Netze', 'WLANs', 'Geräte']);
});

test('echtes Backup aus OMADA_TESTBACKUP', { skip: !process.env.OMADA_TESTBACKUP }, async () => {
  const b = await omadaAusBytes('echt.cfg', new Uint8Array(readFileSync(process.env.OMADA_TESTBACKUP)));
  assert.ok(b.rubriken.length > 10);
  assert.ok(b.version.genau);
});
