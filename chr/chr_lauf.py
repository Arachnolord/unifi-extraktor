#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# FAH-Extraktor · Urheber: Fabian Hammer
#
# chr_lauf.py – steuert die MikroTik-Vorschau im Wegwerf-Container: RouterOS CHR
# unter QEMU/KVM booten, das Kundenbackup (.backup) oder den Export (.rsc, Beta)
# einspielen, den Zugang zu WebFig einrichten und den Router am Leben halten.
#
# Eingabe: /auftrag/auftrag.json (Env AUFTRAG) + /auftrag/kunde.backup|kunde.rsc, vom
# Backend per Archiv-Upload abgelegt. Der Auftrag wird nach dem Lesen gelöscht, die
# Kundendatei nach dem Bau der Lieferplatte.
#
# Ausgabe auf stdout NUR Marker-Zeilen (das Backend liest sie aus den Container-Logs):
#   FAH-SCHRITT <starten|einspielen|anmelden> <laeuft|fertig|fehler> [Detail]
#   FAH-INFO <Hinweis für den Benutzer>
#   FAH-STAND <json>      Zwischenstand (identitaet, routerosVersion, wwwPort, schema, kvm, ...)
#   FAH-BEREIT <json>     Endstand; danach läuft der Router, bis der Container endet
#   FAH-KONSOLE <zeile>   bei Fehlern die letzten (maskierten) Konsolenzeilen
#   FAH-FEHLER <text>     danach Exit-Code 1
# Geheimnisse (Kundenpasswort, Wegwerfpasswort) erscheinen nirgends: Marker werden
# maskiert, das Konsolenprotokoll liegt maskiert unter /tmp/fah-chr/konsole.log.
#
# Netzarchitektur (im NAS-Vorversuch belegt, 10.10.2026):
# - Zustellung über eine zweite virtio-Platte (FAT32 ohne Partitionstabelle); RouterOS
#   hängt sie automatisch ein (z. B. "pcie1/kunde.backup") - kein Netz nötig.
# - Verwaltungs-NIC (02:FA:48:00:00:01) als slirp mit restrict=on: der Gast erreicht
#   weder Container noch Internet; QEMU-hostfwd 127.0.0.1:8080 -> Router-IP:www-Port
#   plus ein TCP-Relay 0.0.0.0:80 -> 127.0.0.1:8080, weil ein hostfwd auf 0.0.0.0 von
#   anderen Containern nicht erreichbar ist. Das Backend prüft http://<container>:80/.
# - Lokaler Zugang: Verwaltungs-NIC wird Port der Bridge mit der Zugangs-IP.
#   Zugang über ein Ethernet oder den WAN-Uplink (DHCP): QEMU beenden und DIESELBE
#   Platte neu starten, der slirp hängt dann an der NIC mit der MAC des Kundenports.

import os, re, sys, json, time, struct, socket, shutil, signal, base64, threading, subprocess, ipaddress, ssl
import urllib.request, urllib.error
import pexpect

AUFTRAG_DATEI = os.environ.get('AUFTRAG', '/auftrag/auftrag.json')
ARBEIT = '/tmp/fah-chr'
KONSOLEN_LOG = f'{ARBEIT}/konsole.log'
MAC_VERW = '02:FA:48:00:00:01'
LOGIN_OPT = '+ct999w'           # c=keine Farben, t=keine Terminal-Erkennung, 999w=Breite (Option "e" zeichnet Zeilen mehrfach neu)
HOSTFWD_PORT = 8080             # QEMU-hostfwd (nur Loopback)
RELAY_PORT = 80                 # Relay für das Vorschau-Netz
WAN_ERSATZNETZE = ['192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24', '100.64.0.0/24', '10.254.254.0/24']
T_START = time.monotonic()
GEHEIM = []                     # wird nach dem Lesen des Auftrags gefüllt
FAKTOR = 1                      # Zeitlimits x3 ohne KVM
ANSI = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]|\x1b[c()=>78]')
GEHEIM_MUSTER = re.compile(r'(?i)(password|passwd|secret|key|psk|passphrase|community|wpa2-pre-shared-key)=("[^"]*"|\S+)')


class Abbruch(Exception):
    """Klarer Fehlertext für den Benutzer (wird als FAH-FEHLER gemeldet)."""


# ---------------------------------------------------------------- Ausgabe (nur Marker, immer maskiert)
def maskiert(s):
    s = str(s)
    for g in GEHEIM:
        s = s.replace(g, '***')
    return GEHEIM_MUSTER.sub(r'\1=***', s)


def marker(art, text=''):
    print(maskiert(f'FAH-{art} {text}').rstrip(), flush=True)


def schritt(key, status, detail=''):
    marker('SCHRITT', f'{key} {status} {detail}'.rstrip())


def info(text):
    marker('INFO', text)


def stand(**felder):
    marker('STAND', json.dumps(felder, ensure_ascii=False))


def sek(t0=None):
    return round(time.monotonic() - (T_START if t0 is None else t0), 1)


def limit(sekunden):
    return sekunden * FAKTOR


def sauber(s):
    return ANSI.sub('', s).replace('\r', '')


def kurz(text, n=300):
    return ' | '.join(z.strip() for z in text.splitlines() if z.strip())[-n:]


def ros_string(s):
    """Wert für einen RouterOS-String in Anführungszeichen: \\ " und $ (Interpolation) escapen."""
    return str(s).replace('\\', '\\\\').replace('"', '\\"').replace('$', '\\$')


