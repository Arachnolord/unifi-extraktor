import { kontenLaden } from './konten.js';

// Notfall, wenn kein Administrator-Passwort mehr bekannt ist (./manage.sh admin-reset):
// setzt das Konto "admin" auf das Passwort "admin" zurück und macht es zum Administrator.
const konten = await kontenLaden(process.env.DATEN || '/data');
const konto = await konten.adminZuruecksetzen();
await konten.fertig();
console.log(`Konto "${konto.name}" ist wieder Administrator mit dem Passwort "admin" – bitte nach der Anmeldung ändern.`);
