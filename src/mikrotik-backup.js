// FAH-Extraktor · src/mikrotik-backup.js — Urheber: Fabian Hammer © 2026
// Unveränderte Übernahme des RouterOS-Backup-Decoders aus der Formatanalyse (10.10.2026).
// mikrotik-backup.js
// Decoder für das MikroTik-RouterOS-Backup-Format (.backup).
// ES-Modul, browsertauglich, ohne Abhängigkeiten.
//
// Erschlossen aus einer echten, unverschlüsselten CCR2004-Sicherung (RouterOS 7)
// und gegen bekannte Werte geprüft (Schnittstellen+MACs, IP-Adressen, Benutzer).
// Siehe SPEZIFIKATION.md für das genaue Feld-Encoding und was sicher/Vermutung ist.
//
// Hauptfunktionen:
//   parseBackup(ArrayBuffer) -> { verschluesselt, magic, eintraege: [...] }
//   versionErkennen(backup)  -> { hauptversion, hinweise, mindestversion? }
//   RUBRIKEN                 -> Objekt: Eintragsname -> lesbarer Pfad
//   rubrikFuer(name)         -> lesbarer Pfad für einen Namen

// --- Magic-Konstanten des Außenformats (Kopf, 4 Byte, little-endian) ---
export const MAGIC_KLARTEXT = 0xB1A1AC88; // unverschlüsselt
export const MAGIC_RC4      = 0x7291A8EF; // alt, RC4
export const MAGIC_AES      = 0x7391A8EF; // neu, AES-128-CTR + SHA-256
// Hinweis: Die Aufgabe nannte 0x7391A8EA für AES; routerosbackuptools dokumentiert
// 0x7391A8EF. Wir halten 0x7391A8EF für korrekt (vermutlich Tippfehler in der Aufgabe).

const td = new TextDecoder('utf-8', { fatal: false });

// --- M2-Feldwert lesen ----------------------------------------------------
// Feldkopf = 4 Byte: Kennung (u24 LE) + Typ (u8).
// Niedrigstes Typ-Bit (0x01): 0 = Langform (u16-Länge / 4-Byte-Int), 1 = Kurzform.
// Array-Bit (0x80): danach u16-Anzahl, dann je Element der Basistyp.
function wertLesen(dv, p, typ) {
  const array = (typ & 0x80) !== 0;
  const familie = typ & 0x7E;        // Form-Bit und Array-Bit ausblenden
  const lang = (typ & 0x01) === 0;   // gerade = Langform

  if (array) {
    const anzahl = dv.getUint16(p, true); p += 2;
    const anfang = p;
    const elemente = [];
    for (let i = 0; i < anzahl; i++) {
      const r = wertLesen(dv, p, typ & 0x7F); // je Element ohne Array-Bit
      elemente.push(r.wert); p = r.p;
    }
    const roh = new Uint8Array(dv.buffer, dv.byteOffset + anfang, p - anfang);
    return { wert: elemente, roh, p };
  }

  const bytes = (n) => new Uint8Array(dv.buffer, dv.byteOffset + p, n);
  const laenge = () => { const l = lang ? dv.getUint16(p, true) : dv.getUint8(p); p += lang ? 2 : 1; return l; };

  switch (familie) {
    case 0x00: // bool: Wert im niedrigen Bit des Typs
      return { wert: (typ & 0x01) === 0x01, roh: new Uint8Array(0), p };
    case 0x08: { // ganzzahl: 0x08 = 4 Byte, 0x09 = 1 Byte (little-endian)
      const n = lang ? 4 : 1; const roh = bytes(n);
      let v = 0; for (let i = n - 1; i >= 0; i--) v = v * 256 + roh[i];
      p += n; return { wert: v, roh, p };
    }
    case 0x10: { // große ganzzahl (VERMUTUNG): 0x10 = 8 Byte, 0x11 = 2 Byte
      const n = lang ? 8 : 2; const roh = bytes(n);
      let v = 0n; for (let i = n - 1; i >= 0; i--) v = v * 256n + BigInt(roh[i]);
      p += n; return { wert: (v <= 9007199254740991n ? Number(v) : v), roh, p };
    }
    case 0x18: { // 16-Byte-Wert / IPv6 (VERMUTUNG, in Testdatei nicht beobachtet)
      const roh = bytes(16); p += 16; return { wert: roh, roh, p };
    }
    case 0x20: { // zeichenkette: 0x20 = u16-Länge, 0x21 = u8-Länge
      const l = laenge(); const roh = bytes(l); p += l;
      return { wert: td.decode(roh), roh, p };
    }
    case 0x28: { // geschachtelte Nachricht: 0x28 = u16-Länge, 0x29 = u8-Länge
      const l = laenge(); const roh = bytes(l); p += l;
      const sub = new DataView(dv.buffer, dv.byteOffset + (p - l), l);
      return { wert: { felder: nachrichtLesen(sub) }, roh, p };
    }
    case 0x30: { // rohbytes: 0x30 = u16-Länge, 0x31 = u8-Länge (z.B. MAC, DER-Zertifikat)
      const l = laenge(); const roh = bytes(l); p += l;
      return { wert: roh, roh, p };
    }
    default:
      throw new Error('unbekannter Typ 0x' + typ.toString(16) + ' an Position ' + p);
  }
}

