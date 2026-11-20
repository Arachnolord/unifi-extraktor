// FAH-Extraktor · Urheber: Fabian Hammer
import { createHash } from 'node:crypto';

// Schlanker WebSocket-Server (RFC 6455) ohne Fremdpaket – nur so viel, wie die Mitschau braucht:
// Text- und Binär-Frames, Ping/Pong, sauberes Schließen. Server-Frames sind unmaskiert,
// Client-Frames werden demaskiert. Fragmentierte Frames und Payloads > 4 MB werden verworfen.
const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX = 4 * 1024 * 1024;

export function istWebSocket(req) {
  return (req.headers.upgrade || '').toLowerCase() === 'websocket' && Boolean(req.headers['sec-websocket-key']);
}

// Übernimmt den aufgerüsteten Socket und liefert eine kleine Verbindung mit on()/sende()/schliesse().
export function annehmen(req, socket) {
  const akzept = createHash('sha1').update(req.headers['sec-websocket-key'] + MAGIC).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${akzept}\r\n\r\n`
  );
  socket.setNoDelay(true);

  const hoerer = { nachricht: [], zu: [] };
  const verbindung = {
    offen: true,
    on(ereignis, fn) { (ereignis === 'nachricht' ? hoerer.nachricht : hoerer.zu).push(fn); return verbindung; },
    sende(daten) {
      if (!verbindung.offen) return;
      const text = typeof daten === 'string' ? daten : JSON.stringify(daten);
      try { socket.write(rahmen(Buffer.from(text, 'utf8'), 0x1)); } catch { schliessen(); }
    },
    schliesse(code = 1000) { if (verbindung.offen) { try { socket.write(rahmen(Buffer.from([code >> 8, code & 0xff]), 0x8)); } catch { /* egal */ } } schliessen(); },
  };

  let puffer = Buffer.alloc(0);
  let geschlossen = false;
  function schliessen() {
    if (geschlossen) return;
    geschlossen = true; verbindung.offen = false;
    try { socket.end(); } catch { /* egal */ }
    for (const fn of hoerer.zu) try { fn(); } catch { /* egal */ }
  }

  socket.on('data', (teil) => {
    puffer = puffer.length ? Buffer.concat([puffer, teil]) : teil;
    if (puffer.length > MAX + 14) return schliessen();
    let rahmenDaten;
    while ((rahmenDaten = frameLesen(puffer))) {
      const { opcode, nutzlast, laenge } = rahmenDaten;
      puffer = puffer.subarray(laenge);
      if (opcode === 0x8) return verbindung.schliesse();
      if (opcode === 0x9) { try { socket.write(rahmen(nutzlast, 0xA)); } catch { schliessen(); } continue; }
      if (opcode === 0xA) continue; // Pong ignorieren
      if (opcode === 0x1 || opcode === 0x2) {
        const text = nutzlast.toString('utf8');
        for (const fn of hoerer.nachricht) { try { fn(text); } catch (f) { console.error('[ws] Hörer:', f.message); } }
      }
    }
  });
  socket.on('error', schliessen);
  socket.on('close', schliessen);
  // Leben prüfen: alle 30 s ein Ping; antwortet die Gegenseite 70 s nicht, schließen.
  let letztesLeben = Date.now();
  socket.on('data', () => { letztesLeben = Date.now(); });
  const takt = setInterval(() => {
    if (!verbindung.offen) return clearInterval(takt);
    if (Date.now() - letztesLeben > 70000) return verbindung.schliesse();
    try { socket.write(rahmen(Buffer.alloc(0), 0x9)); } catch { schliessen(); }
  }, 30000);
  socket.on('close', () => clearInterval(takt));

  return verbindung;
}

// Ein vollständiges Client-Frame aus dem Puffer lesen (immer maskiert) oder null.
function frameLesen(puffer) {
  if (puffer.length < 2) return null;
  const opcode = puffer[0] & 0x0f;
  const maskiert = (puffer[1] & 0x80) !== 0;
  let laenge = puffer[1] & 0x7f;
  let versatz = 2;
  if (laenge === 126) { if (puffer.length < 4) return null; laenge = puffer.readUInt16BE(2); versatz = 4; }
  else if (laenge === 127) { if (puffer.length < 10) return null; laenge = Number(puffer.readBigUInt64BE(2)); versatz = 10; }
  if (laenge > MAX) return null; // Überlanges Frame: wird oben zum Schließen führen
  const maske = maskiert ? versatz : 0;
  const start = versatz + (maskiert ? 4 : 0);
  if (puffer.length < start + laenge) return null;
  const nutzlast = Buffer.allocUnsafe(laenge);
  for (let i = 0; i < laenge; i++) nutzlast[i] = maskiert ? puffer[start + i] ^ puffer[maske + (i & 3)] : puffer[start + i];
  return { opcode, nutzlast, laenge: start + laenge };
}

// Server-Frame (unmaskiert).
function rahmen(nutzlast, opcode) {
  const n = nutzlast.length;
  let kopf;
  if (n < 126) { kopf = Buffer.from([0x80 | opcode, n]); }
  else if (n < 65536) { kopf = Buffer.alloc(4); kopf[0] = 0x80 | opcode; kopf[1] = 126; kopf.writeUInt16BE(n, 2); }
  else { kopf = Buffer.alloc(10); kopf[0] = 0x80 | opcode; kopf[1] = 127; kopf.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([kopf, nutzlast]);
}
