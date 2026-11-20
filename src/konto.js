// Anmeldung im Explorer: Benutzermenü oben rechts, „Mein Konto“ und die
// Benutzerverwaltung (nur Administratoren). Die Seiten liegen über dem Explorer;
// „Zurück“ zeigt wieder genau die vorherige Ansicht samt geöffnetem Backup.
import { mitschauListeOeffnen } from './mitschau.js';

let ich = null;

export const angemeldet = () => ich;

export function zurAnmeldung() {
  location.href = `/_explorer/anmeldung?weiter=${encodeURIComponent(location.pathname + location.search)}`;
}

export async function api(pfad, methode = 'GET', daten) {
  const antwort = await fetch(`/_explorer/api/${pfad}`, {
    method: methode, cache: 'no-store',
    headers: methode === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Explorer': '1' },
    body: daten === undefined ? undefined : JSON.stringify(daten)
  });
  const inhalt = await antwort.json().catch(() => ({}));
  if (antwort.status === 401) { zurAnmeldung(); throw new Error('Bitte erneut anmelden.'); }
  if (!antwort.ok) throw new Error(inhalt.fehler || `Die Anfrage ist fehlgeschlagen (HTTP ${antwort.status}).`);
  return inhalt;
}

export async function kontoStarten() {
  try { ich = (await api('konto')).benutzer; } catch { return; }
  kopfZeichnen();
  document.addEventListener('click', (e) => {
    const menue = document.querySelector('.benutzermenue');
    if (menue?.open && !menue.contains(e.target)) menue.open = false;
  });
}

const rolleText = (rolle) => (rolle === 'admin' ? 'Administrator' : 'Benutzer');

function kopfZeichnen() {
  const ziel = document.querySelector('#benutzermenue');
  ziel.innerHTML = `<details class="benutzermenue"><summary aria-label="Benutzermenü"><span class="avatar" aria-hidden="true">${escapeHtml(([...ich.name][0] || '?').toUpperCase())}</span><span class="name">${escapeHtml(ich.name)}</span></summary>
    <div class="menue"><small>Angemeldet als ${escapeHtml(ich.name)} · ${rolleText(ich.rolle)}</small>
    <button type="button" data-k="konto">Mein Konto</button>${ich.rolle === 'admin' ? '<button type="button" data-k="verwaltung">Benutzerverwaltung</button><button type="button" data-k="mitschau">Mitschau &amp; Sitzungen</button>' : ''}<button type="button" data-k="abmelden">Abmelden</button></div></details>`;
  ziel.querySelectorAll('[data-k]').forEach((knopf) => knopf.onclick = () => {
    ziel.querySelector('details').open = false;
    ({ konto: meinKonto, verwaltung, abmelden, mitschau: mitschauListeOeffnen })[knopf.dataset.k]();
  });
  const hinweis = document.querySelector('#konto-hinweis');
  hinweis.classList.toggle('hidden', !ich.standardPasswort);
  hinweis.innerHTML = ich.standardPasswort ? `<span>Das Konto „${escapeHtml(ich.name)}“ nutzt noch das Standardpasswort.</span><button type="button">Jetzt ändern</button>` : '';
  hinweis.querySelector('button')?.addEventListener('click', meinKonto);
}

async function abmelden() {
  await fetch('/_explorer/api/abmelden', { method: 'POST', headers: { 'X-Explorer': '1' } }).catch(() => {});
  location.href = '/_explorer/anmeldung';
}

function seiteOeffnen(titel, untertitel, inhalt) {
  const seite = document.querySelector('#konten');
  seite.innerHTML = `<div class="title"><div><h2>${titel}</h2><p>${untertitel}</p></div><button type="button" class="secondary-inline" data-k="zurueck">Zurück zum Explorer</button></div>${inhalt}`;
  seite.querySelector('[data-k="zurueck"]').onclick = seiteSchliessen;
  document.querySelector('main').classList.add('konten-offen');
  seite.classList.remove('hidden');
  window.scrollTo(0, 0);
  return seite;
}