// Eine M2-Nachricht (beginnt mit 'M2') -> Feldliste [{id, typ, wert, roh}]
function nachrichtLesen(dv) {
  if (dv.byteLength < 2 || dv.getUint8(0) !== 0x4D || dv.getUint8(1) !== 0x32) {
    throw new Error('kein M2-Kopf');
  }
  let p = 2;
  const felder = [];
  while (p + 4 <= dv.byteLength) {
    const id = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16);
    const typ = dv.getUint8(p + 3);
    p += 4;
    const r = wertLesen(dv, p, typ);
    felder.push({ id, typ, wert: r.wert, roh: r.roh });
    p = r.p;
  }
  return felder;
}

// --- Außenformat ----------------------------------------------------------
export function parseBackup(arrayBuffer) {
  const buf = arrayBuffer instanceof Uint8Array
    ? arrayBuffer.buffer.slice(arrayBuffer.byteOffset, arrayBuffer.byteOffset + arrayBuffer.byteLength)
    : arrayBuffer;
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  const verschluesselt = (magic === MAGIC_RC4 || magic === MAGIC_AES);

  const ergebnis = { verschluesselt, magic, eintraege: [] };
  if (verschluesselt) {
    ergebnis.hinweis = 'verschlüsselt (Magic 0x' + magic.toString(16) +
      ') – Passwort nötig, siehe SPEZIFIKATION.md';
    return ergebnis;
  }
  if (magic !== MAGIC_KLARTEXT) {
    ergebnis.hinweis = 'unbekanntes Magic 0x' + magic.toString(16);
    return ergebnis;
  }

  ergebnis.gesamtLautKopf = dv.getUint32(4, true);
  const u8 = new Uint8Array(buf);
  let pos = 8;
  const leu32 = (o) => dv.getUint32(o, true);

  while (pos < u8.length) {
    const nlen = leu32(pos); pos += 4;
    const name = td.decode(u8.subarray(pos, pos + nlen)); pos += nlen;
    const ilen = leu32(pos); pos += 4;
    const idxBytes = u8.subarray(pos, pos + ilen); pos += ilen;
    const dlen = leu32(pos); pos += 4;
    const daten = u8.subarray(pos, pos + dlen); pos += dlen;

    // Index: je 12 Byte = 3x int32 signed [anzeige, groesse, reserviert]
    const index = [];
    const idv = new DataView(idxBytes.buffer, idxBytes.byteOffset, idxBytes.byteLength);
    for (let i = 0; i + 12 <= idxBytes.length; i += 12) {
      index.push({
        anzeige: idv.getInt32(i, true),
        groesse: idv.getInt32(i + 4, true),
        reserviert: idv.getInt32(i + 8, true),
      });
    }

    // Datensätze per Index zerschneiden; jeder beginnt mit u16-Längenpräfix + M2-Body
    const saetze = [];
    let q = 0;
    for (const e of index) {
      const rec = daten.subarray(q, q + e.groesse); q += e.groesse;
      const body = rec.subarray(2); // 2-Byte-Präfix überspringen
      let felder = [], fehler = null;
      try {
        const bdv = new DataView(body.buffer, body.byteOffset, body.byteLength);
        felder = nachrichtLesen(bdv);
      } catch (err) {
        fehler = String(err && err.message || err);
      }
      saetze.push({ anzeige: e.anzeige, groesse: e.groesse, reserviert: e.reserviert, felder, fehler });
    }

    ergebnis.eintraege.push({ name, index, daten, saetze });
  }
  ergebnis.endeOk = (pos === u8.length);
  return ergebnis;
}

