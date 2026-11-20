// FAH-Extraktor · test/mitschau.test.mjs — Urheber: Fabian Hammer © 2026
// WebSocket-Rahmen (ws.js) und die Vermittlungslogik der Mitschau (mitschau.js) ohne Browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { annehmen, istWebSocket } from '../server/ws.js';
import * as mitschau from '../server/mitschau.js';

// Ein Fake-Socket: sammelt geschriebene Bytes, ist ein EventEmitter für 'data'.
function fakeSocket() {
  const s = new EventEmitter();
  s.geschrieben = [];
  s.setNoDelay = () => {};
  s.write = (b) => { s.geschrieben.push(Buffer.from(b)); return true; };
  s.end = () => s.emit('close');
  return s;
}
// Ein maskiertes Client-Textframe bauen (wie der Browser sendet).
function clientFrame(text) {
  const nutz = Buffer.from(text, 'utf8');
  const maske = Buffer.from([1, 2, 3, 4]);
  const len = nutz.length;
  let kopf;
  if (len < 126) kopf = Buffer.from([0x81, 0x80 | len]);
  else { kopf = Buffer.alloc(4); kopf[0] = 0x81; kopf[1] = 0x80 | 126; kopf.writeUInt16BE(len, 2); }
  const mask = maske;
  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) payload[i] = nutz[i] ^ mask[i & 3];
  return Buffer.concat([kopf, mask, payload]);
}
// Ein Server-Textframe (unmaskiert) wieder auslesen.
function serverText(buf) {
  const len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) off = 4; else if (len === 127) off = 10;
  const echteLen = len === 126 ? buf.readUInt16BE(2) : len;
  return buf.subarray(off, off + echteLen).toString('utf8');
}
const reqMit = (key = 'dGhlIHNhbXBsZSBub25jZQ==') => ({ headers: { upgrade: 'websocket', 'sec-websocket-key': key } });

test('istWebSocket erkennt nur echte Upgrade-Anfragen', () => {
  assert.equal(istWebSocket(reqMit()), true);
  assert.equal(istWebSocket({ headers: { upgrade: 'websocket' } }), false);
  assert.equal(istWebSocket({ headers: {} }), false);
});