# ---------------------------------------------------------------- Backup lesen (Port-MACs in Reihenfolge)
def backup_lesen(pfad):
    b = open(pfad, 'rb').read()
    magic = struct.unpack_from('<I', b, 0)[0]
    art = {0xB1A1AC88: 'unverschlüsselt', 0x7291A8EF: 'RC4-verschlüsselt', 0x7391A8EF: 'AES-verschlüsselt'}.get(magic, f'unbekannt 0x{magic:08X}')
    nics, gesehen, pos = [], set(), 8
    if art == 'unverschlüsselt':
        while pos + 4 <= len(b):
            n = struct.unpack_from('<I', b, pos)[0]; name = b[pos + 4:pos + 4 + n]; pos += 4 + n
            if pos + 4 > len(b): break
            il = struct.unpack_from('<I', b, pos)[0]; pos += 4 + il
            if pos + 4 > len(b): break
            dl = struct.unpack_from('<I', b, pos)[0]; dat = b[pos + 4:pos + 4 + dl]; pos += 4 + dl
            if name == b'net/devices':
                for rec in dat.split(b'M2')[1:]:
                    m = re.search(rb'([a-z][a-z0-9-]{1,30})[^\n]{0,40}?([0-9a-f]{2}(?::[0-9a-f]{2}){5})', rec)
                    if m and m.group(2) not in gesehen:
                        gesehen.add(m.group(2)); nics.append((m.group(1).decode(), m.group(2).decode().upper()))
    return art, nics


# ---------------------------------------------------------------- Lieferplatte (FAT32 ohne Partitionstabelle)
def lauf(cmd, env=None):
    r = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if r.returncode:
        raise Abbruch(f'{cmd[0]} scheiterte (rc={r.returncode}): {(r.stderr or r.stdout).strip()[:200]}')
    return r.stdout


