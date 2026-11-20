// FAH-Extraktor · Urheber: Fabian Hammer
import { createHash, randomBytes } from 'node:crypto';

// MD5-crypt ("$1$"), wie es der UniFi-Controller in setting.mgmt.x_ssh_md5passwd für
// das Geräte-SSH-Login ablegt. Node bringt kein crypt(3) mit, daher hier nachgebaut.
const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function md5(...teile) {
  const hash = createHash('md5');
  for (const teil of teile) hash.update(teil);
  return hash.digest();
}

function to64(wert, stellen) {
  let text = '';
  for (let i = 0; i < stellen; i++) { text += ITOA64[wert & 63]; wert >>>= 6; }
  return text;
}

const zufallsSalz = () => [...randomBytes(8)].map((b) => ITOA64[b & 63]).join('');

export function md5crypt(passwort, salz = zufallsSalz()) {
  const p = Buffer.from(passwort, 'utf8');
  const s = Buffer.from(salz, 'utf8').subarray(0, 8);
  const zweit = md5(p, s, p);
  const teile = [p, Buffer.from('$1$'), s];
  for (let n = p.length; n > 0; n -= 16) teile.push(zweit.subarray(0, Math.min(n, 16)));
  for (let n = p.length; n > 0; n >>= 1) teile.push(n & 1 ? Buffer.from([0]) : p.subarray(0, 1));
  let a = md5(...teile);
  for (let i = 0; i < 1000; i++) {
    const runde = [i & 1 ? p : a];
    if (i % 3) runde.push(s);
    if (i % 7) runde.push(p);
    runde.push(i & 1 ? a : p);
    a = md5(...runde);
  }
  const block = (x, y, z) => to64((a[x] << 16) | (a[y] << 8) | a[z], 4);
  return `$1$${s.toString('utf8')}$${block(0, 6, 12)}${block(1, 7, 13)}${block(2, 8, 14)}${block(3, 9, 15)}${block(4, 10, 5)}${to64(a[11], 2)}`;
}
