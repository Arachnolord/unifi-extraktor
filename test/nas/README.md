# NAS-Tests (test/nas) – Aufrufe

Alles hier läuft **nur auf dem NAS** (`/usr/bin/ssh -p 2222 benutzer@192.168.1.23 '…'`), nie auf dem Mac.
`test/nas` ist per `.gitattributes` nicht in der Release-ZIP; die Skripte deshalb vom Mac nach
`/tmp/fahtest` auf dem NAS kopieren:

```sh
/usr/bin/ssh -p 2222 benutzer@192.168.1.23 'mkdir -p /tmp/fahtest'
for f in testkonto.mjs mikrotik.mjs klick-mikrotik.mjs parallel.mjs klick-voll.mjs; do
  cat test/nas/$f | /usr/bin/ssh -p 2222 benutzer@192.168.1.23 "cat > /tmp/fahtest/$f"
done
```

Arbeitsordner auf dem NAS: `cd /volume3/docker/unifi-extraktor`. Testbackup: `/home/benutzer/chr-test/kunde.backup`
(Kunden-Backup – bleibt auf dem NAS, nie ins Repo). Die Produktivinstanz wird mit **Testkonten** getestet,
nie mit einer zweiten Instanz (der Backend-Start räumt alle Vorschau-Container weg).

## 0. Admin-Testkonto (einmalig, statt des Betreiber-Passworts)

`testkonto.mjs` schreibt direkt in `daten/benutzer.json` (scrypt-Format aus `server/konten.js`). Das gilt nur,
wenn das Backend dabei steht oder danach neu startet – **beides beendet alle laufenden Vorschauen**.

```sh
docker compose stop unifi-backup-explorer-api
docker run --rm -v "$PWD/daten:/data" -v /tmp/fahtest:/t:ro unifi-extraktor-unifi-backup-explorer-api node /t/testkonto.mjs anlegen
docker compose start unifi-backup-explorer-api
```

Die Ausgabe nennt `ADMIN_NAME=fah-testadmin ADMIN_PW=…` (zufällig; mit `-e TESTKONTO_PW=…` selbst wählbar).
Am Ende aller Tests wieder entfernen (räumt auch liegengebliebene `mt-test*`/`mt-klick*` mit weg):

```sh
docker compose stop unifi-backup-explorer-api
docker run --rm -v "$PWD/daten:/data" -v /tmp/fahtest:/t:ro unifi-extraktor-unifi-backup-explorer-api node /t/testkonto.mjs entfernen
docker compose start unifi-backup-explorer-api
```

## 1. Unit-Tests im API-Image (ohne Docker-Socket, ohne Netz)

`test/*.test.mjs` liegen in der ZIP, also auch im Projektordner auf dem NAS:

```sh
docker run --rm -v "$PWD/test:/app/test:ro" unifi-extraktor-unifi-backup-explorer-api node --test 'test/*.test.mjs'
# Decoder zusätzlich gegen das echte Backup:
docker run --rm -v "$PWD/test:/app/test:ro" -v /home/benutzer/chr-test/kunde.backup:/tmp/kunde.backup:ro \
  -e MIKROTIK_TESTBACKUP=/tmp/kunde.backup unifi-extraktor-unifi-backup-explorer-api node --test test/mikrotik-backup.test.mjs
```

## 2. UniFi-Regression: `parallel.mjs`

```sh
docker exec unifi-backup-explorer-api mkdir -p /tmp/uxtest
docker cp /tmp/fahtest/parallel.mjs unifi-backup-explorer-api:/tmp/uxtest/
# UniFi-Testbackups (*.unifi, ohne ._*-Begleitdateien) nach /tmp/uxtest im Container kopieren
docker exec -e ADMIN_NAME=fah-testadmin -e ADMIN_PW=… -w /app unifi-backup-explorer-api node /tmp/uxtest/parallel.mjs start
docker exec -e ADMIN_NAME=fah-testadmin -e ADMIN_PW=… -w /app unifi-backup-explorer-api node /tmp/uxtest/parallel.mjs ende
```

Neu geprüft: `art: 'unifi'` im Status, Hülle ohne `x-frame-options` mit `frame-ancestors 'self'`,
`oeffnen?eingebettet=1` → 302 `/manage/…`, ohne Lauf → 200-Hinweis ohne Link auf `/`.

## 3. MikroTik-API-Durchlauf: `mikrotik.mjs` (im API-Container)