function seiteSchliessen() {
  document.querySelector('main').classList.remove('konten-offen');
  document.querySelector('#konten').classList.add('hidden');
}

function meinKonto() {
  const seite = seiteOeffnen('Mein Konto', `Angemeldet als <strong>${escapeHtml(ich.name)}</strong> · ${rolleText(ich.rolle)}`, `
    ${ich.standardPasswort ? '<div class="notice">Du nutzt noch das Standardpasswort. Bitte vergib ein eigenes.</div>' : ''}
    <form class="konto-form" id="konto-form" novalidate>
      <label class="feld breit"><span>Benutzername</span><input name="name" value="${escapeHtml(ich.name)}" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
      <label class="feld"><span>Neues Passwort</span><input name="passwortNeu" type="password" autocomplete="new-password" placeholder="leer = unverändert"></label>
      <label class="feld"><span>Neues Passwort wiederholen</span><input name="passwortNeu2" type="password" autocomplete="new-password"></label>
      <label class="feld breit"><span>Aktuelles Passwort</span><input name="passwortAlt" type="password" autocomplete="current-password" required></label>
      <small class="feld-hilfe breit">Zum Speichern ist dein aktuelles Passwort nötig. Ein neues Passwort braucht mindestens 8 Zeichen und meldet deine anderen Geräte ab.</small>
      <p class="meldung hidden breit" role="alert"></p>
      <div class="knoepfe"><button type="submit">Speichern</button></div>
    </form>
    <button type="button" class="secondary-inline" data-k="abmelden">Abmelden</button>`);
  seite.querySelector('[data-k="abmelden"]').onclick = abmelden;
  const form = seite.querySelector('#konto-form');
  const wert = (name) => form.querySelector(`[name="${name}"]`).value;
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (wert('passwortNeu') !== wert('passwortNeu2')) return melden(form, 'Die neuen Passwörter stimmen nicht überein.');
    if (!wert('passwortAlt')) return melden(form, 'Bitte dein aktuelles Passwort eingeben.');
    try {
      ich = (await api('konto', 'PUT', { name: wert('name').trim(), passwortAlt: wert('passwortAlt'), passwortNeu: wert('passwortNeu') || undefined })).benutzer;
      kopfZeichnen();
      meinKonto();
      status('Dein Konto ist gespeichert.');
    } catch (fehler) { melden(form, fehler.message); }
  };
}

