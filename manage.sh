#!/usr/bin/env bash
# =============================================================================
# manage.sh — Deploy-/Lifecycle-Helfer für FAH-Extraktor (früher unifi-backup-explorer)
#
#   ./manage.sh update     Neueste Deploy-Zip im Root entpacken + deployen,
#                          danach Zip mit Datum wegarchivieren. Gilt auch für
#                          die Erstinstallation (leerer Ordner + Zip + manage.sh).
#   ./manage.sh up|down|restart|rebuild|logs|status|url
#   ./manage.sh port [<PORT>]   WebGUI-Port anzeigen/ändern
#   ./manage.sh admin-reset     Notfall: Konto admin / admin wiederherstellen
#
# Deploy-Zip:  fah-extraktor*.zip (alte Muster unifi-extraktor*.zip und
#              unifi-backup-explorer-deploy*.zip werden weiter erkannt).
#              Browser-Downloads wie "... (1).zip", "... (2).zip" sind erlaubt.
#              Auswahl primär nach mtime (neueste Datei gewinnt); die
#              Klammernummer entscheidet nur bei exakt gleichem Zeitstempel.
#              Erster Deploy nach der Umbenennung: die ALTE manage.sh kennt das
#              neue Muster noch nicht -> einmalig
#              DEPLOY_GLOB="fah-extraktor*.zip" ./manage.sh update
# MikroTik:    update/rebuild bauen zusätzlich das Image der MikroTik-Vorschau
#              (chr/Dockerfile.chr -> fah-extraktor-chr, kein Compose-Dienst) und
#              legen das Docker-Volume fah-chr-cache (RouterOS-Image-Cache) an.
#              Beides passiert VOR dem Tausch der Container: scheitert der Bau,
#              läuft die bisherige Installation unverändert weiter.
# Achtung:     update, down und ein Neustart des Backends beenden alle laufenden
#              virtuellen Vorschauen (UniFi und MikroTik).
# WebGUI-Port: Erstinstallation -> erster freier Port ab 45913, fest in .env
#              (WEB_PORT). Vor jedem Start geprüft; ein Port, den die Container
#              DIESES Projekts belegen, ist der eigene und bleibt.
# Daten:       ./daten (Benutzerkonten, Sitzungen) und .env fasst das Update
#              nie an.
# Nach dem Deploy:  <zipname>.<DATUM>.bak  (endet NICHT auf .zip -> wird beim
#              nächsten update nicht erneut eingelesen). Die docker-compose.yml
#              wird NICHT gesichert, sondern direkt aus der Zip überschrieben.
# =============================================================================
{   # ---------------------------------------------------------------------------
    # PRELOAD-GUARD: Das gesamte Skript in eine Brace-Gruppe wickeln, damit bash
    # die Datei KOMPLETT einliest, bevor etwas ausgeführt wird. Sonst korrumpiert
    # sich das Skript beim Selbst-Update (Deploy-Zip enthält manage.sh -> cp
    # überschreibt die laufende Datei -> bash liest ab altem Offset Müll ->
    # "line 1: tmp: unbound variable"). Passendes 'exit $?' + '}' am Dateiende.
    # ---------------------------------------------------------------------------
set -euo pipefail

# --- Verzeichnis dieses Skripts = Projekt-Root ------------------------------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

DEPLOY_GLOB="${DEPLOY_GLOB:-fah-extraktor*.zip unifi-extraktor*.zip unifi-backup-explorer-deploy*.zip}"
ARCHIVE_BASE="fah-extraktor.zip"   # Datum wird angehängt
STAMP="$(date +%Y%m%d-%H%M%S)"

# MikroTik-Vorschau: Image-Tag des QEMU-Containers (identisch mit CHR_IMAGE in
# docker-compose.yml) und Name des RouterOS-Image-Caches (identisch mit dem externen
# Volume dort und CHR_CACHE_VOLUME im Backend). Bewusst fest, nicht konfigurierbar.
CHR_IMAGE="fah-extraktor-chr"
CHR_VOLUME="fah-chr-cache"

# --- Farben / Logging -------------------------------------------------------
if [ -t 1 ]; then C_B=$'\033[1m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_0=$'\033[0m'
else C_B=""; C_G=""; C_Y=""; C_R=""; C_0=""; fi
log()  { printf "${C_B}==>${C_0} %s\n" "$*"; }
ok()   { printf "${C_G}  ok${C_0} %s\n" "$*"; }
warn() { printf "${C_Y}  ! ${C_0} %s\n" "$*"; }
die()  { printf "${C_R}FEHLER:${C_0} %s\n" "$*" >&2; exit 1; }

# --- docker compose vs. docker-compose erkennen -----------------------------
detect_compose() {
  if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then COMPOSE="docker-compose"
  else die "Weder 'docker compose' noch 'docker-compose' gefunden."; fi
}

# --- .env (WEB_PORT, optional EXPLORER_NAME) --------------------------------
ENV_DATEI="$ROOT/.env"
STANDARD_PORT=45913
env_wert() { grep -E "^$1=" "$ENV_DATEI" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d ' \r' || true; }
env_setzen() {
  local neu="$ENV_DATEI.neu"
  if [ -f "$ENV_DATEI" ]; then grep -vE "^$1=" "$ENV_DATEI" > "$neu" || true; else : > "$neu"; fi
  printf '%s=%s\n' "$1" "$2" >> "$neu"
  mv -f "$neu" "$ENV_DATEI"
}

# --- WebGUI-Port -------------------------------------------------------------
# Container DIESES Projekts (Compose-Projekt des Ordners, zur Sicherheit auch per
# Name): Ihre Ports sind die eigenen. Ohne diese Ausnahme hielte ein Update den
# eigenen, noch laufenden Explorer für einen Fremden und wiche auf 45914 aus.
eigene_ids() {
  local name; name="$(env_wert EXPLORER_NAME)"; name="${name:-unifi-backup-explorer}"
  { $COMPOSE ps -q 2>/dev/null || true
    docker ps -aq --no-trunc --filter "name=^${name}(-api)?\$" 2>/dev/null || true; } | grep -E '^[0-9a-f]{64}$' | sort -u || true
}
eigene_ports() {
  local ids; ids="$(eigene_ids | tr '\n' ' ')"
  [ -n "${ids// /}" ] || return 0
  # shellcheck disable=SC2086
  docker inspect --format '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostPort}} {{end}}{{end}}' $ids 2>/dev/null \
    | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u || true
}
# Von anderen Containern veröffentlichte Ports (auch ohne docker-proxy sichtbar).
fremde_container_ports() {
  local eigene zeile
  eigene=" $(eigene_ids | tr '\n' ' ') "
  while IFS= read -r zeile; do
    [[ "$eigene" == *" ${zeile%%|*} "* ]] && continue
    grep -oE ':[0-9]+->' <<< "${zeile#*|}" | tr -dc '0-9\n' || true
  done < <(docker ps -a --no-trunc --format '{{.ID}}|{{.Ports}}' 2>/dev/null || true)
}
# Lauscht auf dem Host schon etwas auf dem Port? (/proc: Zustand 0A = LISTEN)
port_belegt_lokal() {
  local port="$1" hex d dateien=()
  hex="$(printf '%04X' "$port")"
  for d in /proc/net/tcp /proc/net/tcp6; do [ -r "$d" ] && dateien+=("$d"); done
  if [ "${#dateien[@]}" -gt 0 ]; then
    awk -v p=":$hex" 'FNR > 1 && $4 == "0A" && substr($2, length($2) - 4) == p { f = 1 } END { exit !f }' "${dateien[@]}"
  elif command -v ss >/dev/null 2>&1; then
    ss -Hltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$port\$"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}
# Wunschport (Argument, sonst .env, sonst 45913) behalten, wenn er frei ist oder
# uns gehört; sonst den nächsten freien nehmen und in .env festschreiben.
port_waehlen() {
  local start port eigene fremde
  start="${1:-$(env_wert WEB_PORT)}"
  [[ "$start" =~ ^[0-9]+$ ]] || start="$STANDARD_PORT"
  eigene=" $(eigene_ports | tr '\n' ' ') "
  fremde=" $(fremde_container_ports | sort -un | tr '\n' ' ') "
  port="$start"
  while [[ "$eigene" != *" $port "* ]] && { [[ "$fremde" == *" $port "* ]] || port_belegt_lokal "$port"; }; do
    port=$((port + 1))
    [ "$port" -le 65535 ] || die "Kein freier Port ab $start gefunden."
  done
  if [ "$port" != "$start" ]; then warn "Port $start ist belegt -> nutze $port"
  elif [[ "$eigene" == *" $port "* ]]; then ok "Port $port (gehört diesem Explorer)"
  else ok "Port $port frei"; fi
  [ "$(env_wert WEB_PORT)" = "$port" ] || env_setzen WEB_PORT "$port"
}

# --- MikroTik-Vorschau: Cache-Volume und QEMU-Image ---------------------------
# Das Volume ist in docker-compose.yml "external" (es gab es auf dem NAS schon ohne
# Compose-Label; Compose würde den Start sonst verweigern). docker volume create ist
# idempotent: existiert das Volume, kommt es unverändert zurück. Ohne das Volume
# startet das Compose-Projekt nicht -> klarer Fehler statt Compose-Meldung.
volume_sicherstellen() {
  if docker volume inspect "$CHR_VOLUME" >/dev/null 2>&1; then return 0; fi
  docker volume create "$CHR_VOLUME" >/dev/null 2>&1 \
    || die "Docker-Volume $CHR_VOLUME (RouterOS-Image-Cache) konnte nicht angelegt werden."
  ok "Docker-Volume $CHR_VOLUME angelegt (RouterOS-Image-Cache der MikroTik-Vorschau)"
}
# Eigenes Image, kein Compose-Dienst (Alpine + QEMU/KVM + Steuerskript). Wird VOR dem
# Compose-Build gebaut: scheitert es, bleibt die laufende Installation unberührt.
# Fehlt der Ordner chr/ (ältere Zip), läuft alles andere normal weiter – die
# MikroTik-Virtualisierung meldet dann "Vorschau-Image fehlt".
chr_image_bauen() {
  if [ ! -f "$ROOT/chr/Dockerfile.chr" ]; then
    warn "chr/Dockerfile.chr fehlt – MikroTik-Vorschau-Image wird nicht gebaut (Backups lesen geht trotzdem)"
    return 0
  fi
  log "MikroTik-Vorschau-Image ($CHR_IMAGE) bauen ..."
  docker build -f "$ROOT/chr/Dockerfile.chr" -t "$CHR_IMAGE" "$ROOT/chr" \
    || die "Bau des MikroTik-Vorschau-Images fehlgeschlagen – die bisherige Version läuft unverändert weiter."
  ok "Image $CHR_IMAGE gebaut"
}

# Starten; schnappt sich zwischen Prüfung und Start jemand den Port, genau einmal
# neu wählen.
starten() {
  local ausgabe
  mkdir -p "$ROOT/daten"
  volume_sicherstellen
  if ausgabe="$($COMPOSE up -d --remove-orphans "$@" 2>&1)"; then printf '%s\n' "$ausgabe"; return 0; fi
  printf '%s\n' "$ausgabe"
  printf '%s' "$ausgabe" | grep -qiE 'already allocated|address already in use|port is already' || die "Start fehlgeschlagen."
  warn "Port $(env_wert WEB_PORT) wurde im letzten Moment belegt -> suche neu ..."
  port_waehlen "$(( $(env_wert WEB_PORT) + 1 ))"
  $COMPOSE up -d --remove-orphans "$@" || die "Start fehlgeschlagen."
}

warte_gesund() {
  local dienst id status i
  for dienst in unifi-backup-explorer-api unifi-backup-explorer; do
    id="$($COMPOSE ps -q "$dienst" 2>/dev/null || true)"
    [ -n "$id" ] || { warn "$dienst läuft nicht – ./manage.sh logs"; continue; }
    for i in $(seq 1 45); do
      status="$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo unbekannt)"
      [ "$status" = "healthy" ] && break
      sleep 2
    done
    if [ "$status" = "healthy" ]; then ok "$dienst antwortet"; else warn "$dienst meldet noch nicht 'healthy' – ./manage.sh logs"; fi
  done
}

print_url() {
  local port ip
  port="$(env_wert WEB_PORT)"; port="${port:-$STANDARD_PORT}"
  ip="$(ip route get 1.1.1.1 2>/dev/null | grep -oE 'src [0-9.]+' | awk '{print $2}' | head -n1 || true)"
  [ -n "$ip" ] || ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  printf '  Weboberfläche: http://%s:%s   (Erstanmeldung admin / admin)\n' "${ip:-<Server-IP>}" "$port"
}

# --- Version aus Klammer-Suffix ziehen:  "name (3).zip" -> 3, sonst 0 -------
paren_num() {
  local base; base="$(basename "$1")"
  if [[ "$base" =~ \(([0-9]+)\)\.zip$ ]]; then echo "${BASH_REMATCH[1]}"; else echo 0; fi
}

# --- Neueste Deploy-Zip finden ---------------------------------------------
find_newest_zip() {
  local newest="" n_num=-1 n_mtime=-1 f num mtime
  shopt -s nullglob
  for f in $DEPLOY_GLOB; do
    [ -f "$f" ] || continue
    num="$(paren_num "$f")"
    mtime="$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")"
    # Primär: neuere mtime (tatsächliches Alter zählt!), sekundär bei exakt
    # gleichem Zeitstempel: höhere (N)-Nummer. Vorher war die Klammernummer
    # primär -> eine alte "(7).zip" aus einem früheren Download-Durchgang
    # gewann IMMER gegen eine frisch hineinkopierte "deploy.zip" (Nummer 0),
    # selbst wenn diese Tage älter war. Enthielt die alte Zip eine manage.sh
    # von vor dem Preload-Guard, hat sich der Lauf live selbst zerschossen
    # ("line 1: tmp: unbound variable").
    if [ "$mtime" -gt "$n_mtime" ] || { [ "$mtime" -eq "$n_mtime" ] && [ "$num" -gt "$n_num" ]; }; then
      newest="$f"; n_num="$num"; n_mtime="$mtime"
    fi
  done
  shopt -u nullglob
  [ -n "$newest" ] || return 1
  printf '%s\n' "$newest"
}

# --- NUR manage.sh aus der Zip nach $2 entpacken (für Self-Update) ----------
# Wird VOR dem eigentlichen Deploy genutzt, damit die laufende manage.sh sich
# atomar selbst ersetzen und per exec mit dem NEUEN Script neu starten kann.
extract_manage_from_zip() {
  local zip="$1" out="$2"
  if command -v python3 >/dev/null 2>&1; then PY=python3
  elif command -v python >/dev/null 2>&1; then PY=python
  else return 1; fi
  "$PY" - "$zip" "$out" <<'PYEOF'
import sys, zipfile, shutil, os
zip_path, out = sys.argv[1], sys.argv[2]
try:
    with zipfile.ZipFile(zip_path) as z:
        cand = None
        for n in z.namelist():
            norm = n.lstrip('/')
            if norm == 'manage.sh' or norm.endswith('/manage.sh'):
                cand = n; break
        if cand is None:
            sys.exit(0)
        with z.open(cand) as src, open(out, 'wb') as dst:
            shutil.copyfileobj(src, dst)
except Exception as e:
    sys.stderr.write("[SELF-UPDATE] konnte manage.sh nicht entpacken: %s\n" % e)
    if os.path.exists(out):
        try: os.remove(out)
        except OSError: pass
PYEOF
}

# --- Zip entpacken: unzip, sonst Python -------------------------------------
extract_zip() {
  local zip="$1" dest="$2"
  mkdir -p "$dest"
  if command -v unzip >/dev/null 2>&1; then
    unzip -oq "$zip" -d "$dest"
  elif command -v python3 >/dev/null 2>&1; then
    warn "unzip nicht gefunden -> Fallback auf python3"
    python3 -m zipfile -e "$zip" "$dest"
  elif command -v python >/dev/null 2>&1; then
    warn "unzip nicht gefunden -> Fallback auf python"
    python -m zipfile -e "$zip" "$dest"
  else
    die "Zum Entpacken wird 'unzip' oder 'python3' benötigt."
  fi
}

cmd_update() {
  detect_compose

  log "Suche neueste Deploy-Zip (Muster: $DEPLOY_GLOB) ..."
  local zip
  zip="$(find_newest_zip)" || die "Keine passende Deploy-Zip im Root gefunden ($DEPLOY_GLOB)."
  ok "gewählt: $zip  ($(du -h "$zip" | cut -f1), $(date -r "$zip" '+%F %T' 2>/dev/null || echo '?'))"

  # --- SELF-UPDATE ZUERST (Ansatz aus allinone, bewährt) --------------------
  # Die laufende manage.sh zuerst atomar durch die Version AUS DER ZIP ersetzen
  # (mv = neuer Inode; die laufende bash hält den alten Inode offen -> KEINE
  # Selbst-Korruption) und den kompletten Deploy per exec SOFORT mit dem NEUEN
  # Script neu starten. So greift der Fix in EINEM Lauf. Der Guard
  # MANAGE_SELFUPDATED verhindert eine Endlosschleife.
  if [ -z "${MANAGE_SELFUPDATED:-}" ]; then
    if extract_manage_from_zip "$zip" "$ROOT/.manage.sh.new" && [ -s "$ROOT/.manage.sh.new" ]; then
      if ! cmp -s "$ROOT/.manage.sh.new" "$ROOT/manage.sh"; then
        chmod +x "$ROOT/.manage.sh.new" 2>/dev/null || true
        mv -f "$ROOT/.manage.sh.new" "$ROOT/manage.sh"      # atomar, neuer Inode
        ok "[SELF-UPDATE] manage.sh aus $(basename "$zip") übernommen -> Neustart des Deploys"
        export MANAGE_SELFUPDATED=1
        exec "$ROOT/manage.sh" update
      else
        rm -f "$ROOT/.manage.sh.new"
        ok "[SELF-UPDATE] manage.sh ist bereits aktuell."
      fi
    else
      rm -f "$ROOT/.manage.sh.new" 2>/dev/null || true
    fi
  fi

  local tmp; tmp="$(mktemp -d "$ROOT/.deploy-XXXXXX")"
  # Pfad WERT (nicht Variablenname) in den Trap einbetten: läuft der Trap
  # später in einem Kontext, in dem "$tmp" als lokale Variable nicht mehr
  # sichtbar ist (z.B. errexit-Abbruch mitten in dieser Funktion), würde ein
  # Verweis auf die Variable unter "set -u" mit "tmp: unbound variable"
  # crashen. Mit printf %q steht der fertige String im Trap, unabhängig vom
  # späteren Variablen-Scope.
  trap "rm -rf $(printf '%q' "$tmp")" EXIT

  log "Entpacke ..."
  extract_zip "$zip" "$tmp"

  # Falls das Archiv einen einzelnen Top-Level-Ordner hat -> hineinwechseln
  local srcdir="$tmp"
  local entries; entries=$(find "$tmp" -mindepth 1 -maxdepth 1 | wc -l)
  if [ "$entries" -eq 1 ] && [ -d "$(find "$tmp" -mindepth 1 -maxdepth 1)" ]; then
    srcdir="$(find "$tmp" -mindepth 1 -maxdepth 1)"
    warn "Top-Level-Ordner erkannt -> nutze $srcdir"
  fi

  # Plausibilitätscheck: das ist wirklich das Projekt?
  [ -f "$srcdir/Dockerfile" ] && [ -f "$srcdir/docker-compose.yml" ] \
    || die "Zip enthält kein Dockerfile/docker-compose.yml — falsches Archiv?"

  # Kein Backup der docker-compose.yml mehr: die neue Version aus der Zip
  # überschreibt die bestehende direkt (gewünschtes Verhalten). Lediglich die
  # Deploy-Zip selbst wird nach dem Deploy als .bak weggesichert.
  log "Kopiere Projektdateien ins Root ..."
  # manage.sh wurde bereits im SELF-UPDATE-Schritt atomar getauscht -> hier
  # überspringen. Alles andere überschreiben; nichts wird gelöscht.
  #
  # WICHTIG 1: KEINE Pipeline ("find | while") -- die Schleife liefe sonst in
  # einer Subshell, und ein einzelner cp-Fehler würde unter pipefail+errexit
  # das GESAMTE Skript OHNE Meldung killen (genau das ist passiert: Kopieren
  # brach mittendrin ab, Rebuild + .bak-Umbenennen liefen nie). Deshalb
  # Prozess-Substitution "< <(find ...)" -> Schleife bleibt in dieser Shell.
  #
  # WICHTIG 2: Bei bereits existierenden Ordnern MUSS der INHALT gemergt
  # werden ("$path/." -> "$ROOT/$name/"). "cp dir $ROOT/" würde den Ordner
  # sonst INEINANDER schachteln (-> $ROOT/public/public) statt zu überschreiben.
  #
  # WICHTIG 5: "cp -rf" statt "cp -a" -- "-a" impliziert --preserve=all und
  # will Besitzer/Rechte per chown auf bereits existierende Ziele setzen. Auf
  # dem NAS-Volume (fremder Owner) schlägt genau dieses chown fehl -> cp gibt
  # Exit≠0 -> "|| die" bricht bei "src/" ab (Datei-INHALT wird trotzdem
  # kopiert, aber der Fehlerstatus killt den Lauf). Inhalt überschreiben reicht;
  # Owner/Timestamps müssen NICHT erhalten bleiben.
  #
  # WICHTIG 3: -print0 statt -printf '%f\0' -- '-printf' ist eine
  # GNU-findutils-Erweiterung, die z.B. BusyBox-find (manche NAS-Images) nicht
  # kennt.
  #
  # WICHTIG 4: cp mit explizitem "|| die" -> klare Fehlermeldung statt
  # stillem errexit-Abbruch.
  local path name
  while IFS= read -r -d '' path; do
    name="$(basename "$path")"
    [ "$name" = "manage.sh" ] && continue
    if [ -d "$path" ]; then
      mkdir -p "$ROOT/$name"
      cp -rf "$path/." "$ROOT/$name/" || die "Kopieren fehlgeschlagen: $name/"
    else
      cp -f "$path" "$ROOT/" || die "Kopieren fehlgeschlagen: $name"
    fi
  done < <(find "$srcdir" -mindepth 1 -maxdepth 1 -print0)
  ok "Dateien aktualisiert"

  # Erst bauen, dann tauschen: Scheitert der Bau, läuft die bisherige Version
  # unverändert weiter (früher: erst down, dann build -> Ausfall bei Baufehler).
  # Zuerst das MikroTik-Vorschau-Image (eigener docker build, kein Compose-Dienst).
  chr_image_bauen
  log "Kompletter Neubau (ohne Cache) ..."
  $COMPOSE build --no-cache || die "Bauen fehlgeschlagen – die bisherige Version läuft unverändert weiter."
  log "WebGUI-Port ..."
  port_waehlen
  log "Container ersetzen ..."
  starten --force-recreate
  ok "Container läuft"

  # Deploy-Zip als .bak wegsichern -> endet NICHT auf .zip, wird beim nächsten
  # 'update' nicht erneut ausgewählt. STAMP verhindert Kollisionen bei
  # mehreren Updates am selben Tag.
  local archived="${zip%.zip}.${STAMP}.bak"
  mv -f "$zip" "$archived"
  ok "Deploy-Zip archiviert: $archived"

  rm -rf "$tmp"; trap - EXIT
  warte_gesund
  log "${C_G}Update abgeschlossen.${C_0}"
  $COMPOSE ps
  print_url
}

cmd_up()      { detect_compose; port_waehlen; starten; warte_gesund; print_url; }
# Wegwerf-Container der virtuellen Vorschau (vom Backend per Docker-API gestartet,
# nicht Teil des Compose-Projekts; UniFi-Controller und MikroTik-CHR tragen dasselbe
# Label) beim Herunterfahren mit entfernen. Das Cache-Volume fah-chr-cache bleibt.
vorschau_aufraeumen() {
  local ids; ids="$(docker ps -aq --filter label=fah.unifi-vorschau=1 2>/dev/null || true)"
  [ -n "$ids" ] && docker rm -f -v $ids >/dev/null 2>&1 && ok "Virtuelle Vorschau entfernt" || true
}
cmd_down()    { detect_compose; $COMPOSE down; vorschau_aufraeumen; }
cmd_restart() { detect_compose; $COMPOSE restart; }
cmd_rebuild() { detect_compose; chr_image_bauen; $COMPOSE build || die "Bauen fehlgeschlagen."; port_waehlen; starten --force-recreate; warte_gesund; print_url; }
cmd_logs()    { detect_compose; $COMPOSE logs -f --tail=100; }
cmd_status()  { detect_compose; $COMPOSE ps; print_url; }
cmd_port() {
  detect_compose
  if [ -z "${1:-}" ]; then printf 'WebGUI-Port: %s\n' "$(env_wert WEB_PORT)"; return 0; fi
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ] || die "Ungültiger Port: $1"
  port_waehlen "$1"
  starten --force-recreate
  print_url
}
# Notfall, wenn kein Administrator-Passwort mehr bekannt ist.
cmd_admin_reset() {
  detect_compose
  $COMPOSE exec -T unifi-backup-explorer-api node server/admin-reset.js || die "Das Backend läuft nicht – erst ./manage.sh up"
  $COMPOSE restart unifi-backup-explorer-api >/dev/null
  ok "Anmeldung jetzt mit admin / admin – danach unter „Mein Konto“ ändern."
}

usage() {
  cat <<USAGE
manage.sh — FAH-Extraktor (Backups lesen · virtuell öffnen)

  ./manage.sh update     Neueste Deploy-Zip (fah-extraktor.zip; Muster:
                         $DEPLOY_GLOB)
                         entpacken, Dateien ins Root überschreiben,
                         MikroTik-Vorschau-Image bauen, kompletter Rebuild
                         (--no-cache) + Neustart, danach die Zip als
                         <name>.<DATUM>.bak archivieren (compose wird nicht
                         gesichert). Auch für die Erstinstallation: Zip +
                         manage.sh in einen leeren Ordner legen, dann
                         ./manage.sh update.
  ./manage.sh up         Container starten
  ./manage.sh down       Container stoppen + entfernen (Vorschauen enden,
                         Cache-Volume $CHR_VOLUME bleibt)
  ./manage.sh restart    Container neu starten
  ./manage.sh rebuild    Images neu bauen (inkl. MikroTik-Vorschau-Image)
                         + Container neu erstellen
  ./manage.sh logs       Logs folgen
  ./manage.sh status     Status anzeigen
  ./manage.sh url        Adresse der Weboberfläche anzeigen
  ./manage.sh port [<P>] WebGUI-Port anzeigen bzw. ändern (+ Neustart)
  ./manage.sh admin-reset  Notfall: Konto admin / admin wiederherstellen

  Port: Erstinstallation -> erster freier Port ab $STANDARD_PORT, fest in .env.
  Konten, Sitzungen und Einstellungen liegen in ./daten (bleiben bei Updates
  erhalten).
  MikroTik-Vorschau: Image $CHR_IMAGE aus chr/Dockerfile.chr; RouterOS-Images
  im Docker-Volume $CHR_VOLUME (+128 MiB je Version; leeren mit
  ./manage.sh down && docker volume rm $CHR_VOLUME && ./manage.sh up).
  Voraussetzung /dev/kvm auf dem Host – sonst läuft der virtuelle Router
  ohne KVM und ist sehr langsam.
  update, down und ein Neustart des Backends beenden alle laufenden Vorschauen.

  Erster Deploy nach der Umbenennung (die alte manage.sh kennt das Muster
  noch nicht):  DEPLOY_GLOB="fah-extraktor*.zip" ./manage.sh update

  Env: DEPLOY_GLOB="..."  überschreibt das Such-Muster.
USAGE
}

case "${1:-}" in
  update)  cmd_update ;;
  up)      cmd_up ;;
  down)    cmd_down ;;
  restart) cmd_restart ;;
  rebuild) cmd_rebuild ;;
  logs)    cmd_logs ;;
  status)  cmd_status ;;
  url)     print_url ;;
  port)    cmd_port "${2:-}" ;;
  admin-reset) cmd_admin_reset ;;
  ""|-h|--help|help) usage ;;
  *) die "Unbekannter Befehl: $1  (siehe: ./manage.sh help)";;
esac

exit $?
}   # Ende PRELOAD-GUARD (siehe Kopf) — nichts unterhalb dieser Zeile ausführen
