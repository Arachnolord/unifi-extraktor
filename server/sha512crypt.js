import { createHash, randomBytes } from 'node:crypto';

// SHA-512-crypt ("$6$") nach Ulrich Drepper, wie es der UniFi-Controller in
// admin.x_shadow erwartet. Node bringt kein crypt(3) mit, daher hier nachgebaut.
const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ORDER = [
  [0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26], [6, 27, 48],
  [28, 49, 7], [50, 8, 29], [9, 30, 51], [31, 52, 10], [53, 11, 32], [12, 33, 54], [34, 55, 13],
  [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38], [18, 39, 60], [40, 61, 19], [62, 20, 41]
];

const sha512 = (...parts) => { const h = createHash('sha512'); for (const p of parts) h.update(p); return h.digest(); };

function repeatTo(bytes, length) {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += bytes.length) bytes.copy(out, i, 0, Math.min(bytes.length, length - i));
  return out;
}

function encode(b2, b1, b0, n) {
  let w = (b2 << 16) | (b1 << 8) | b0, out = '';
  while (n-- > 0) { out += ITOA64[w & 0x3f]; w >>= 6; }
  return out;
}

export function sha512crypt(password, salt = randomSalt(), rounds = 5000) {
  const p = Buffer.from(password, 'utf8');
  const s = Buffer.from(salt, 'utf8').subarray(0, 16);
  const b = sha512(p, s, p);
  const a = createHash('sha512').update(p).update(s);
  let n = p.length;
  for (; n > 64; n -= 64) a.update(b);
  a.update(b.subarray(0, n));
  for (let i = p.length; i > 0; i >>= 1) a.update(i & 1 ? b : p);
  let c = a.digest();
  const pSeq = repeatTo(sha512(...Array(p.length).fill(p)), p.length);
  const sSeq = repeatTo(sha512(...Array(16 + c[0]).fill(s)), s.length);
  for (let r = 0; r < rounds; r++) {
    const h = createHash('sha512');
    h.update(r & 1 ? pSeq : c);
    if (r % 3) h.update(sSeq);
    if (r % 7) h.update(pSeq);
    h.update(r & 1 ? c : pSeq);
    c = h.digest();
  }
  let hash = ORDER.map(([x, y, z]) => encode(c[x], c[y], c[z], 4)).join('') + encode(0, 0, c[63], 2);
  return `$6$${rounds === 5000 ? '' : `rounds=${rounds}$`}${s.toString('utf8')}$${hash}`;
}

export function randomSalt() {
  return [...randomBytes(16)].map((x) => ITOA64[x & 0x3f]).join('');
}