async function verwaltung() {
  let daten;
  try { daten = await api('benutzer'); } catch (fehler) { return status(fehler.message, true); }
  const seite = seiteOeffnen('Benutzerverwaltung', 'Wer den Explorer und die virtuelle Vorschau nutzen darf', `
    <div class="schalter-zeile"><label class="schalter"><input type="checkbox" id="registrierung"${daten.registrierung ? ' checked' : ''} aria-describedby="registrierung-info"><span></span></label>
      <div><strong>Registrierung auf der Anmeldeseite</strong><small id="registrierung-info">Wer die Anmeldeseite erreicht, kann sich selbst ein Konto anlegen – mit Benutzerrechten, ohne Verwaltung.</small></div></div>
    <h3>Standard-Zugang MikroTik</h3>
    <form class="konto-form" id="mikrotik-zugang" novalidate>
      <label class="feld"><span>Benutzer</span><input name="benutzer" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="z. B. admin" value="${escapeHtml(daten.mikrotikZugang?.benutzer || '')}"></label>
      <label class="feld"><span>Passwort</span><span class="feld-mit-auge"><input name="passwort" type="password" autocomplete="new-password" value="${escapeHtml(daten.mikrotikZugang?.passwort || '')}"><button type="button" class="secondary-inline auge" data-a="auge">Anzeigen</button></span></label>
      <small class="feld-hilfe breit">Vorbelegung für die virtuelle MikroTik-Vorschau (Dialog „Virtualisieren“). Wird auf dem NAS in daten/einstellungen.json gespeichert und ist für alle angemeldeten Konten sichtbar – nie im Programmcode.</small>
      <p class="meldung hidden breit" role="alert"></p>
      <div class="knoepfe"><button type="submit">Speichern</button></div>
    </form>
    <h3>Neues Konto</h3>
    <form class="konto-form drei" id="neues-konto" novalidate>
      <label class="feld"><span>Benutzername</span><input name="name" autocomplete="off" autocapitalize="none" spellcheck="false" required></label>
      <label class="feld"><span>Passwort</span><input name="passwort" type="password" autocomplete="new-password" required></label>
      <label class="feld"><span>Rolle</span><select name="rolle"><option value="benutzer">Benutzer</option><option value="admin">Administrator</option></select></label>
      <small class="feld-hilfe breit">Benutzer nutzen Explorer und Vorschau, Administratoren verwalten zusätzlich die Konten. Passwort mindestens 8 Zeichen.</small>
      <p class="meldung hidden breit" role="alert"></p>
      <div class="knoepfe"><button type="submit">Konto anlegen</button></div>
    </form>
    <h3>Konten (${daten.benutzer.length})</h3>
    <div class="list konten-liste">${daten.benutzer.map(zeile).join('')}</div>`);

  seite.querySelector('#registrierung').onchange = async (e) => {
    try {
      await api('einstellungen', 'PUT', { registrierung: e.target.checked });
      status(e.target.checked ? 'Registrierung auf der Anmeldeseite ist an.' : 'Registrierung auf der Anmeldeseite ist aus.');
    } catch (fehler) { e.target.checked = !e.target.checked; status(fehler.message, true); }
  };

  // Standard-Zugang MikroTik: Vorbelegung für den Virtualisieren-Dialog (PUT einstellungen {mikrotikZugang}).
  const zugang = seite.querySelector('#mikrotik-zugang');
  zugang.querySelector('[data-a="auge"]').onclick = (e) => {
    const feld = zugang.querySelector('[name="passwort"]');
    const zeigen = feld.type === 'password';
    feld.type = zeigen ? 'text' : 'password';
    e.target.textContent = zeigen ? 'Verbergen' : 'Anzeigen';
  };
  zugang.onsubmit = async (e) => {
    e.preventDefault();
    const benutzer = zugang.querySelector('[name="benutzer"]').value.trim();
    const passwort = zugang.querySelector('[name="passwort"]').value;
    if (benutzer.length > 64) return melden(zugang, 'Benutzername: höchstens 64 Zeichen.');
    if (passwort.length > 128) return melden(zugang, 'Passwort: höchstens 128 Zeichen.');
    try {
      await api('einstellungen', 'PUT', { mikrotikZugang: { benutzer, passwort } });
      zugang.querySelector('.meldung').classList.add('hidden');
      status('Standard-Zugang MikroTik gespeichert.');
    } catch (fehler) { melden(zugang, fehler.message); }
  };

  const neu = seite.querySelector('#neues-konto');
  neu.onsubmit = async (e) => {
    e.preventDefault();
    const wert = (name) => neu.querySelector(`[name="${name}"]`).value;
    try {
      const { benutzer } = await api('benutzer', 'POST', { name: wert('name').trim(), passwort: wert('passwort'), rolle: wert('rolle') });
      await nachAenderung(`Konto „${benutzer.name}“ angelegt.`);
    } catch (fehler) { melden(neu, fehler.message); }
  };

  for (const reihe of seite.querySelectorAll('.konten-liste > div')) {
    const konto = daten.benutzer.find((b) => b.id === reihe.dataset.id);
    reihe.querySelector('[data-a="bearbeiten"]').onclick = () => bearbeiten(reihe, konto);
    const loeschen = reihe.querySelector('[data-a="loeschen"]');
    if (!loeschen) continue;
    // Zweistufig statt Rückfrage-Dialog: erster Klick fragt nach, zweiter löscht.
    loeschen.onclick = async () => {
      if (!loeschen.classList.contains('bestaetigen')) {
        loeschen.classList.add('bestaetigen');
        loeschen.textContent = 'Wirklich löschen?';
        setTimeout(() => { loeschen.classList.remove('bestaetigen'); loeschen.textContent = 'Löschen'; }, 4000);
        return;
      }
      try { await api(`benutzer/${konto.id}`, 'DELETE'); await nachAenderung(`Konto „${konto.name}“ gelöscht.`); } catch (fehler) { status(fehler.message, true); }
    };
  }
}