// --- Hilfen zum Lesbarmachen ---------------------------------------------
export function alsIp(roh) {               // IPv4 aus 4 Rohbytes (Netzwerk-Reihenfolge)
  return Array.from(roh.subarray(0, 4)).join('.');
}
export function alsMac(roh) {
  return Array.from(roh.subarray(0, 6)).map((b) => b.toString(16).padStart(2, '0')).join(':');
}
export function feld(satz, id) {           // erstes Feld mit Kennung id
  return satz.felder.find((f) => f.id === id);
}

// --- RUBRIKEN: Eintragsname -> lesbarer Pfad ------------------------------
// Pfade orientieren sich an den WinBox/WebFig-Menüs. Sichere Zuordnungen ohne
// Zusatz; unsichere mit "(unsicher)"; echte Unbekannte -> "Sonstiges".
export function rubrikFuer(name) {
  // 1) Exakte Treffer (geprüft/eindeutig)
  const exakt = {
    'net/devices': 'Interfaces',
    'net/devlist': 'Interfaces › Liste', 'net/devlist-member': 'Interfaces › Liste',
    'net/addrs': 'IP › Addresses', 'net/addrs6': 'IPv6 › Addresses',
    'net/arp': 'IP › ARP',
    'net/address-list': 'IP › Firewall › Address Lists',
    'net/address-list6': 'IPv6 › Firewall › Address Lists',
    'net/ipt-filter': 'IP › Firewall › Filter',
    'net/ipt-mangle': 'IP › Firewall › Mangle',
    'net/ipt-nat': 'IP › Firewall › NAT',
    'net/ipt-raw': 'IP › Firewall › Raw',
    'net/ipt-calea': 'IP › Firewall › CALEA',
    'net/ctmodule': 'IP › Firewall › Connection Tracking',
    'net/layer7protos': 'IP › Firewall › Layer7-Protokolle',
    'net/raw': 'IP › Firewall › Raw (unsicher)',
    'net/simplequeues': 'Queues › Simple Queues',
    'net/queuetree': 'Queues › Queue Tree',
    'net/queuetypes': 'Queues › Queue Types',
    'ippool': 'IP › Pool', 'ippool6': 'IPv6 › Pool',
    'resolver/config': 'IP › DNS',
    'resolver/static': 'IP › DNS › Static',
    'resolver/adlist': 'IP › DNS › Adlist',
    'resolver/forwarders': 'IP › DNS › Forwarders',
    'cloud': 'IP › Cloud',
    'reverse-proxy/rules': 'IP › Reverse Proxy',
    'socksify': 'IP › SOCKS',
    'mproxy-settings': 'IP › Web Proxy (unsicher)',
    'macping': 'Tools › MAC Ping', 'mactel-settings': 'Tools › MAC Telnet',
    'sniffer': 'Tools › Packet Sniffer', 'btest': 'Tools › Bandwidth Test',
    'bserv': 'Tools › Bandwidth Server (unsicher)',
    'netwatch2': 'Tools › Netwatch', 'email': 'Tools › E-Mail',
    'romon': 'Tools › RoMON', 'romonport': 'Tools › RoMON › Ports',
    'user': 'System › Users', 'user/aaa': 'System › Users › AAA', 'user/cfg': 'System › Users (Einstellungen)',
    'group': 'System › Users › Groups', 'login': 'System › Users › Login',
    'scripts': 'System › Scripts', 'scheduler': 'System › Scheduler',
    'ntp': 'System › NTP', 'ntp-servers': 'System › NTP › Server', 'ntp-keys': 'System › NTP › Keys',
    'system': 'System (Identity/Clock)', 'system-hw': 'System › Hardware/Resources',
    'rosmode': 'System › RouterOS-Modus', 'upgrader': 'System › Packages/Upgrade',
    'watchdog': 'System › Watchdog', 'health': 'System › Health',
    'leds': 'System › LEDs', 'led_triggers': 'System › LEDs › Trigger', 'led/settings': 'System › LEDs (Einstellungen)',
    'log-actions': 'System › Logging › Actions', 'log-rules': 'System › Logging › Rules',
    'cerm': 'System › Certificates', 'cert/crl': 'System › Certificates › CRL',
    'cert/settings': 'System › Certificates (Einstellungen)',
    'letsencrypt': "System › Certificates › Let's Encrypt",
    'ssh-keys': 'System › Users › SSH Keys', 'ssh-private-keys': 'System › SSH › Private Keys',
    'ssh-forwarding': 'IP › SSH › Forwarding',
    'serial-login': 'System › Serielle Konsole', 'sermgr': 'System › Serial Port Manager',
    'sertcp': 'IP › Serial-to-TCP (unsicher)',
    'lcdtouch': 'System › LCD', 'chfont': 'System › LCD › Font (unsicher)',
    'disks': 'System › Disks', 'disk-config': 'System › Disks (Konfiguration)', 'btrfs-subvolumes': 'System › Disks › btrfs',
    'file-master': 'Files', 'file-sources': 'Files (Quellen, unsicher)',
    'usb': 'System › USB', 'usb_settings': 'System › USB (Einstellungen)',
    'sim_settings': 'System › LTE › SIM', 'net/apn': 'System › LTE › APN',
    'net/modem_aux': 'System › LTE › Modem (unsicher)', 'sms-config': 'Tools › SMS',
    'mode_button': 'System › Taster › Mode', 'button': 'System › Taster', 'wps_button': 'System › Taster › WPS',
    'poe-bootercfg': 'System › PoE (unsicher)',
    'snmpd': 'SNMP', 'snmp-communities': 'SNMP › Communities',
    'quickset': 'Quick Set', 'suggestions': 'System › Vorschläge',
    'vm': 'System › Virtual Machine (KVM)', 'irq': 'System › Resources › IRQ',
    'rps': 'System › Resources › RPS (unsicher)', 'auto_freq': 'System › CPU-Frequenz (unsicher)',
    'command/sysnote': 'System › Note', 'command/speclogin': 'System › Login-Banner (unsicher)',
    'command/settings': 'System › Console (Einstellungen)', 'command/alias': 'System › Console › Alias',
    'radius': 'RADIUS', 'radius/incoming': 'RADIUS › Incoming',
    'tftp': 'IP › TFTP', 'tftp_settings': 'IP › TFTP (Einstellungen)',
    'meshports': 'Interfaces › Mesh',
    'bridgeports': 'Interfaces › Bridge › Ports', 'bridgecfg': 'Interfaces › Bridge',
    'bridge-vlans': 'Interfaces › Bridge › VLANs',
    'iface-wireguard': 'Interfaces › WireGuard', 'net/wireguard': 'Interfaces › WireGuard › Peers',
    'bth/user': 'IP › Back To Home › Users', 'bth/fileshare': 'IP › Back To Home › Dateifreigabe',
    'kidcontrol/device': 'IP › Kid Control › Geräte', 'kidcontrol/user': 'IP › Kid Control › Benutzer',
    'upnp': 'IP › UPnP', 'upnpm': 'IP › UPnP (Dienst)', 'natpmpm': 'IP › NAT-PMP',
    'upnpmedia': 'Media Server (unsicher)', 'upnpmedia_settings': 'Media Server (Einstellungen, unsicher)',
    'smb': 'IP › SMB', 'smbshares': 'IP › SMB › Shares', 'smbusers': 'IP › SMB › Users',
    'diskd-smb-user': 'IP › SMB › Users (Disk)', 'diskd-smb-share': 'IP › SMB › Shares (Disk)',
    'net/vrf': 'IP › VRF', 'r5/bfd/cfg': 'Routing › BFD', 'r5/gmp-join': 'Routing › IGMP/MLD (unsicher)',
    'r5/routing/route': 'IP › Routes', 'r5/routing/routing-table': 'Routing › Tables',
    'r5/routing/rule': 'Routing › Rules', 'r5/routing/settings': 'Routing (Einstellungen)',
    'r5/routing/id': 'Routing › Router-ID', 'r5/routing/copy': 'Routing (Kopie, unsicher)',
    'r5/routing/fantasy': 'Routing (intern, unsicher)', 'r5/routing/evpn': 'Routing › EVPN',
    'port_lock': 'System › Port-Lock (unsicher)', 'ppacker': 'Sonstiges (ppacker, unsicher)',
    'detnet-settings': 'Sonstiges (DetNet, unsicher)',
    'graphing/conf/main': 'Tools › Graphing',
    'net/vxlan/vteps': 'Interfaces › VXLAN › VTEPs',
    'net/neigh6': 'IPv6 › Neighbors', 'net/ndproxy6': 'IPv6 › ND-Proxy',
    'dhcp/duid': 'IPv6 › DHCP Client › DUID', 'dhcp/alert': 'IP › DHCP Server › Alert',
    'dhcp/relay': 'IP › DHCP Relay', 'dhcp/relay6': 'IPv6 › DHCP Relay', 'dhcp/relay6routes': 'IPv6 › DHCP Relay › Routes',
    'mplsmangle': 'MPLS › Mangle (unsicher)',
    'pppoe-services': 'PPP › PPPoE Server', 'ppp_settings': 'PPP (Einstellungen)',
    'l2tp/server': 'PPP › L2TP Server', 'pptp/server': 'PPP › PPTP Server', 'sstp/server': 'PPP › SSTP Server',
    'traffic-generator-config': 'Tools › Traffic Generator', 'traffic-scripts': 'System › Scripts (Traffic, unsicher)',
    'trafflow-config': 'IP › Traffic Flow', 'trafflow-targets': 'IP › Traffic Flow › Targets',
  };
  if (name in exakt) return exakt[name];

  // 2) Präfix-/Familienregeln (geordnet)
  const regeln = [
    ['hotspot/', 'IP › Hotspot'],
    ['dhcp/server', 'IP › DHCP Server'],
    ['dhcp/client', 'IP › DHCP Client'],
    ['dhcp/', 'IP › DHCP'],
    ['resolver/', 'IP › DNS'],
    ['ipsec/', 'IP › IPsec'],
    ['wproxy/', 'IP › Web Proxy'],
    ['www/socks', 'IP › SOCKS'],
    ['www/', 'IP › Web (unsicher)'],
    ['igmpproxy/', 'Routing › IGMP Proxy'],
    ['graphing/', 'Tools › Graphing'],
    ['traffic-generator', 'Tools › Traffic Generator'],
    ['trafic-generator', 'Tools › Traffic Generator'],
    ['trafflow', 'IP › Traffic Flow'],
    ['cert/scep', 'System › Certificates › SCEP'],
    ['cert/', 'System › Certificates'],
    ['dot1x/', 'Interfaces › 802.1X'],
    ['ppp/', 'PPP'],
    ['ovpn/', 'PPP › OpenVPN'],
    ['ptp/', 'Routing › PTP (Precision Time)'],
    ['bridge-', 'Interfaces › Bridge'],
    ['wireless/ww2-', 'WiFi'],
    ['wireless/radio', 'WiFi › Radio'],
    ['wireless/', 'WiFi'],
    ['ww2-', 'WiFi'],
    ['r5/routing/ospf', 'Routing › OSPF'],
    ['r5/routing/bgp', 'Routing › BGP'],
    ['r5/routing/ubgp', 'Routing › BGP'],
    ['r5/routing/rip', 'Routing › RIP'],
    ['r5/routing/isis', 'Routing › IS-IS'],
    ['r5/routing/pimsm', 'Routing › PIM-SM'],
    ['r5/routing/filter', 'Routing › Filters'],
    ['r5/routing/', 'Routing'],
    ['r5/mpls/ldp', 'MPLS › LDP'],
    ['r5/mpls/rsvp', 'MPLS › Traffic Eng (RSVP)'],
    ['r5/mpls/', 'MPLS'],
    ['r5/', 'Routing (unsicher)'],
    ['net/switch', 'Switch'],
    ['net/music/', 'Switch › Chip (music)'],
    ['net/qos/', 'Switch › QoS'],
    ['net/ipt6-', 'IPv6 › Firewall'],
    ['net/ebt-', 'Bridge › Firewall (ebtables)'],
    ['net/addrs6', 'IPv6 › Addresses'],
    ['net/', 'IP (unsicher)'],
    ['radvd/', 'IPv6 › ND/RADVD'],
    ['figman/', 'System › Zentralverwaltung (figman, unsicher)'],
    ['graphing', 'Tools › Graphing'],
    ['snmp', 'SNMP'],
    ['command/', 'System › Console'],
    ['kidcontrol/', 'IP › Kid Control'],
    ['bth/', 'IP › Back To Home'],
    ['sms', 'Tools › SMS'],
    ['ssh', 'System › SSH'],
    ['cmr', 'Sonstiges (cmr, unsicher)'],
    ['unicl/', 'Sonstiges (unicl, unsicher)'],
    ['sys2-dbrd', 'WiFi › Dashboard (unsicher)'],
    ['poe', 'System › PoE'],
  ];
  for (const [pre, pfad] of regeln) if (name.startsWith(pre)) return pfad;

  return 'Sonstiges';
}