def fat_bauen(quelle, zielname):
    mib = max(128, os.path.getsize(quelle) // (1024 * 1024) + 8)
    img = f'{ARBEIT}/lieferung.img'
    with open(img, 'wb') as f:
        f.truncate(mib * 1024 * 1024)
    env = {**os.environ, 'MTOOLS_SKIP_CHECK': '1'}
    lauf(['mkfs.vfat', '-F', '32', '-n', 'FAHDATEN', img], env)
    lauf(['mcopy', '-i', img, quelle, f'::/{zielname}'], env)
    return img


# ---------------------------------------------------------------- slirp-Netz
def slirp_netz(netz_text, ausser=()):
    """Liefert (netz, gegenstelle, dhcpstart): Gegenstelle = vorletzte nutzbare Adresse (wie belegt),
    DHCP-Start weiter unten; Adressen aus "ausser" (z. B. die Router-IP) werden gemieden. Rechnet
    mit Zahlen statt Hostlisten, damit auch ein /16 nichts kostet."""
    netz = ipaddress.ip_network(netz_text, strict=False)
    if netz.version != 4 or netz.prefixlen > 30:
        raise Abbruch(f'Das Netz {netz} ist zu klein für den Vorschau-Zugang.')
    erster, letzter = int(netz.network_address) + 1, int(netz.broadcast_address) - 1
    tabu = {str(a) for a in ausser if a}
    def frei_ab(start, richtung):
        a = start
        while erster <= a <= letzter:
            if str(ipaddress.ip_address(a)) not in tabu: return str(ipaddress.ip_address(a))
            a += richtung
        return None
    gegenstelle = frei_ab(letzter - 1, -1) or frei_ab(letzter, -1)
    if not gegenstelle: raise Abbruch(f'Im Netz {netz} ist keine Adresse für den Vorschau-Zugang frei.')
    tabu.add(gegenstelle)
    dhcp = (frei_ab(letzter - 12, -1) if letzter - 12 > erster + 2 else None) or frei_ab(erster, 1) or gegenstelle
    return str(netz), gegenstelle, dhcp


def slirp_netdev(netz, gegenstelle, dhcp):
    return f'user,id=mg,net={netz},host={gegenstelle},dhcpstart={dhcp},ipv6=off,restrict=on'


def wan_netz_waehlen(dienst, belegte_netze):
    """slirp-Netz für den WAN-Neustart: aus available-from des Dienstes (muss die Gegenstelle zulassen),
    ohne Überlappung mit Adressen und Routen des Routers (sonst gingen Antworten in einen Tunnel statt
    zum Uplink); sonst ein Ersatznetz (dann wird der Dienst freigeschaltet)."""
    belegt = []
    for text in belegte_netze:
        try: belegt.append(ipaddress.ip_network(text, strict=False))
        except ValueError: pass
    def passt(n):
        return n.version == 4 and 16 <= n.prefixlen <= 28 and not any(n.overlaps(b) for b in belegt)
    for text in (dienst['available_from'] if dienst else []):
        try: n = ipaddress.ip_network(text, strict=False)
        except ValueError: continue
        if passt(n): return str(n), True
    for text in WAN_ERSATZNETZE:
        n = ipaddress.ip_network(text)
        if passt(n): return str(n), False
    raise Abbruch('Kein freies Netz für den WAN-Zugang gefunden.')


# ---------------------------------------------------------------- Dienste (/ip service print terse)
def terse_zeile(z):
    """Eine Zeile aus "print terse" -> (flags, {schlüssel: wert}) oder None. RouterOS schreibt
    Kommentare VOR die übrigen Felder ("0 comment=main local address=…"), Werte können Leerzeichen
    enthalten - darum reicht jeder Wert bis zum nächsten "schlüssel="."""
    m = re.match(r'^\s*\d+\s+(.*)$', z)
    if not m: return None
    rest = m.group(1).rstrip()
    treffer = list(re.finditer(r'(?:^|(?<=\s))([a-z][a-z0-9-]*)=', rest))
    if not treffer: return None
    felder = {}
    for i, t in enumerate(treffer):
        ende = treffer[i + 1].start() if i + 1 < len(treffer) else len(rest)
        felder[t.group(1)] = rest[t.end():ende].strip().strip('"')
    return rest[:treffer[0].start()].strip(), felder


def dienste_parsen(text):
    """-> {name: {port, proto, disabled, dynamic, available_from:[...]}}; ältere 7.x schreiben address= statt available-from=."""
    dienste = {}
    for z in text.splitlines():
        t = terse_zeile(z)
        if not t or not t[1].get('name'): continue
        flags, felder = t
        name = felder['name']
        liste = felder.get('available-from', felder.get('address', '')) or ''
        eintrag = {'port': int(felder['port']) if felder.get('port', '').isdigit() else None, 'proto': felder.get('proto', 'tcp'),
                   'disabled': 'X' in flags, 'dynamic': 'D' in flags, 'available_from': [a for a in liste.split(',') if a]}
        if name not in dienste or (dienste[name]['dynamic'] and not eintrag['dynamic']): dienste[name] = eintrag
    return dienste


def dienst_erlaubt(dienst, ip):
    if not dienst or not dienst['available_from']: return True
    a = ipaddress.ip_address(ip)
    for n in dienst['available_from']:
        try:
            if a in ipaddress.ip_network(n, strict=False): return True
        except ValueError: pass
    return False


def webfig_dienst(dienste):
    """www (http) bevorzugt, sonst www-ssl (https, selbstsigniert) -> (name, port, schema) oder None."""
    for name, schema, standard in (('www', 'http', 80), ('www-ssl', 'https', 443)):
        d = dienste.get(name)
        if d and not d['disabled']: return name, d['port'] or standard, schema
    return None


# ---------------------------------------------------------------- Konsolen-Log mit Maskierung
class MaskLog:
    def __init__(self, pfad):
        self.f = open(pfad, 'a')
    def write(self, s):
        self.f.write(maskiert(s))
    def flush(self):
        self.f.flush()


# ---------------------------------------------------------------- QEMU-Monitor (HMP über Unix-Socket)
def monitor(befehl, warte=10):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(warte); s.connect(f'{ARBEIT}/mon.sock')
    def bis_prompt():
        puffer = b''
        while not puffer.endswith(b'(qemu) '):
            teil = s.recv(4096)
            if not teil: break
            puffer += teil
        return puffer.decode('utf-8', 'replace')
    bis_prompt(); s.sendall(befehl.encode() + b'\n'); aus = bis_prompt(); s.close()
    aus = ANSI.sub('', aus).split('\r')[-1].replace('(qemu) ', '')   # HMP wiederholt die Eingabe zeichenweise
    return re.sub(r'^\s*' + re.escape(befehl) + r'\s*', '', aus).strip()


# ---------------------------------------------------------------- Serielle Konsole
class Konsole:
    PROMPT = r'\] > '
    PAGER = r'-- \[Q quit\|D dump'

    def __init__(self, q):
        self.q = q; self.n = 0

    def warte_login(self, warte=300):
        i = self.q.expect([r'Login: ', pexpect.EOF], timeout=warte)
        if i == 1: raise Abbruch('Der virtuelle Router ist beendet, bevor die Anmeldung erschien.')

    def login(self, name, pw, neu=None, warte=120):
        """Anmeldung; behandelt Lizenzfrage, Passwort-Änderungspflicht (neu=... setzt es, sonst Ctrl-C) und Fehlschlag."""
        self.q.sendline(name + LOGIN_OPT)
        self.q.expect(r'Password: ', timeout=30); self.q.sendline(pw)
        while True:
            # Die Konsole zeichnet Eingabezeilen mehrfach neu; "repeat new password> " enthält "new password> ".
            i = self.q.expect([self.PROMPT, r'\[Y/n\]', r'(?<!repeat )new password> ', r'Login failed', r'Login: ', pexpect.EOF], timeout=warte)
            if i == 0:
                time.sleep(0.5); self.q.expect([self.PROMPT, pexpect.TIMEOUT], timeout=1); return True
            if i == 1: self.q.sendline('n')
            elif i == 2:
                if neu:
                    self.q.sendline(neu); self.q.expect(r'repeat new password> ', timeout=30); self.q.sendline(neu)
                    self.q.expect(r'Password changed', timeout=30)
                else:
                    self.q.send('\x03')   # Ctrl-C: Passwortänderung überspringen
            elif i in (3, 4): return False
            else: raise Abbruch('Der virtuelle Router ist während der Anmeldung beendet worden.')

    def befehl(self, c, warte=60):
        """Befehl zwischen Marken ausführen; Fehler des Befehls kommen als Zeile "FAH-FEHLER ..." zurück (:onerror, nur RouterOS 7)."""
        self.n += 1; a, e = f'FAH<A{self.n}>', f'FAH<E{self.n}>'
        self.q.sendline(f':put "{a}"; :onerror fehler in={{ {c} }} do={{ :put "FAH-FEHLER $fehler" }}; :put "{e}"')
        self.q.expect(rf'(?<![^\r\n]){re.escape(a)}\r*\n', timeout=warte)
        aus = ''
        while True:   # (?<![^\r\n]) = Zeilenanfang - die Endmarke folgt bei Befehlen ohne Ausgabe direkt
            i = self.q.expect([rf'(?<![^\r\n]){re.escape(e)}\r*\n', self.PAGER, pexpect.TIMEOUT, pexpect.EOF], timeout=warte)
            aus += self.q.before
            if i == 0: break
            if i == 1: self.q.send('d'); continue      # Seitenumbruch: "D dump" = Rest ohne Pause ausgeben
            if i == 3: raise Abbruch('Der virtuelle Router hat sich beendet.')
            raise Abbruch(f'Die Konsole antwortet nicht mehr (Befehl: {c[:60]}).')
        self.q.expect(self.PROMPT, timeout=30)
        return sauber(aus).strip('\n')

    def wert(self, c, warte=60):
        return ' '.join(z.strip() for z in self.befehl(c, warte).splitlines() if z.strip())

    def fehlerfrei(self, c, warte=60):
        """Wie befehl(); liefert (ok, ausgabe) - ok=False bei FAH-FEHLER des Routers."""
        aus = self.befehl(c, warte)
        m = re.search(r'FAH-FEHLER (.*)', aus)
        return (False, m.group(1).strip()) if m else (True, aus)

    def leeren(self, warte=0.3):
        """Restpuffer verwerfen (Prompt-Wiederholungen); nötig vor Befehlen mit Rückfrage."""
        self.q.expect(pexpect.TIMEOUT, timeout=warte); self.q.buffer = ''

    def neustart(self, warte=300):
        self.leeren(); self.q.sendline('/system reboot')
        if self.q.expect([r'\[y/N\]', pexpect.TIMEOUT], timeout=30) == 0: self.q.sendline('y')
        self.q.expect(r'Login: ', timeout=warte)

    def backup_laden(self, name, passwort='', warte_neustart=300):
        """/system backup load mit Rückfrage; liefert (neustart_gesehen, meldung). Die Rückfrage muss binnen 30 s kommen,
        sonst gilt der Text als Fehlermeldung (die Konsole wiederholt Prompts, daher keine Prompt-Erkennung)."""
        self.leeren()
        self.q.sendline(f'/system backup load name="{name}" password="{ros_string(passwort)}"')
        i = self.q.expect([r'\[y/N\]', pexpect.TIMEOUT, pexpect.EOF], timeout=30)
        if i != 0: return False, sauber(self.q.before).strip()[-400:]
        self.q.sendline('y')
        i = self.q.expect([r'Login: ', r'Failed to restore[^\r\n]*', pexpect.EOF, pexpect.TIMEOUT], timeout=warte_neustart)
        meldung = sauber(self.q.before + (self.q.after if isinstance(self.q.after, str) else '')).strip()
        if i == 1:
            self.q.expect([r'failure:[^\r\n]*', pexpect.TIMEOUT], timeout=10)
            meldung += ' | ' + sauber(self.q.after if isinstance(self.q.after, str) else '').strip()
        return i == 0, meldung


# ---------------------------------------------------------------- HTTP (WebFig/REST über hostfwd) und Relay
def http_hole(url, auth=None, warte=8):
    req = urllib.request.Request(url, headers={'User-Agent': 'FAH-Extraktor'})
    if auth: req.add_header('Authorization', 'Basic ' + base64.b64encode(f'{auth[0]}:{auth[1]}'.encode()).decode())
    kontext = ssl._create_unverified_context() if url.startswith('https') else None
    try:
        with urllib.request.urlopen(req, timeout=warte, context=kontext) as r:
            return r.status, r.read(6000).decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read(500).decode('utf-8', 'replace')
    except Exception as e:
        return None, repr(e)


def webfig_pruefen(url, dauer):
    """Bis zu "dauer" Sekunden alle 3 s: 200 mit RouterOS/WebFig im Inhalt."""
    t = time.monotonic(); status, body = None, ''
    while True:
        status, body = http_hole(url)
        if status == 200 and ('webfig' in body.lower() or 'routeros' in body.lower()): return True, status
        if time.monotonic() - t > dauer: return False, status
        time.sleep(3)


def relay_starten(port_aussen, port_innen):
    """TCP-Weiterleitung 0.0.0.0:port_aussen -> 127.0.0.1:port_innen (asyncio in einem Thread). Ein hostfwd auf
    0.0.0.0 reicht die Absenderadresse anderer Container ungeändert an den Gast - der Router kann sie nicht
    beantworten; Verbindungen von 127.0.0.1 schreibt slirp auf seine Gateway-Adresse um."""
    import asyncio
    async def verbinde(leser, schreiber):
        try:
            zl, zs = await asyncio.open_connection('127.0.0.1', port_innen)
        except Exception:
            schreiber.close(); return
        async def pumpe(a, b):
            try:
                while True:
                    d = await a.read(65536)
                    if not d: break
                    b.write(d); await b.drain()
            except Exception: pass
            finally:
                try: b.close()
                except Exception: pass
        await asyncio.gather(pumpe(leser, zs), pumpe(zl, schreiber))
    async def haupt():
        srv = await asyncio.start_server(verbinde, '0.0.0.0', port_aussen, reuse_address=True)
        async with srv: await srv.serve_forever()
    threading.Thread(target=lambda: asyncio.run(haupt()), daemon=True).start()


# ---------------------------------------------------------------- QEMU
def qemu_args(platte, nics, kvm, ram, extra_drives=()):
    """nics = [(mac, netdev|None)] in PCI-Reihenfolge; None = toter Hub-Port (eigener Hub je Port: kein Verkehr, keine Schleife)."""
    args = (['-enable-kvm', '-cpu', 'host'] if kvm else ['-accel', 'tcg', '-cpu', 'qemu64']) + \
           ['-m', str(ram), '-smp', '1', '-display', 'none', '-vga', 'none', '-parallel', 'none',
            '-chardev', 'stdio,id=ser0,signal=off', '-serial', 'chardev:ser0', '-monitor', f'unix:{ARBEIT}/mon.sock,server,nowait', '-boot', 'c',
            '-drive', f'file={platte},if=virtio,format=qcow2,cache=unsafe']
    for d in extra_drives: args += ['-drive', f'file={d},if=virtio,format=raw,cache=unsafe']
    for i, (mac, netdev) in enumerate(nics):
        if netdev: args += ['-netdev', netdev, '-device', f'virtio-net-pci,netdev=mg,mac={mac},romfile=']
        else:      args += ['-netdev', f'hubport,id=h{i},hubid={i + 1}', '-device', f'virtio-net-pci,netdev=h{i},mac={mac},romfile=']
    return args


def qemu_start(args):
    try: os.unlink(f'{ARBEIT}/mon.sock')
    except FileNotFoundError: pass
    q = pexpect.spawn('sh', ['-c', f'exec qemu-system-x86_64 "$@" 2>>{ARBEIT}/qemu.err', 'qemu'] + args,
                      encoding='utf-8', codec_errors='replace', timeout=180, maxread=65536)
    q.logfile_read = MaskLog(KONSOLEN_LOG)
    q.linesep = '\r'   # Enter = CR wie an einem echten Terminal (7.16 nimmt "\n" am Passwort-Prompt nicht)
    return q, Konsole(q)


def qemu_beenden(q):
    if q is None: return
    try: monitor('quit', 5)
    except Exception: pass
    try: q.expect(pexpect.EOF, timeout=20)
    except Exception: pass
    try: q.terminate(force=True)
    except Exception: pass


def qemu_stderr():
    try: text = open(f'{ARBEIT}/qemu.err').read()
    except Exception: return ''
    return '\n'.join(z for z in text.splitlines() if 'hub' not in z and z.strip())


# ---------------------------------------------------------------- Router-Abfragen
def ethernet_warten(k, anzahl, dauer):
    t = time.monotonic()
    while True:
        n = k.wert(':put [:len [/interface ethernet find]]')
        if n.isdigit() and int(n) >= anzahl: return int(n), True
        if time.monotonic() - t > dauer: return (int(n) if n.isdigit() else -1), False
        time.sleep(2)


def ethernet_name(k, mac):
    name = k.wert(f':put [/interface ethernet get [find mac-address={mac}] name]')
    return None if ('FAH-FEHLER' in name or not name) else name


def ethernet_mac(k, name):
    m = re.search(r'mac-address=([0-9A-Fa-f:]{17})', k.befehl(f'/interface ethernet print terse where name="{ros_string(name)}"'))
    return m.group(1).upper() if m else None


def ist_bridge(k, name):
    return 'name=' in k.befehl(f'/interface bridge print terse where name="{ros_string(name)}"')


def ist_vlan(k, name):
    return 'name=' in k.befehl(f'/interface vlan print terse where name="{ros_string(name)}"')


def ist_hotspot(k, name):
    return 'interface=' in k.befehl(f'/ip hotspot print terse where interface="{ros_string(name)}"')


def adressen_lesen(k):
    """-> Liste (adresse/prefix, interface, flags) aus /ip address print terse."""
    liste = []
    for z in k.befehl('/ip address print terse').splitlines():
        t = terse_zeile(z)
        if t and t[1].get('address') and t[1].get('interface'): liste.append((t[1]['address'], t[1]['interface'], t[0]))
    return liste


def routen_lesen(k):
    """Zielnetze aller Routen (ohne Standardroute) - Netze, die der Router woanders hin schickt."""
    netze = []
    for m in re.finditer(r'dst-address=(\S+)', k.befehl('/ip route print terse', 90)):
        if m.group(1) != '0.0.0.0/0': netze.append(m.group(1))
    return netze


def dhcp_client_lesen(k):
    """Schnittstelle des ersten aktiven DHCP-Clients oder None."""
    for z in k.befehl('/ip dhcp-client print terse').splitlines():
        m = re.match(r'^\s*\d+\s+([A-Z ]*?)\s*interface=(\S+)', z)
        if m and 'X' not in m.group(1): return m.group(2)
    return None


def bridge_ethernet_port(k, bridge):
    """Erster aktiver Ethernet-Port einer Bridge -> (name, mac) oder (None, None)."""
    for z in k.befehl(f'/interface bridge port print terse where bridge="{ros_string(bridge)}"', 90).splitlines():
        m = re.match(r'^\s*\d+\s+([A-Z ]*?)\s*interface=(\S+)', z)
        if not m or 'X' in m.group(1) or m.group(2).startswith('*'): continue
        mac = ethernet_mac(k, m.group(2))
        if mac: return m.group(2), mac
    return None, None


def fat_datei_finden(k, name, dauer):
    """Pfad der gelieferten Datei unter /file (z. B. pcie1/kunde.backup); die Platte braucht nach dem Boot einen Moment."""
    t = time.monotonic()
    while True:
        dateien = k.befehl('/file print terse', 60)
        m = re.search(r'name=(\S*' + re.escape(name) + r')', dateien)
        if m: return m.group(1)
        if time.monotonic() - t > dauer: raise Abbruch('Die Lieferplatte mit der Kundendatei ist im Router nicht sichtbar.')
        time.sleep(2)


def rsc_zeile(pfad, nummer):
    try:
        zeilen = open(pfad, encoding='utf-8', errors='replace').read().splitlines()
        return zeilen[nummer - 1].strip()[:160] if 0 < nummer <= len(zeilen) else ''
    except Exception:
        return ''


# ---------------------------------------------------------------- Hauptablauf
class Lauf:
    def __init__(self):
        self.q = None; self.k = None


def haupt(L):
    global FAKTOR
    with open(AUFTRAG_DATEI, encoding='utf-8') as f: auftrag = json.load(f)
    os.remove(AUFTRAG_DATEI)
    dateiart = auftrag.get('dateiart'); rsc = dateiart == 'rsc'
    datei = auftrag['datei']; version = str(auftrag['chrVersion'])
    benutzer = str(auftrag.get('benutzer') or 'admin'); passwort = str(auftrag.get('passwort') or '')
    wegwerf = str(auftrag['wegwerfPasswort']); zugang = auftrag.get('zugang') or {}
    modus = zugang.get('modus'); ram = int(auftrag.get('ramMb') or 384); kvm = bool(auftrag.get('kvm', True))
    # Die Konsole zeigt Passwörter nie an; maskiert wird ab 3 Zeichen (kürzere würden jede Ausgabe zerhacken).
    GEHEIM[:] = [g for g in (passwort, wegwerf) if len(g) >= 3]
    if dateiart not in ('backup', 'rsc') or modus not in ('lokal', 'wan'): raise Abbruch('Auftrag unvollständig.')
    if not re.fullmatch(r'7\.\d{1,2}(\.\d{1,2})?(rc\d+|beta\d+)?', version): raise Abbruch('Ungültige RouterOS-Version.')
    img = f'/cache/chr-{version}.img'
    if not os.path.exists(img): raise Abbruch(f'Das RouterOS-Image chr-{version}.img fehlt im Cache.')
    if kvm and not os.access('/dev/kvm', os.R_OK | os.W_OK):
        kvm = False; info('ohne KVM – deutlich langsamer (/dev/kvm im Container nicht nutzbar)')
    FAKTOR = 1 if kvm else 3
    stand(kvm=kvm)
    shutil.rmtree(ARBEIT, ignore_errors=True); os.makedirs(ARBEIT)

    # Kundendatei lesen, Lieferplatte bauen, Datei im Auftragsordner löschen
    if rsc:
        ports = [p for p in (auftrag.get('ports') or []) if isinstance(p, str) and re.fullmatch(r'[a-z0-9-]{1,30}', p)][:32]
        kunden = [(f'02:FA:48:00:01:{i + 1:02X}', None) for i in range(len(ports))]
        zielname = 'kunde.rsc'
    else:
        art, nics = backup_lesen(datei)
        if art != 'unverschlüsselt': raise Abbruch(f'Das Backup ist {art} – nur unverschlüsselte Backups lassen sich virtuell öffnen.')
        ports = [n for n, _ in nics]
        kunden = [(m, None) for _, m in nics]
        zielname = 'kunde.backup'
    lieferung = fat_bauen(datei, zielname)
    if not rsc:
        try: os.remove(datei)
        except OSError: pass
    platte = f'{ARBEIT}/platte.qcow2'
    lauf(['qemu-img', 'create', '-q', '-f', 'qcow2', '-b', img, '-F', 'raw', platte])

    # NIC-Liste: Verwaltungs-NIC beim Backup zuerst (ether1), beim Export zuletzt (die Export-Zeilen
    # "set [ find default-name=etherN ]" zählen die Kundenports ab ether1).
    lan_netz = f"{zugang.get('ip')}/{zugang.get('prefix')}" if modus == 'lokal' else '10.0.2.0/24'
    netz, gegenstelle, dhcp = slirp_netz(lan_netz, [zugang.get('ip')])
    netdev = slirp_netdev(netz, gegenstelle, dhcp)
    nic_liste = (kunden + [(MAC_VERW, netdev)]) if rsc else ([(MAC_VERW, netdev)] + kunden)

    # ---- starten
    schritt('starten', 'laeuft', f'RouterOS {version} bootet ({len(kunden)} Ports{"" if kvm else ", ohne KVM"})')
    t0 = time.monotonic()
    L.q, L.k = qemu_start(qemu_args(platte, nic_liste, kvm, ram, [lieferung]))
    k = L.k
    k.warte_login(limit(120))
    if not k.login('admin', '', neu=wegwerf, warte=limit(120)): raise Abbruch('Die Anmeldung am frischen Router ist fehlgeschlagen.')
    schritt('starten', 'fertig', f'nach {sek(t0)} s')

    # ---- einspielen
    schritt('einspielen', 'laeuft', 'Lieferplatte wird gesucht')
    pfad = fat_datei_finden(k, zielname, limit(30))
    t1 = time.monotonic()
    if rsc:
        schritt('einspielen', 'laeuft', 'Export wird importiert (Beta)')
        k.befehl('/ip dhcp-client remove [find]')
        for i, name in enumerate(ports):
            if name != f'ether{i + 1}':
                k.befehl(f'/interface ethernet set [find default-name=ether{i + 1}] name="{name}"')
        ok, aus = k.fehlerfrei(f'/import file-name="{pfad}"', limit(300))
        if not ok:
            m = re.search(r'line (\d+)', aus)
            zeile = rsc_zeile(datei, int(m.group(1))) if m else ''
            raise Abbruch(f'Der Import bricht ab: {aus[:200]}' + (f' – Zeile {m.group(1)}: {zeile}' if zeile else '') + ' (.backup bevorzugen)')
        try: os.remove(datei)
        except OSError: pass
        schritt('einspielen', 'fertig', f'Export importiert nach {sek(t1)} s')
        schritt('anmelden', 'laeuft', 'Zugang wird eingerichtet')
    else:
        schritt('einspielen', 'laeuft', 'Backup wird eingespielt, Router startet neu')
        neustart, meldung = k.backup_laden(pfad, '', limit(300))
        if not neustart: raise Abbruch(f'Das Backup ließ sich nicht laden: {kurz(meldung, 200)}')
        schritt('einspielen', 'fertig', f'Neustart nach {sek(t1)} s')
        schritt('anmelden', 'laeuft', f'Anmeldung als {benutzer}')
        if not k.login(benutzer, passwort, warte=limit(120)):
            raise Abbruch(f'Der Router lehnt den Zugang „{benutzer}“ ab – Benutzer und Passwort prüfen (Benutzerverwaltung → Standard-Zugang MikroTik).')

    # ---- Schnittstellen, Scheduler, Daten
    n_eth, voll = ethernet_warten(k, len(nic_liste), limit(30))
    if not voll: info(f'Schnittstellen fehlen nach dem Einspielen ({n_eth} von {len(nic_liste)}) – RouterOS-Eigenheit, meist deaktivierte SFP-Ports.')
    ok, _ = k.fehlerfrei('/system scheduler disable [find]; /system script job remove [find where type="script"]')  # nie [find]: die eigene Konsolen-Anmeldung ist auch ein Job (type=login)
    if ok: info('Scheduler und laufende Skripte angehalten – Kundenskripte würden die Vorschau verändern.')
    else: info('Scheduler konnte nicht angehalten werden – Kundenskripte können die Vorschau verändern.')
    identitaet = re.sub(r'^name:\s*', '', k.wert('/system identity print')).strip()
    m = re.search(r'version:\s*(\S+(?: \([^)]*\))?)', k.befehl('/system resource print'))
    ros_version = m.group(1) if m else None
    stand(identitaet=identitaet, routerosVersion=ros_version)
    dienste = dienste_parsen(k.befehl('/ip service print terse'))
    wahl = webfig_dienst(dienste)
    if not wahl:
        ok, _ = k.fehlerfrei('/ip service set www disabled=no')
        dienste = dienste_parsen(k.befehl('/ip service print terse')); wahl = webfig_dienst(dienste)
        if not wahl: raise Abbruch('Weder www noch www-ssl ist aktiv, und www ließ sich nicht einschalten.')
        info('Der www-Dienst war deaktiviert und wurde für die Vorschau eingeschaltet.')
    dienst_name, www_port, schema = wahl
    dienst = dienste[dienst_name]
    adressen = adressen_lesen(k)
    stand(wwwPort=www_port, schema=schema)

    # ---- Zugang einrichten
    name_verw = ethernet_name(k, MAC_VERW)
    zugangs_iface = name_verw
    traeger = None; ziel_ip = None; neustart_mac = None; neustart_netz = None
    neu_gestartet = False
    for versuch in (1, 2):
        if modus == 'lokal':
            ziel_ip = zugang['ip']
            adr = k.befehl(f'/ip address print terse where address~"^{ziel_ip}/"')
            t = next((t for t in map(terse_zeile, adr.splitlines()) if t and t[1].get('address', '').startswith(f'{ziel_ip}/') and t[1].get('interface')), None)
            if not t: raise Abbruch(f'Die Zugangs-Adresse {ziel_ip} gibt es nach dem Einspielen nicht – andere Adresse wählen.')
            flags, traeger = t[0], t[1]['interface']
            if 'X' in flags: raise Abbruch(f'Die Zugangs-Adresse {ziel_ip} ist im Backup deaktiviert – andere Adresse wählen.')
            if not traeger.startswith('*'):
                if ist_bridge(k, traeger):
                    if ist_hotspot(k, traeger):
                        raise Abbruch(f'{ziel_ip} liegt im Hotspot-Netz {traeger} – dort blockieren die Hotspot-Regeln WebFig. Bitte eine andere Adresse wählen.')
                    if not name_verw: raise Abbruch('Die Verwaltungs-Schnittstelle der Vorschau wurde im Router nicht gefunden.')
                    ok, aus = k.fehlerfrei(f'/interface bridge port add bridge="{ros_string(traeger)}" interface="{ros_string(name_verw)}" comment="FAH-Vorschau Zugang"')
                    if not ok: raise Abbruch(f'Der Vorschau-Zugang ließ sich nicht in die Bridge {traeger} hängen: {aus[:160]}')
                    break
                if ist_vlan(k, traeger):
                    raise Abbruch(f'Die Zugangs-Adresse liegt auf dem VLAN {traeger} – anderen Zugangsweg (Bridge-Adresse) wählen.')
                mac = ethernet_mac(k, traeger)
                if mac:
                    neustart_mac, neustart_netz = mac, lan_netz   # Zugang direkt am Kundenport: Neustartvariante
                    break
        else:
            traeger = dhcp_client_lesen(k)
            if not traeger: raise Abbruch('Kein DHCP-Client im Backup – der WAN-Zugang braucht in dieser Stufe einen DHCP-Uplink; bitte den lokalen Zugang wählen.')
            if not traeger.startswith('*'):
                if ist_bridge(k, traeger):
                    port, mac = bridge_ethernet_port(k, traeger)
                else:
                    port, mac = traeger, ethernet_mac(k, traeger)
                if mac:
                    neustart_mac = mac
                    neustart_netz, erlaubt = wan_netz_waehlen(dienst, [a for a, _, _ in adressen] + routen_lesen(k))
                    if not erlaubt and dienst['available_from']:
                        k.fehlerfrei(f'/ip service set {dienst_name} address=""')
                        info(f'Der Dienst {dienst_name} war auf feste Netze beschränkt und wurde für die Vorschau freigegeben.')
                    break
        # Träger fehlt (z. B. nach dem Restore verschwundener Port): genau ein Neustart-Versuch
        if versuch == 1 and not voll:
            info('Die Schnittstelle des Zugangs fehlt nach dem Restore – der Router wird einmal neu gestartet.')
            k.neustart(limit(300))
            if not k.login(benutzer if not rsc else 'admin', passwort if not rsc else wegwerf, warte=limit(120)):
                raise Abbruch('Die Anmeldung nach dem Neustart ist fehlgeschlagen.')
            n_eth, voll = ethernet_warten(k, len(nic_liste), limit(30))
            continue
        raise Abbruch(f'Der Zugang über „{traeger}“ ist nicht möglich (weder Bridge noch Ethernet) – andere Adresse wählen.')

    if neustart_mac:
        # Neustartvariante: dieselbe Platte, der slirp hängt jetzt an der NIC mit der MAC des Kundenports.
        k.leeren()
        qemu_beenden(L.q); L.q = L.k = None
        netz, gegenstelle, dhcp = slirp_netz(neustart_netz, [ziel_ip] if ziel_ip else [])
        netdev = slirp_netdev(netz, gegenstelle, dhcp)
        neue = [(mac, netdev if mac == neustart_mac else None) for mac, _ in nic_liste]
        if not any(nd for _, nd in neue): raise Abbruch('Der Kundenport für den Zugang ist keine Schnittstelle des virtuellen Routers.')
        schritt('anmelden', 'laeuft', f'Router startet mit Zugang über {traeger} neu')
        t2 = time.monotonic()
        L.q, L.k = qemu_start(qemu_args(platte, neue, kvm, ram))
        k = L.k
        k.warte_login(limit(180))
        if not k.login(benutzer if not rsc else 'admin', passwort if not rsc else wegwerf, warte=limit(120)):
            raise Abbruch('Die Anmeldung nach dem Neustart ist fehlgeschlagen.')
        n_eth, voll = ethernet_warten(k, len(nic_liste), limit(30))
        zugangs_iface = ethernet_name(k, neustart_mac) or traeger
        neu_gestartet = True
        if modus == 'wan':
            t3 = time.monotonic(); ziel_ip = None
            while not ziel_ip and time.monotonic() - t3 < limit(60):
                m = re.search(r'status=bound address=(\S+?)/\d+', k.befehl('/ip dhcp-client print terse'))
                if m: ziel_ip = m.group(1)
                else: time.sleep(3)
            if not ziel_ip: raise Abbruch('Der Router hat über den Uplink keine Adresse per DHCP bekommen.')
            info(f'WAN-Zugang über {traeger} mit der Adresse {ziel_ip} – wie von außen.')
        schritt('anmelden', 'laeuft', f'Neustart nach {sek(t2)} s, WebFig wird geprüft')
    else:
        schritt('anmelden', 'laeuft', 'WebFig wird geprüft (Bridge braucht einige Sekunden)')

    # ---- hostfwd, Relay, WebFig-Probe mit Rückfällen
    if not dienst_erlaubt(dienst, gegenstelle):
        k.fehlerfrei(f'/ip service set {dienst_name} address=""')
        info(f'Der Dienst {dienst_name} war auf feste Netze beschränkt und wurde für die Vorschau freigegeben.')
    regel = f'hostfwd_add mg tcp:127.0.0.1:{HOSTFWD_PORT}-{ziel_ip}:{www_port}'
    antwort = monitor(regel)
    if antwort and re.search(r'could not|invalid|error|fail', antwort, re.I): raise Abbruch(f'QEMU lehnt die Weiterleitung ab: {antwort[:120]}')
    relay_starten(RELAY_PORT, HOSTFWD_PORT)
    url = f'{schema}://127.0.0.1:{HOSTFWD_PORT}/'
    ok, status = webfig_pruefen(url, limit(45))   # Bridge-Port -> WebFig dauert 8-19 s (RSTP)
    if not ok:
        ok1, _ = k.fehlerfrei(f'/ip firewall filter add chain=input src-address={gegenstelle} action=accept comment="FAH-Vorschau Zugang" place-before=0')
        if not ok1: k.fehlerfrei(f'/ip firewall filter add chain=input src-address={gegenstelle} action=accept comment="FAH-Vorschau Zugang"')
        ok, status = webfig_pruefen(url, limit(15))
        if ok: info('Firewall-Regel „FAH-Vorschau Zugang“ (accept input) für die Vorschau vorangestellt.')
    if not ok:
        k.fehlerfrei(f'/ip service set {dienst_name} disabled=no address=""')
        ok, status = webfig_pruefen(url, limit(15))
        if ok: info(f'Der Dienst {dienst_name} wurde für die Vorschau freigegeben.')
    if not ok:
        raise Abbruch(f'WebFig antwortet nicht (HTTP {status}) – Hotspot-Netz oder Firewall? Anderen Zugangsweg wählen.')
    rest_status, _ = http_hole(f'{url}rest/system/identity', auth=(benutzer if not rsc else 'admin', passwort if not rsc else wegwerf))
    schritt('anmelden', 'fertig', f'WebFig {dienst_name}:{www_port} über {zugangs_iface or traeger}{" (REST ok)" if rest_status == 200 else ""}')
    marker('BEREIT', json.dumps({
        'identitaet': identitaet, 'routerosVersion': ros_version, 'wwwPort': www_port, 'schema': schema, 'zugangIp': ziel_ip,
        'traeger': traeger, 'modus': modus, 'verwaltungsName': zugangs_iface, 'kvm': kvm, 'neuGestartet': neu_gestartet,
        'ports': len(kunden), 'ethernet': n_eth
    }, ensure_ascii=False))

    # ---- am Leben halten, bis der Container endet (SIGTERM) oder QEMU stirbt
    while L.q.isalive():
        time.sleep(5)
    raise Abbruch('Der virtuelle Router hat sich beendet.')


def fehler_melden(L, text):
    try:
        zeilen = [z for z in open(KONSOLEN_LOG, encoding='utf-8', errors='replace').read().splitlines() if z.strip()]
        for z in zeilen[-40:]: marker('KONSOLE', sauber(z)[:300])
    except Exception:
        pass
    err = qemu_stderr()
    if err:
        for z in err.splitlines()[-8:]: marker('KONSOLE', f'qemu: {z[:300]}')
    marker('FEHLER', text)


if __name__ == '__main__':
    L = Lauf()
    code = 0

    def beenden(signum, frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, beenden)
    signal.signal(signal.SIGINT, beenden)
    try:
        haupt(L)
    except SystemExit:
        pass
    except Abbruch as e:
        code = 1; fehler_melden(L, str(e))
    except pexpect.EOF:
        code = 1; fehler_melden(L, 'Der virtuelle Router hat sich unerwartet beendet (QEMU).')
    except pexpect.TIMEOUT:
        code = 1; fehler_melden(L, 'Die Konsole des virtuellen Routers antwortet nicht (Zeitlimit).')
    except Exception as e:
        code = 1; fehler_melden(L, f'Unerwarteter Fehler: {type(e).__name__}: {e}')
    finally:
        qemu_beenden(L.q)
        shutil.rmtree(ARBEIT, ignore_errors=True)
        for name in ('kunde.backup', 'kunde.rsc'):
            try: os.remove(f'/auftrag/{name}')
            except OSError: pass
    sys.exit(code)