function zeile(b) {
  const infos = [`angelegt ${datum(b.angelegt)}${b.herkunft === 'registrierung' ? ' (selbst registriert)' : ''}`,
    b.letzteAnmeldung ? `zuletzt angemeldet ${datum(b.letzteAnmeldung, true)}` : 'noch nie angemeldet'];
  if (b.standardPasswort) infos.push('Standardpasswort');
  return `<div data-id="${b.id}"><div class="wer"><strong>${escapeHtml(b.name)}</strong><em class="rolle ${b.rolle}">${rolleText(b.rolle)}</em>${b.id === ich.id ? '<em class="du">du</em>' : ''}<small class="info">${infos.join(' · ')}</small></div>
    <div class="aktionen"><button type="button" class="secondary-inline" data-a="bearbeiten">Bearbeiten</button>${b.id === ich.id ? '' : '<button type="button" class="secondary-inline gefahr" data-a="loeschen">Löschen</button>'}</div></div>`;
}

function bearbeiten(reihe, konto) {
  const offen = reihe.querySelector('.bearbeiten-form');
  if (offen) return offen.remove();
  const form = document.createElement('form');
  form.className = 'konto-form bearbeiten-form';
  form.noValidate = true;
  form.innerHTML = `<label class="feld"><span>Benutzername</span><input name="name" value="${escapeHtml(konto.name)}" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <label class="feld"><span>Rolle</span><select name="rolle"><option value="benutzer"${konto.rolle === 'admin' ? '' : ' selected'}>Benutzer</option><option value="admin"${konto.rolle === 'admin' ? ' selected' : ''}>Administrator</option></select></label>
    <label class="feld breit"><span>Neues Passwort</span><input name="passwort" type="password" autocomplete="new-password" placeholder="leer = unverändert"></label>
    <small class="feld-hilfe breit">${konto.id === ich.id ? 'Deine eigene Sitzung bleibt angemeldet.' : 'Ein neues Passwort meldet das Konto auf allen Geräten ab.'}</small>
    <p class="meldung hidden breit" role="alert"></p>
    <div class="knoepfe"><button type="submit">Speichern</button><button type="button" class="secondary-inline" data-a="abbrechen">Abbrechen</button></div>`;
  reihe.append(form);
  form.querySelector('[data-a="abbrechen"]').onclick = () => form.remove();
  form.querySelector('[name="name"]').focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const wert = (name) => form.querySelector(`[name="${name}"]`).value;
    try {
      await api(`benutzer/${konto.id}`, 'PATCH', { name: wert('name').trim(), rolle: wert('rolle'), passwort: wert('passwort') || undefined });
      await nachAenderung(`Konto „${wert('name').trim()}“ gespeichert.`);
    } catch (fehler) { melden(form, fehler.message); }
  };
}

// Nach jeder Änderung: eigenes Konto neu laden (Name/Rolle können sich geändert
// haben) und die Liste neu zeichnen.
async function nachAenderung(text) {
  ich = (await api('konto')).benutzer;
  kopfZeichnen();
  if (ich.rolle !== 'admin') seiteSchliessen();
  else await verwaltung();
  status(text);
}

function melden(form, text) {
  const ziel = form.querySelector('.meldung');
  ziel.textContent = text;
  ziel.classList.remove('hidden');
}

function status(text, fehler = false) {
  const el = document.querySelector('#status');
  el.textContent = text;
  el.className = `status ${fehler ? 'error' : 'success'}`;
  clearTimeout(status.timer);
  status.timer = setTimeout(() => el.classList.add('hidden'), fehler ? 7000 : 3500);
}

function datum(ms, mitZeit = false) {
  return new Date(ms).toLocaleString('de-DE', mitZeit ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