// Vollständige Namensliste der 352 Rubriken dieses Formats (Katalog einer ROS-7-CCR2004).
// Dient dazu, RUBRIKEN als konkrete Tabelle bereitzustellen; rubrikFuer() deckt auch
// hier nicht gelistete Namen über die Regeln ab.
export const NAMEN = ["r5/version","net/vrf","r5/routing/ubgp/cfg","net/devices","net/addrs","r5/bfd/cfg","bserv","dhcp/client_options","dhcp/client","group","lcdtouch","leds","led_triggers","log-actions","log-rules","net/apn","net/raw","net/queuetypes","ntp","port_lock","radvd/iface","rps","serial-login","sim_settings","user","user/aaa","diskd-smb-user","diskd-smb-share","system-hw","dhcp/duid","net/switch-config","net/switch-ports","net/qos/txq","system","dhcp/server/roption6","rosmode","cerm","r5/routing/routing-table","net/ipt-filter","net/ipt-mangle","net/ipt-nat","r5/routing/route","scheduler","bridgeports","cert/crl","dhcp/server/config","dhcp/server/server","dhcp/server/subnet","hotspot/iface","hotspot/profile","hotspot/srvprof","hotspot/user","hotspot/walled-garden","hotspot/wgip","ippool","macping","mactel-settings","mproxy-settings","net/address-list","net/layer7protos","ntp-servers","ppp/profile","radius","resolver/config","resolver/static","romon","romonport","scripts","sermgr","ssh-keys","ssh-forwarding","wproxy/config","www/socks/config","bridge-vlans","login","dhcp/server/lease","auto_freq","hotspot/main","cert/scep_otp","upgrader","bridge-extdev","bridge-msti","bridge-mst-override","btest","bth/user","bridge-portcntrl","bridge-portext","bridge-fdb","bridge-mdb","cert/scep_ca_transactions","cert/settings","cert/scep_ra","cert/scep_server","chfont","cloud","command/sysnote","command/speclogin","detnet-settings","dhcp/alert","dhcp/client6","dhcp/client_options6","dhcp/relay6","dhcp/relay","dhcp/server/binding","dhcp/server/option6","dhcp/server/option_set6","dhcp/server/option_set","dhcp/server/option","dhcp/server/server6","dhcp/server/vendor","disks","disk-config","dot1x/client","dot1x/mka-profile","dot1x/port","email","figman/connect","figman/peer","figman/store","figman/local","figman/remote","figman/rule","cmrclnt/inst","cmr/inst","file-master","file-sources","graphing/conf/main","graphing/conf/boxes","graphing/conf/cpumem","graphing/conf/health","graphing/conf/ifaces","graphing/conf/queues","graphing/store/cpumem","graphing/store/dat","graphing/store/ifaces","graphing/store/queues","health","hotspot/loginid","iface-wireguard","igmpproxy/general","igmpproxy/iface","igmpproxy/mfc","ippool6","ipsec/identity","ipsec/key","ipsec/modecfg","ipsec/peer_proposal","ipsec/peer","ipsec/policy_group","ipsec/policy","ipsec/sainfo","ipsec/user_settings","irq","kidcontrol/device","kidcontrol/user","l2tp/server","led/settings","letsencrypt","meshports","natpmpm","net/address-list6","net/addrs6","net/arp","net/ctmodule","net/devlist","net/devlist-member","net/ebt-calea","net/ebt-filter","net/ebt-nat","net/ipt6-filter","net/ipt6-mangle","net/ipt6-nat","net/ipt6-raw","net/ipt-calea","net/ipt-raw","net/simplequeues","net/queuetree","net/switch-acl-entries","net/vxlan/vteps","netwatch2","net/wireguard","ntp-keys","ovpn/servers","ppacker","ppp/aaa","ppp/l2tp-secret","pppoe-services","ppp/secret","ptp/port","ptp/ptp","pptp/server","r5/mpls/rsvp/path","r5/routing/filter/srule","r5/routing/ospf/area","r5/routing/ospf/iface","r5/routing/ospf/instance","r5/routing/ospf/neighbor","r5/routing/ospf/range","r5/routing/ubgp/conn","r5/routing/filter/community","r5/routing/filter/ext-community","r5/routing/filter/large-community","r5/routing/filter/ns","r5/routing/filter/frule","r5/routing/bgp/rpki","r5/routing/isis/instance","r5/routing/isis/interface","r5/routing/pimsm/inst","r5/routing/pimsm/ifc-tmpl","r5/routing/pimsm/bsrc","r5/routing/pimsm/crp","r5/routing/pimsm/srp","r5/routing/copy","r5/routing/fantasy","r5/gmp-join","r5/routing/id","r5/routing/settings","r5/routing/rule","r5/routing/rip/inst","r5/routing/rip/ifc-tmpl","r5/routing/rip/auth","r5/routing/rip/neighbor","r5/mpls/bgpvpls","r5/mpls/ldp/instance","r5/mpls/iface","r5/mpls/ldp/filterin","r5/mpls/ldp/filterout","r5/mpls/ldp/iface","r5/mpls/ldp/local","r5/mpls/ldp/neigh","r5/mpls/ldp/remote","r5/mpls/main","r5/mpls/rsvp/iface","r5/mpls/rsvp/tun","radius/incoming","radvd/prefix","radvd/default","sniffer","sertcp","smbshares","smbusers","smb","snmpd","snmp-communities","ssh-private-keys","socksify","sstp/server","tftp","tftp_settings","trafflow-config","trafflow-targets","traffic-generator-config","traffic-generator-packet-templates","traffic-generator-raw-packet-templates","trafic-generator-streams","traffic-generator-ports","traffic-scripts","unicl/client","unicl/module","upnpm","usb_settings","user/cfg","vm","watchdog","wproxy/access","wproxy/cache","wproxy/direct","www/socks/acl","www/socks/users","ww2-capcfg","ww2-cmcfg","ww2-emcfg","wireless/ww2-steer","suggestions","btrfs-subvolumes","radvd/settings","upnp","upnpmedia","upnpmedia_settings","quickset","bth/fileshare","www/conf","bridge-mlag","bridge-msrp-streams","bridge-msrp-domains","resolver/adlist","resolver/forwarders","r5/routing/ospf/iface_raw","r5/routing/ubgp/inst","r5/routing/evpn","ww2-acl","wireless/ww2-seccfg","wireless/ww2-iwcfg","wireless/ww2-dpcfg","wireless/ww2-chan","wireless/ww2-aaa","wireless/ww2-cfg","ww2-netw","ww2-netwradio","ww2-multi-passphrase","command/settings","command/alias","poe-bootercfg","usb","mode_button","button","wps_button","sys2-dbrd","ww2-dbrd","ww2-dpp-bootstrap-info","net/neigh6","net/ndproxy6","net/switch-macs","net/switch-vlans","net/music/port","net/music/qos-group","net/music/qos-dscp-map","net/music/ufdb","net/music/mfdb","net/music/rfdb","net/music/vlan","net/music/vlan-egress-tag","net/music/vlan-ingress-trans","net/music/vlan-egress-trans","net/music/vlan-mac-based","net/music/vlan-one2one","net/music/vlan-proto-based","net/music/shaper","net/music/port-isolation","net/music/port-leakage","net/music/policy","net/music/trunk","net/music/policer","net/music/port-policer","net/music/policer-qos-map","net/qos/config","net/qos/profile","net/qos/map","net/qos/map-vlan","net/qos/map-ip","net/qos/txman","net/qos/pfc","net/modem_aux","sms-config","mplsmangle","bridgecfg","ovpn/server","ppp_settings","wireless/ww2-prule","wireless/radio/settings","dhcp/relay6routes","reverse-proxy/rules"];

