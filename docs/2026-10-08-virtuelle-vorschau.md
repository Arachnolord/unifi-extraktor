# Virtuelle Vorschau – Spezifikation (08.10.2026)

**Ziel:** Ein UniFi-Backup (`.unf` oder `.unifi`) bildlich in der echten UniFi-Oberfläche
ansehen, statt es ungeprüft auf ein Gerät zu spielen. Ob virtuelle UDM oder reiner
Network-Controller ist egal (Betreiber).

**Entscheidung:** echter UniFi-Network-Controller als Wegwerf-Sandbox (statt UniFi OS
Server – nicht für Docker, hardwaregebundene Backups – oder eines Nachbaus).

## Ablauf
1. Browser: Backup wie bisher entschlüsseln, „Virtuell öffnen“ → nur der Network-Teil
   (`db.gz`, `version`, `system.properties`, `sites/…`) als ZIP an `POST /_explorer/api/vorschau`.
2. Backend: Version lesen → Image wählen (genau, sonst nächsthöher, sonst neueste mit
   angeglichener Versionsdatei) → `.unf` bauen: Wegwerf-Admin `fah-vorschau`
   (`x_shadow` = SHA-512-crypt, Zufallspasswort) + Admin-Recht auf jeder Site,
   `ucore.*`-Schlüssel aus `system.properties` entfernt, Geräte vom Typ `udm` (UniFi-OS-Konsolen)
   als `uxg` eingetragen – sonst verwirft der Controller sie und „Internet“/„VPN“ bleiben grau.
3. `mongo:7.0` + Controller im Docker-Netz `unifi-vorschau` (`internal`), Label
   `fah.unifi-vorschau=1`, CPU-Anteile 256, Deckel 1/2 CPU, 1/2,5 GB RAM.
4. Frischer Controller (`/status` up) → `POST /upload/backup` (Feld `file`) →
   `POST /api/cmd/backup {cmd: restore}` – beides ohne Anmeldung im Einrichtungszustand.
5. Neustart abwarten, `POST /api/login` mit dem Wegwerf-Admin → bereit.
6. `GET /_explorer/api/vorschau/oeffnen`: frische Sitzung, Cookie `unifises` für die
   Explorer-Domain, Weiterleitung auf `/manage/<site>/dashboard`.

## Weiterleitung
nginx: `/`, `/favicon.svg`, `/_explorer/assets/` statisch; `/_explorer/api/` und alles
andere ans Backend. Das Backend schreibt `Host`, `Origin`, `Referer` auf den Controller
um (Sitzung hängt am Host, fremder Origin → 403), `Location` relativ, WebSockets
(`/wss/…`) durchgereicht, Hinweisleiste in die Seitenhülle von `/manage` eingesetzt (ohne Bedingungs-Header geholt und mit
`no-store` ausgeliefert, sonst zeigt ein 304 die Hülle einer früheren Vorschau). Ein Skript davor
belegt `networkServerUpgradeModalDismissed-<Controller-Kennung>` im sessionStorage vor und klickt
das Fenster „Auf UniFi OS Server upgraden“ notfalls selbst weg.

## Lebensdauer
Eine Vorschau gleichzeitig (neue ersetzt alte). Ende per Knopf, nach 30 min ohne
Anfrage und ohne offenen WebSocket, spätestens nach 8 h; Reste beim Start des Backends
und bei `manage.sh down` entfernt.

## Geprüft (Machbarkeitsprobe 08.10.)
UDM-Pro-Backup „loechnerhaus“ (Network 10.4.57, 37 Geräte) in 10.4.57-Controller:
Upload + Restore ohne Anmeldung ok, ~30 s Neustart, Login mit eingesetztem Admin ok,
15 Netze und 37 Geräte (getrennt) per API sichtbar.
