// FAH-Extraktor · test/konfig.test.mjs — Urheber: Fabian Hammer © 2026
// Konfig-Leser für Aruba und Fortinet (nur durchsuchen) mit kleinen, realistischen Beispielen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { konfigAusBytes, woerter } from '../src/konfig.js';
import { tarPacken } from '../server/tar.js';

const enc = (t) => new TextEncoder().encode(t);
const rubrik = (k, pfad) => k.rubriken.find((r) => r.pfad === pfad);

const FORTIGATE = `#config-version=FG100F-7.2.8-FW-build1639-240313:opmode=0:vdom=0:user=admin
#conf_file_ver=12345
#buildno=1639
#global_vdom=1
config system global
    set alias "FG100F"
    set hostname "FW-Zentrale"
    set timezone 28
end
config system interface
    edit "wan1"
        set vdom "root"
        set mode dhcp
        set allowaccess ping fgfm
        set role wan
    next
    edit "internal"
        set vdom "root"
        set ip 192.168.250.1 255.255.255.0
        set allowaccess ping https ssh
        set alias "LAN"
        config ipv6
            set ip6-mode static
        end
    next
end
config firewall policy
    edit 1
        set name "LAN-WAN"
        set srcintf "internal"
        set dstintf "wan1"
        set srcaddr "all"
        set dstaddr "all"
        set service "ALL"
        set nat enable
    next
end
config router bgp
    set as 65001
    config neighbor
        edit "10.0.0.2"
            set remote-as 65002
        next
    end
end
config wireless-controller vap
    edit "Gast"
        set ssid "Gast WLAN"
        set security wpa2-only-personal
    next
end
`;

test('FortiGate: Kopf, Rubriken, Einstellungen, Einträge, eingeflachte Unterabschnitte', async () => {
  const k = await konfigAusBytes('fw.conf', enc(FORTIGATE), 'fortinet');
  assert.equal(k.art, 'fortinet');
  assert.equal(k.type, 'FortiGate-Konfiguration (.conf)');
  assert.equal(k.geraet.modell, 'FG100F');
  assert.equal(k.version.genau, '7.2.8');
  assert.match(k.version.anzeige, /FortiOS 7\.2\.8 · Build 1639 · FG100F/);
  assert.equal(k.identitaet, 'FW-Zentrale');
  assert.deepEqual(k.rubriken.map((r) => r.pfad), ['system global', 'system interface', 'firewall policy', 'router bgp', 'router bgp › neighbor', 'wireless-controller vap']);
  const glob = rubrik(k, 'system global').saetze;
  assert.equal(glob.length, 1);
  assert.equal(glob[0].titel, '(Einstellungen)');
  assert.equal(glob[0].felder.find((f) => f.name === 'hostname').anzeige, 'FW-Zentrale');
  const intern = rubrik(k, 'system interface').saetze.find((s) => s.titel === 'internal');
  assert.equal(intern.felder.find((f) => f.name === 'allowaccess').anzeige, 'ping https ssh');
  assert.equal(intern.felder.find((f) => f.name === 'ipv6 › ip6-mode').anzeige, 'static', 'config in edit wird eingeflacht');
  assert.match(intern.quelle, /edit "internal"[\s\S]*set ip 192\.168\.250\.1[\s\S]*next/, 'Originalzeilen je Datensatz');
  assert.ok(intern.zeileNr > 0);
  assert.equal(rubrik(k, 'firewall policy').saetze[0].titel, '1 · LAN-WAN');
  assert.equal(rubrik(k, 'router bgp').saetze[0].felder[0].anzeige, '65001');
  assert.equal(rubrik(k, 'router bgp › neighbor').saetze[0].titel, '10.0.0.2');
  assert.deepEqual(k.adressen.map((a) => [a.adresse, a.prefix, a.schnittstelle]), [['DHCP', null, 'wan1'], ['192.168.250.1', 24, 'internal']]);
  assert.deepEqual(k.wlans.map((w) => [w.profil, w.ssid]), [['Gast', 'Gast WLAN']]);
  assert.ok(intern.text.includes('192.168.250.1') && intern.text === intern.text.toLowerCase());
  assert.equal(k.unbekannt, false);
  assert.ok(k.exportText.startsWith('#config-version'));
});