export const RUBRIKEN = Object.fromEntries(NAMEN.map((n) => [n, rubrikFuer(n)]));

// --- Versions-Erkennung ---------------------------------------------------
// Merkmale: Store-Datei -> {feature, version, sicher}. Die Datei existiert erst,
// wenn die Firmware das Feature kennt -> Mindestversion = höchste gefundene Grenze.
// Quellen siehe SPEZIFIKATION.md (Abschnitt Versions-Erkennung).
const MERKMALE = [
  { test: (n) => n === 'iface-wireguard' || n === 'net/wireguard', feature: 'WireGuard', version: '7.1', sicher: true },
  { test: (n) => n.startsWith('bth/'), feature: 'Back To Home', version: '7.12', sicher: true },
  { test: (n) => n.startsWith('wireless/ww2-') || n.startsWith('ww2-'), feature: 'WifiWave2 (natives WiFi)', version: '7.13', sicher: false },
  { test: (n) => n === 'resolver/adlist', feature: 'DNS Adlist', version: '7.15', sicher: false },
  { test: (n) => n === 'resolver/forwarders', feature: 'DNS Forwarders', version: '7.15', sicher: false },
  { test: (n) => n === 'reverse-proxy/rules', feature: 'Reverse Proxy', version: '7.22', sicher: false },
];