```sh
docker exec unifi-backup-explorer-api mkdir -p /tmp/fahtest
docker cp /home/benutzer/chr-test/kunde.backup unifi-backup-explorer-api:/tmp/fahtest/kunde.backup
docker cp /tmp/fahtest/mikrotik.mjs unifi-backup-explorer-api:/tmp/fahtest/
read -r PW            # Router-Passwort des Backups, nie in Dateien
docker exec -e ADMIN_NAME=fah-testadmin -e ADMIN_PW=… -e MIKROTIK_PW="$PW" -w /app \
  unifi-backup-explorer-api node /tmp/fahtest/mikrotik.mjs start
docker exec -e ADMIN_NAME=fah-testadmin -e ADMIN_PW=… -w /app unifi-backup-explorer-api node /tmp/fahtest/mikrotik.mjs ende
# WAN-Lauf (Neustartvariante, DHCP über den Uplink):
docker exec -e ZUGANG=wan -e ADMIN_NAME=… -e ADMIN_PW=… -e MIKROTIK_PW="$PW" -w /app \
  unifi-backup-explorer-api node /tmp/fahtest/mikrotik.mjs start   # danach wieder: … ende
```

Weitere Env: `MIKROTIK_USER` (admin), `CHR_VERSION` (7.24.5), `ZUGANG_IP` (192.168.250.1), `LIMIT_S`.
Prüft: Einstellungen (`PUT {mikrotikZugang}` lässt `registrierung` unverändert, Vorbelegung in
`vorbereitung`), abgelehnte Starts (RouterOS 6, `admin+x`, ohne Optionen, unbekannte Art), Start → bereit
mit Zeiten, Status (`art`, `mikrotik.*`, `zugang`), `/webfig/` 200 ohne `x-frame-options` mit
`frame-ancestors 'self'`, REST über den Proxy, `oeffnen` (302 `/webfig/`), `puls` 204, fremdes Konto
(409/403-Regeln, keine Passwörter), Leerlauf-Baseline. `ende` beendet die Testläufe, prüft, dass keine
`-chr-`-Container der Läufe übrig sind, und löscht `mt-test1/2`.

## 4. Browser-Durchklick: `klick-mikrotik.mjs` (headless-shell + CDP)

```sh
cp /home/benutzer/chr-test/kunde.backup /tmp/fahtest/kunde.backup
docker run -d --rm --name fah-headless --network host -v /tmp/fahtest:/tmp/fahtest chromedp/headless-shell \
  --no-sandbox --remote-debugging-address=127.0.0.1 --remote-debugging-port=9333
read -r PW
docker run --rm --network host -v /tmp/fahtest:/tmp/fahtest -e PORT=45913 -e ADMIN_NAME=fah-testadmin \
  -e ADMIN_PW=… -e MIKROTIK_PW="$PW" node:22-alpine node /tmp/fahtest/klick-mikrotik.mjs
```

Ablauf: Anmeldung → 7 Kacheln (A–Z, 2 aktiv, Badges) → MikroTik → Backup per `DOM.setFileInputFiles` →
Übersicht → Baum (> 100 Rubriken, Suche „addrs“, Datensatz mit Feldern + Hex, Volltext „192.168“, „Keine
Treffer“) → Rohdatei → Virtualisieren-Dialog (Version/Zugang vorbelegt, Hilfetexte) → **Polling-Schutz**
(Passwort tippen, fremdes Konto `mt-klick2` startet/beendet eine Vorschau, 2 × 12 s warten, Dialog bleibt)
→ Start → bereit (Zeiten) → Fenster (WebFig-Titel im iframe, Knöpfe) → **Leerlauf-Befund** (25 s:
steigt `letzteAktivitaet` ohne Puls? → Puls streichen oder behalten, in memory.md festhalten) →
Handybreite 390 px (Fenster volle Breite) → Schließen → Beenden (zwei Klicks) → Übersicht → Kacheln
einspaltig. Screenshots `1-kacheln` … `10-kacheln-handy` unter `/tmp/fahtest`. Der Browser-Container bleibt
zwischen Läufen angemeldet (das Skript meldet fremde Konten ab). `klick-voll.mjs` (UniFi „alle Plätze
belegt“) wie bisher mit `-e MAX=6`.

## 5. Aufräumen

```sh
docker rm -f fah-headless
docker exec unifi-backup-explorer-api rm -rf /tmp/fahtest /tmp/uxtest
rm -rf /tmp/fahtest
# Admin-Testkonto entfernen (Abschnitt 0, „entfernen“), danach docker ps: keine unifi-vorschau-*-Container von Tests
```