test('annehmen: Handshake-Accept, Textframe dekodieren, senden kodieren, schließen', () => {
  const socket = fakeSocket();
  const verb = annehmen(reqMit(), socket);
  // 1) Handshake-Antwort mit korrektem Sec-WebSocket-Accept
  const antwort = socket.geschrieben.shift().toString('utf8');
  const erwartet = createHash('sha1').update('dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  assert.match(antwort, /^HTTP\/1\.1 101/);
  assert.ok(antwort.includes(`Sec-WebSocket-Accept: ${erwartet}`));
  // 2) eingehendes (maskiertes) Frame wird dekodiert
  const empfangen = [];
  verb.on('nachricht', (t) => empfangen.push(t));
  socket.emit('data', clientFrame(JSON.stringify({ t: 'praesenz', ansicht: 'baum' })));
  assert.deepEqual(JSON.parse(empfangen[0]), { t: 'praesenz', ansicht: 'baum' });
  // 3) ausgehendes Frame ist unmaskiert und lesbar
  verb.sende({ t: 'hallo' });
  assert.deepEqual(JSON.parse(serverText(socket.geschrieben.pop())), { t: 'hallo' });
  // 4) ein zerstückelt ankommendes Frame wird zusammengesetzt
  const f = clientFrame(JSON.stringify({ t: 'liste' }));
  socket.emit('data', f.subarray(0, 3));
  socket.emit('data', f.subarray(3));
  assert.equal(JSON.parse(empfangen[1]).t, 'liste');
  // 5) Schließen meldet 'zu'
  let zu = false; verb.on('zu', () => { zu = true; });
  verb.schliesse();
  assert.equal(zu, true);
});

// Eine Verbindung an den Hub hängen und ihre ausgehenden Nachrichten mitschneiden.
function hubVerb() {
  const socket = fakeSocket();
  const verb = annehmen(reqMit(), socket);
  socket.geschrieben.length = 0;
  const raus = [];
  const echtSende = verb.sende;
  verb.sende = (m) => { raus.push(typeof m === 'string' ? JSON.parse(m) : m); return echtSende.call(verb, m); };
  return { socket, verb, raus, letzte: (t) => [...raus].reverse().find((m) => m.t === t) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('Hub: Admin sieht Sitzungen, Zusehen erst nach Zustimmung, Spiegel wird weitergereicht', async () => {
  const admin = hubVerb();
  const user = hubVerb();
  mitschau.verbinde(admin.verb, { id: 'a1', name: 'Admin', rolle: 'admin' });
  mitschau.verbinde(user.verb, { id: 'u1', name: 'Nutzer', rolle: 'benutzer' });
  const adminId = admin.letzte('willkommen').id;
  const userId = user.letzte('willkommen').id;

  // Admin bekommt eine Liste, in der der Nutzer auftaucht
  const liste = admin.letzte('liste');
  assert.ok(liste && liste.sitzungen.some((s) => s.id === userId && s.name === 'Nutzer'));

  // Nutzer darf Zusehen NICHT anfragen (nur Admins)
  user.verb.__nix; // noop
  user.raus.length = 0;
  user.socket.emit('data', clientFrame(JSON.stringify({ t: 'zusehen-anfrage', ziel: adminId })));
  await tick();
  assert.equal(user.letzte('hinweis')?.text, 'Nur Administratoren dürfen Zusehen anfragen.');

  // Admin fragt beim Nutzer an → der Nutzer bekommt eine Anfrage, noch keine Mitschau
  admin.socket.emit('data', clientFrame(JSON.stringify({ t: 'zusehen-anfrage', ziel: userId })));
  await tick();
  const anfrage = user.letzte('anfrage');
  assert.equal(anfrage.art, 'zusehen');
  assert.equal(anfrage.von.name, 'Admin');
  assert.equal(admin.letzte('zusehen-an'), undefined, 'ohne Zustimmung keine Mitschau');

  // Nutzer stimmt zu → Admin wird Beobachter, Nutzer soll spiegeln
  user.socket.emit('data', clientFrame(JSON.stringify({ t: 'antwort', token: anfrage.token, ja: true })));
  await tick();
  assert.equal(admin.letzte('zusehen-an').host, userId);
  assert.ok(user.letzte('spiegel-start'));
  assert.equal(user.letzte('mitschau-an').name, 'Admin');

  // Nutzer sendet einen Spiegel → Admin erhält ihn (Felder begrenzt)
  admin.raus.length = 0;
  user.socket.emit('data', clientFrame(JSON.stringify({ t: 'spiegel', html: '<main>x</main>', scrollY: 40, boeses: 'feld' })));
  await tick();
  const spiegel = admin.letzte('spiegel');
  assert.equal(spiegel.html, '<main>x</main>');
  assert.equal(spiegel.scrollY, 40);
  assert.equal(spiegel.boeses, undefined);
});

test('Hub: Steuerung nur nach Zustimmung, Eingaben nur bei aktiver Freigabe', async () => {
  const admin = hubVerb();
  const user = hubVerb();
  mitschau.verbinde(admin.verb, { id: 'a2', name: 'Chef', rolle: 'admin' });
  mitschau.verbinde(user.verb, { id: 'u2', name: 'Kollege', rolle: 'benutzer' });
  const userId = user.letzte('willkommen').id;
  // Zusehen aufbauen
  admin.socket.emit('data', clientFrame(JSON.stringify({ t: 'zusehen-anfrage', ziel: userId })));
  await tick();
  const an = user.letzte('anfrage');
  user.socket.emit('data', clientFrame(JSON.stringify({ t: 'antwort', token: an.token, ja: true })));
  await tick();

  // Eingabe ohne Steuerfreigabe wird verworfen
  user.raus.length = 0;
  admin.socket.emit('data', clientFrame(JSON.stringify({ t: 'eingabe', art: 'klick', pfad: '0' })));
  await tick();
  assert.equal(user.letzte('eingabe'), undefined);

  // Admin fragt Steuerung an → Nutzer bekommt Anfrage
  admin.socket.emit('data', clientFrame(JSON.stringify({ t: 'steuern-anfrage' })));
  await tick();
  const sAnfrage = user.letzte('anfrage');
  assert.equal(sAnfrage.art, 'steuern');

  // Nutzer gewährt → beide erfahren es
  user.socket.emit('data', clientFrame(JSON.stringify({ t: 'steuern-antwort', token: sAnfrage.token, ja: true })));
  await tick();
  assert.ok(admin.letzte('steuern-du-an'));
  assert.ok(user.letzte('steuern-an'));

  // Jetzt wird eine Eingabe durchgereicht (bereinigt)
  user.raus.length = 0;
  admin.socket.emit('data', clientFrame(JSON.stringify({ t: 'eingabe', art: 'klick', pfad: '1,2', wert: 'x'.repeat(999) })));
  await tick();
  const ein = user.letzte('eingabe');
  assert.equal(ein.art, 'klick');
  assert.equal(ein.pfad, '1,2');
  assert.equal(ein.wert.length, 400, 'Werte werden gekürzt');

  // Nutzer entzieht die Steuerung → Eingaben greifen nicht mehr
  user.socket.emit('data', clientFrame(JSON.stringify({ t: 'steuern-stopp' })));
  await tick();
  assert.ok(admin.letzte('steuern-du-aus'));
  user.raus.length = 0;
  admin.socket.emit('data', clientFrame(JSON.stringify({ t: 'eingabe', art: 'klick', pfad: '0' })));
  await tick();
  assert.equal(user.letzte('eingabe'), undefined);
});

test('Hub: Trennen meldet beide Seiten und räumt auf', async () => {
  const admin = hubVerb();
  const user = hubVerb();
  mitschau.verbinde(admin.verb, { id: 'a3', name: 'A', rolle: 'admin' });
  mitschau.verbinde(user.verb, { id: 'u3', name: 'U', rolle: 'benutzer' });
  const userId = user.letzte('willkommen').id;
  admin.socket.emit('data', clientFrame(JSON.stringify({ t: 'zusehen-anfrage', ziel: userId })));
  await tick();
  const an = user.letzte('anfrage');
  user.socket.emit('data', clientFrame(JSON.stringify({ t: 'antwort', token: an.token, ja: true })));
  await tick();
  // Beobachter beendet
  admin.socket.emit('data', clientFrame(JSON.stringify({ t: 'beenden' })));
  await tick();
  assert.ok(user.letzte('mitschau-aus'), 'Host erfährt vom Ende');
  assert.ok(user.letzte('spiegel-stopp'), 'Host hört auf zu spiegeln');
  assert.ok(admin.letzte('zusehen-aus'), 'Beobachter erfährt vom Ende');
});