function versionVergleich(a, b) { // "7.15" vs "7.22" -> -1/0/1
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function versionErkennen(backup) {
  const hinweise = [];
  let hauptversion = 'unbekannt';

  if (backup.verschluesselt) {
    hinweise.push('Backup ist verschlüsselt (Magic 0x' + backup.magic.toString(16) +
      ') – Inhalt erst nach Entschlüsselung lesbar.');
    return { hauptversion, hinweise };
  }

  // 1) Kernel-String aus system-hw: ROS7 = Linux 5.6.x, ROS6 = Linux 3.3.x
  const hw = backup.eintraege.find((e) => e.name === 'system-hw');
  if (hw) {
    let gefunden = null;
    for (const s of hw.saetze) {
      for (const f of s.felder) {
        if ((f.typ === 0x20 || f.typ === 0x21) && typeof f.wert === 'string') {
          const m = f.wert.match(/Linux\s+(\d+)\.(\d+)\.(\d+)/);
          if (m) { gefunden = m; break; }
        }
      }
      if (gefunden) break;
    }
    if (gefunden) {
      const kernMajor = Number(gefunden[1]);
      if (kernMajor >= 5) { hauptversion = '7'; hinweise.push('Kernel "' + gefunden[0] + '" in system-hw → RouterOS 7 (v7 nutzt Linux 5.6.x).'); }
      else if (kernMajor === 3) { hauptversion = '6'; hinweise.push('Kernel "' + gefunden[0] + '" in system-hw → RouterOS 6 (v6 nutzt Linux 3.3.x).'); }
    }
  }

  // 2) Vorhandene Store-Dateien als Versionsuntergrenzen
  const namen = new Set(backup.eintraege.map((e) => e.name));
  let mindestversion;
  for (const m of MERKMALE) {
    const treffer = [...namen].some((n) => m.test(n));
    if (treffer) {
      hinweise.push('Eintrag für "' + m.feature + '" vorhanden → mindestens RouterOS ' + m.version +
        (m.sicher ? '' : ' (Grenze unsicher)') + '.');
      if (!mindestversion || versionVergleich(m.version, mindestversion) > 0) mindestversion = m.version;
    }
  }

  // Wenn v7-Dateien vorhanden sind, aber Kernel unklar war
  if (hauptversion === 'unbekannt' && mindestversion) hauptversion = '7';

  const ergebnis = { hauptversion, hinweise };
  if (mindestversion) {
    ergebnis.mindestversion = '7.x (≥ ' + mindestversion + ')';
    hinweise.push('Höchste Merkmalsgrenze = ' + mindestversion + ' → Mindestversion rund ' + mindestversion +
      '. Der genaue Patch-Stand (z.B. 7.24.x) steht NICHT als Text im Backup.');
  }
  return ergebnis;
}