test('FortiGate im VDOM-Modus: Behälter „vdom <name>“ und „global“', async () => {
  const text = `#config-version=FG200F-7.4.3-FW-build2573-240201:opmode=0:vdom=1:user=admin
config vdom
edit root
next
end
config global
config system global
    set hostname "FW-V"
end
end
config vdom
edit root
config system interface
    edit "port1"
        set ip 10.1.1.1/24
    next
end
next
end
`;
  const k = await konfigAusBytes('v.conf', enc(text), 'fortinet');
  assert.deepEqual(k.rubriken.map((r) => r.pfad), ['global › system global', 'vdom root › system interface']);
  assert.equal(k.identitaet, 'FW-V');
  assert.deepEqual([k.adressen[0].adresse, k.adressen[0].prefix], ['10.1.1.1', 24]);
  assert.ok(k.version.hinweise.some((h) => /VDOM-Modus/.test(h)));
});

test('FortiGate verschlüsselt (binär): klare Anzeige ohne Rubriken', async () => {
  const k = await konfigAusBytes('x.conf', new Uint8Array([0x46, 0x47, 0x00, 0x01, 0xff, 0x80, 0x00, 0x10]), 'fortinet');
  assert.equal(k.verschluesselt, true);
  assert.deepEqual(k.rubriken, []);
  assert.match(k.version.hinweise[0], /ohne Passwort erneut sichern/);
});

const AOS_S = `; J9773A Configuration Editor; Created on release #YA.16.10.0012
; Ver #14:4f.f8.1c.9b.3f.bf.bb.ef.7c.59.fc.6b.fb.9f.fc.ff.ff.37.ef:91
hostname "SW-Keller"
time daylight-time-rule middle-europe-and-portugal
snmp-server community "public" unrestricted
snmp-server contact "IT"
vlan 1
   name "DEFAULT_VLAN"
   untagged 1-20
   ip address dhcp-bootp
   exit
vlan 250
   name "Verwaltung"
   tagged 24
   ip address 192.168.250.2 255.255.255.0
   exit
interface 24
   name "Uplink"
   exit
`;

test('Aruba AOS-S: Version aus dem Kopf, Blöcke mit exit, globale Zeilen gruppiert', async () => {
  const k = await konfigAusBytes('sw.cfg', enc(AOS_S), 'aruba');
  assert.equal(k.geraet.variante, 'AOS-S');
  assert.equal(k.geraet.modell, 'J9773A');
  assert.equal(k.version.genau, 'YA.16.10.0012');
  assert.equal(k.identitaet, 'SW-Keller');
  assert.deepEqual(k.rubriken.map((r) => r.pfad), ['Globale Einstellungen', 'vlan', 'interface']);
  const snmp = rubrik(k, 'Globale Einstellungen').saetze.find((s) => s.titel === 'snmp-server');
  assert.deepEqual(snmp.felder.map((f) => [f.name, f.anzeige]), [['community', '"public" unrestricted'], ['contact', 'IT']]);
  const v250 = rubrik(k, 'vlan').saetze.find((s) => s.titel === '250');
  assert.equal(v250.felder.find((f) => f.name === 'name').anzeige, 'Verwaltung');
  assert.ok(!v250.felder.some((f) => f.name === 'exit'), 'exit ist kein Feld');
  assert.deepEqual(k.adressen.map((a) => [a.adresse, a.prefix, a.schnittstelle, a.name]), [['192.168.250.2', 24, 'vlan 250', 'Verwaltung']]);
});

const AOS_CX = `Current configuration:
!
!Version ArubaOS-CX FL.10.10.1020
!export-password: default
hostname CX-Core
user admin group administrators password ciphertext AQBapXYZ
vlan 1,10
interface 1/1/1
    no shutdown
    description Server
    vlan access 10
interface vlan 10
    ip address 10.10.0.1/24
router ospf 1
    router-id 10.10.0.1
    area 0.0.0.0
!
https-server vrf mgmt
`;

