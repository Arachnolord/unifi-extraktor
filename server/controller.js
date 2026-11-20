import https from 'node:https';
import { randomBytes } from 'node:crypto';

// Gespräch mit den Wegwerf-Controllern (selbstsigniertes Zertifikat, nur im
// abgeschotteten Netz erreichbar). Jede Vorschau hat ihren eigenen Controller;
// "ziel" ist dessen Containername samt Port.
export const zielFuer = (host) => ({ host, port: 8443, schema: 'https' });
export const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false, maxSockets: 64 });

export function anfrage(ziel, method, pfad, { body, kopf = {}, cookie, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const daten = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const headers = {
      Host: `${ziel.host}:${ziel.port}`, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest',
      ...(daten && !kopf['Content-Type'] ? { 'Content-Type': 'application/json' } : {}),
      ...(daten ? { 'Content-Length': daten.length } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...kopf
    };
    const req = https.request({ host: ziel.host, port: ziel.port, method, path: pfad, headers, agent, timeout }, (res) => {
      const teile = [];
      res.on('data', (teil) => teile.push(teil));
      res.on('end', () => {
        const text = Buffer.concat(teile).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* keine JSON-Antwort */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Controller antwortet nicht (Zeitüberschreitung).')));
    req.on('error', reject);
    if (daten) req.write(daten);
    req.end();
  });
}

export async function status(ziel) {
  try {
    const antwort = await anfrage(ziel, 'GET', '/status', { timeout: 5000 });
    return antwort.json?.meta || null;
  } catch { return null; }
}

export async function backupHochladen(ziel, unf, dateiname = 'vorschau.unf') {
  const grenze = `----fah${randomBytes(12).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${grenze}\r\nContent-Disposition: form-data; name="file"; filename="${dateiname}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.from(unf),
    Buffer.from(`\r\n--${grenze}--\r\n`)
  ]);
  const antwort = await anfrage(ziel, 'POST', '/upload/backup', {
    body, kopf: { 'Content-Type': `multipart/form-data; boundary=${grenze}` }, timeout: 5 * 60000
  });
  const meta = antwort.json?.meta;
  if (meta?.rc !== 'ok' || !meta.backup_id) throw new Error(fehlertext(meta?.msg, antwort));
  return antwort.json.data?.[0] || meta;
}

export async function einspielen(ziel, backupId) {
  const antwort = await anfrage(ziel, 'POST', '/api/cmd/backup', { body: { cmd: 'restore', backup_id: backupId }, timeout: 5 * 60000 });
  if (antwort.json?.meta?.rc !== 'ok') throw new Error(fehlertext(antwort.json?.meta?.msg, antwort));
}

// Liefert den Sitzungs-Cookie ("unifises=...") oder null.
export async function anmelden(ziel, benutzer, passwort) {
  try {
    const antwort = await anfrage(ziel, 'POST', '/api/login', { body: { username: benutzer, password: passwort, remember: true }, timeout: 20000 });
    if (antwort.json?.meta?.rc !== 'ok') return null;
    const cookie = [].concat(antwort.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('unifises='));
    return cookie || null;
  } catch { return null; }
}

export async function sites(ziel, cookie) {
  const antwort = await anfrage(ziel, 'GET', '/api/self/sites', { cookie });
  return antwort.json?.meta?.rc === 'ok' ? antwort.json.data : [];
}

const MELDUNGEN = {
  'api.err.InvalidBackupVersion': 'Das Backup stammt aus einer neueren UniFi-Version als der Controller.',
  'api.err.InvalidBackup': 'Der Controller hält die Datei nicht für ein gültiges Backup.',
  'api.err.BackupUnsupported': 'Der Controller unterstützt dieses Backup nicht.',
  'api.err.InvalidSiteBackup': 'Ein Single-Site-Export lässt sich nicht als Vorschau einspielen.'
};

function fehlertext(code, antwort) {
  if (code && MELDUNGEN[code]) return `${MELDUNGEN[code]} (${code})`;
  if (code) return `Der Controller meldet: ${code}`;
  return `Unerwartete Antwort des Controllers (HTTP ${antwort.status}).`;
}
