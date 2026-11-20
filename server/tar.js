// FAH-Extraktor · Urheber: Fabian Hammer

// Packt kleine Dateien als ustar-Archiv (für PUT /containers/{id}/archive).
// Je Datei ein 512-Byte-Kopf, Daten auf 512 Byte aufgefüllt, Abschluss 1024 Nullbytes.
function oktal(wert, laenge) {
  return `${wert.toString(8).padStart(laenge - 1, '0')}\0`;
}

function kopf(name, groesse, mode, mtime) {
  const k = Buffer.alloc(512);
  const feld = (text, start, laenge) => k.write(text, start, laenge, 'utf8');
  if (Buffer.byteLength(name) > 99) throw new Error('Dateiname im Archiv zu lang.');
  feld(name, 0, 100);
  feld(oktal(mode, 8), 100, 8);
  feld(oktal(0, 8), 108, 8);
  feld(oktal(0, 8), 116, 8);
  feld(oktal(groesse, 12), 124, 12);
  feld(oktal(mtime, 12), 136, 12);
  feld('        ', 148, 8); // Prüfsumme: zunächst Leerzeichen
  feld('0', 156, 1);
  feld('ustar\0', 257, 6);
  feld('00', 263, 2);
  feld('root', 265, 32);
  feld('root', 297, 32);
  feld(oktal(0, 8), 329, 8);
  feld(oktal(0, 8), 337, 8);
  let summe = 0;
  for (const byte of k) summe += byte;
  feld(`${summe.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return k;
}

export function tarPacken(dateien) {
  const mtime = Math.floor(Date.now() / 1000);
  const teile = [];
  for (const { name, daten, mode = 0o644 } of dateien) {
    const inhalt = Buffer.isBuffer(daten) ? daten : Buffer.from(daten.buffer, daten.byteOffset, daten.byteLength);
    teile.push(kopf(name, inhalt.length, mode, mtime), inhalt);
    const rest = inhalt.length % 512;
    if (rest) teile.push(Buffer.alloc(512 - rest));
  }
  teile.push(Buffer.alloc(1024));
  return Buffer.concat(teile);
}
