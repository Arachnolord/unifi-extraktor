# Anmeldung und Benutzerverwaltung – Spezifikation (08.10.2026)

**Ziel (Betreiber):** Zugang zur App nur mit Anmeldung. Erstkonto `admin` / `admin`, Name und
Passwort änderbar, weitere Benutzer per Registrierung auf der Anmeldeseite oder in der
Benutzerverwaltung. Entscheidung: Registrierung per Schalter (Standard aus), registrierte
Konten sofort aktiv als „Benutzer“.

## Schutz
- nginx: `/` und `/index.html` nur nach `auth_request` → `/_explorer/api/pruefen` (204/401),
  401 → `302 /_explorer/anmeldung`. Öffentlich: Anmeldeseite, `/_explorer/assets/` (nur
  Programmcode), `/favicon.svg`. `absolute_redirect off` (hinter NPM sonst http://-Ziele).
- Backend: alle `/_explorer/api/*` außer `gesund`, `pruefen`, `anmeldung`, `anmelden`,
  `registrieren`, `abmelden` brauchen eine Sitzung; UniFi-Vorschau (Proxy) und WebSockets
  ebenso (HTML-GET → Anmeldeseite mit `weiter=`, sonst 401). Änderungen nur mit Kopf
  `X-Explorer: 1` (CSRF).
- Cookie `fah_explorer` (HttpOnly, SameSite=Lax, Secure über https); wird vor der
  Weitergabe an den Controller aus dem Cookie-Kopf entfernt.

## Konten (`server/konten.js`, Daten in `./daten`)
- `benutzer.json`: `{version, registrierung, benutzer:[{id, name, rolle, hash, standardPasswort,
  angelegt, herkunft, letzteAnmeldung}]}`; Hash `scrypt$N$salz$hash` (N=32768, r=8, p=1).
- `sitzungen.json`: SHA-256(Token) → `{benutzer, angelegt, zuletzt}`; gültig 30 Tage ab letzter
  Nutzung (höchstens stündlich gespeichert). Atomares Schreiben (Hilfsdatei + rename).
- Namen 2–40 Zeichen (Buchstaben, Ziffern, `._@-`), eindeutig ohne Groß/klein; Passwörter ≥ 8.
- Bremse: 10 Fehlversuche je Absender (X-Forwarded-For) bzw. Name → 15 min 429.
- Schutzregeln: letzter Admin nicht löschen/herabstufen, eigenes Konto nicht löschen;
  Passwortwechsel beendet die übrigen Sitzungen des Kontos (eigene bleibt).

## Oberfläche
- Anmeldeseite (`anmeldung.html`, eigener Vite-Eintrag) mit „Konto erstellen“, wenn erlaubt.
- Explorer: Benutzermenü oben rechts (Mein Konto, Benutzerverwaltung, Abmelden), gelber
  Hinweis bei Standardpasswort. Konto-Seiten liegen über dem Explorer (`main.konten-offen`),
  „Zurück“ zeigt die vorherige Ansicht samt geöffnetem Backup.
- Vorschau bleibt gemeinsam; Status zeigt `gestartetVon`.

## Betrieb
- `manage.sh`: Erstinstallation = `update` in leerem Ordner; WebGUI-Port automatisch
  (erster freier ab 45913, fest in `.env`; eigene Container zählen nicht als Belegung);
  erst bauen, dann tauschen; `port`, `url`, `admin-reset`.