test('Aruba AOS-CX: Einrückung, mehrwortige Rubriken, Adresse mit Präfix', async () => {
  const k = await konfigAusBytes('cx.txt', enc(AOS_CX), 'aruba');
  assert.equal(k.geraet.variante, 'AOS-CX');
  assert.equal(k.version.genau, 'FL.10.10.1020');
  assert.equal(k.identitaet, 'CX-Core');
  assert.ok(rubrik(k, 'interface vlan') && rubrik(k, 'router ospf') && rubrik(k, 'interface'));
  const p1 = rubrik(k, 'interface').saetze[0];
  assert.equal(p1.titel, '1/1/1');
  assert.deepEqual(p1.felder.map((f) => f.name), ['no shutdown', 'description', 'vlan']);
  assert.deepEqual(k.adressen.map((a) => [a.adresse, a.prefix, a.schnittstelle]), [['10.10.0.1', 24, 'interface vlan 10']]);
  assert.ok(k.version.hinweise.some((h) => /Simulator/.test(h)));
});

const INSTANT = `version 8.10.0.6-8.10.0.6
virtual-controller-country DE
virtual-controller-key abcdef
name Buero-IAP
terminal-access
wlan ssid-profile Mitarbeiter
 enable
 index 0
 type employee
 essid Firma
 opmode wpa2-psk-aes
 vlan 20
wlan ssid-profile Gast
 essid "Gast WLAN"
 opmode opensystem
 type guest
`;

test('Aruba Instant AP: VC-Name als Identität, WLANs aus ssid-profile', async () => {
  const k = await konfigAusBytes('instant.cfg', enc(INSTANT), 'aruba');
  assert.equal(k.geraet.variante, 'Instant AP');
  assert.equal(k.version.genau, '8.10.0.6');
  assert.equal(k.identitaet, 'Buero-IAP');
  assert.deepEqual(k.wlans.map((w) => [w.profil, w.ssid, w.sicherheit, w.vlan]), [['Mitarbeiter', 'Firma', 'wpa2-psk-aes', '20'], ['Gast', 'Gast WLAN', 'opensystem', null]]);
});

test('ArubaOS 8 flashbackup.tar.gz: default.cfg aus dem Archiv', async () => {
  const cfg = 'version 8.10\nhostname MC-01\ninterface vlan 1\n   ip address 192.168.10.5 255.255.255.0\n!\nwlan ssid-profile "corp"\n   essid "Corp"\n!\n';
  const tar = tarPacken([{ name: 'flash/config/default.cfg', daten: Buffer.from(cfg) }, { name: 'flash/license.db', daten: Buffer.from([0, 1, 2, 3]) }]);
  const k = await konfigAusBytes('flashbackup.tar.gz', new Uint8Array(gzipSync(tar)), 'aruba');
  assert.equal(k.quelle, 'flash/config/default.cfg');
  assert.equal(k.files.size, 2);
  assert.equal(k.geraet.variante, 'ArubaOS 8');
  assert.equal(k.identitaet, 'MC-01');
  assert.deepEqual([k.adressen[0].adresse, k.adressen[0].prefix], ['192.168.10.5', 24]);
  assert.equal(k.wlans[0].ssid, 'Corp');
  assert.ok(k.version.hinweise[0].includes('Archiv mit 2 Dateien'));
});

test('Fremde Textdatei: unbekannt, aber ohne Abbruch', async () => {
  const k = await konfigAusBytes('notiz.txt', enc('# nur ein Kommentar\n'), 'fortinet');
  assert.equal(k.unbekannt, true);
  assert.deepEqual(k.rubriken, []);
  assert.ok(k.version.hinweise[0].startsWith('Keine Fortinet-Konfiguration erkannt'));
});

test('woerter: Anführungszeichen halten Leerzeichen zusammen', () => {
  assert.deepEqual(woerter('set member "a b" c'), ['set', 'member', 'a b', 'c']);
});
