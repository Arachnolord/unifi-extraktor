import './style.css';

// Öffentliche Anmeldeseite. Danach geht es zur ursprünglich angefragten Seite
// zurück (nur eigene Pfade), sonst zum Explorer.
const wurzel = document.querySelector('#anmeldung');
const weiter = eigenerPfad(new URLSearchParams(location.search).get('weiter'));
let registrierung = false;
let modus = 'anmelden';

function eigenerPfad(pfad) { return typeof pfad === 'string' && /^\/(?![/\\])/.test(pfad) ? pfad : '/'; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }

function zeichnen(meldung = '') {
  const neu = modus === 'registrieren';
  wurzel.innerHTML = `<main class="anmeldung"><form class="anmeldung-karte" novalidate>
    <div class="brand"><span class="mark">F</span><div><strong>FAH-Extraktor</strong><small>${neu ? 'Neues Konto erstellen' : 'Bitte anmelden'}</small></div></div>
    <label class="feld"><span>Benutzername</span><input name="name" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
    <label class="feld"><span>Passwort</span><input name="passwort" type="password" autocomplete="${neu ? 'new-password' : 'current-password'}" required></label>
    ${neu ? '<label class="feld"><span>Passwort wiederholen</span><input name="passwort2" type="password" autocomplete="new-password" required></label><small class="feld-hilfe">Mindestens 8 Zeichen. Das Konto bekommt Benutzerrechte.</small>' : ''}
    <p class="meldung${meldung ? '' : ' hidden'}" role="alert">${escapeHtml(meldung)}</p>
    <button type="submit">${neu ? 'Konto erstellen' : 'Anmelden'}</button>
    ${registrierung ? `<p class="wechsel">${neu ? 'Schon ein Konto?' : 'Noch kein Konto?'} <button type="button" class="link-knopf" data-wechsel>${neu ? 'Anmelden' : 'Konto erstellen'}</button></p>` : ''}
  </form></main>`;
  const form = wurzel.querySelector('form');
  const feld = (name) => form.querySelector(`[name="${name}"]`);
  feld('name').focus();
  form.querySelector('[data-wechsel]')?.addEventListener('click', () => { modus = neu ? 'anmelden' : 'registrieren'; zeichnen(); });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const name = feld('name').value.trim();
    const passwort = feld('passwort').value;
    if (!name || !passwort) return melden(form, 'Bitte Benutzername und Passwort eingeben.');
    if (neu && passwort !== feld('passwort2').value) return melden(form, 'Die Passwörter stimmen nicht überein.');
    const knopf = form.querySelector('button[type="submit"]');
    knopf.disabled = true;
    try {
      const antwort = await fetch(`/_explorer/api/${neu ? 'registrieren' : 'anmelden'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Explorer': '1' }, body: JSON.stringify({ name, passwort })
      });
      const daten = await antwort.json().catch(() => ({}));
      if (!antwort.ok) throw new Error(daten.fehler || `Die Anmeldung ist fehlgeschlagen (HTTP ${antwort.status}).`);
      location.replace(weiter);
    } catch (fehler) {
      melden(form, fehler instanceof TypeError ? 'Der Explorer ist gerade nicht erreichbar.' : fehler.message);
      knopf.disabled = false;
      if (!neu) { feld('passwort').value = ''; feld('passwort').focus(); }
    }
  };
}

function melden(form, text) {
  const ziel = form.querySelector('.meldung');
  ziel.textContent = text;
  ziel.classList.remove('hidden');
}

async function start() {
  try {
    const daten = await (await fetch('/_explorer/api/anmeldung', { cache: 'no-store' })).json();
    if (daten.angemeldet) return location.replace(weiter);
    registrierung = Boolean(daten.registrierung);
  } catch { /* Anmeldeformular trotzdem zeigen */ }
  zeichnen();
}

start();
