import { deserialize, serialize, EJSON } from 'bson';
import { gunzipSync, gzipSync, unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

// A genuine native single-site .unf writes ONLY these collections. Verified by
// decoding a real controller download (`default-<ts>.unf`): it ships exactly 21
// collections, all true site payload. The previous approach - "export every
// collection that carries a matching site_id, minus a blocklist" - was too
// greedy: it pulled in ~16 controller-GLOBAL collections that a native export
// never includes (config_meta, predefined_firewall_rule with 235 docs,
// teleport_token/teleport_client remote-access SECRETS, ssl_inspection_certificate
// root/intermediate certs, reference_name_history, diagnostics_config,
// wifiman_feedback, ...). Restoring that global state into a fresh site makes the
// destination controller re-provision / rebuild global caches, which invalidates
// the CURRENT session's site context -> the new site returns api.err.NotFound
// until a full RE-LOGIN. That is the "must log out/in to see the site" symptom,
// and it is version-independent. Mirroring the native allowlist makes the import
// behave exactly like a native one: visible immediately, no re-login.
//
// Note: blocklists CANNOT fix this reliably - the greedy heuristic would keep
// picking up any future global collection that happens to have a site_id. The
// allowlist is authoritative because it is what the controller itself writes.
// Regenerate it from a fresh native single-site export if a new Network version
// adds legitimate site-payload collections.
export const ALLOWED_COLLECTIONS = new Set([
  'account', 'apgroup', 'device', 'doh_servers', 'dpigroup',
  'firewall_policy', 'firewall_zone', 'firewallgroup', 'networkconf',
  'portalfile', 'portconf', 'portforward', 'radiusprofile', 'setting',
  'site_feature_migration', 'user', 'usergroup', 'wireguard_user',
  'wlanconf', 'wlangroup'
]);

function slugify(text) {
  return (text || 'site').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
}

const UNF_KEY = hex('626379616e676b6d6c756f686d617273');
const UNF_IV = hex('75626e74656e74657270726973656170');
const UNIFI_KEY = hex('e383b7c53698b36d4baea4ed22181ef73676bfd5d5b90005d9845ffd5dce985f');
function hex(value) {
  return Uint8Array.from(value.match(/../g), (byte) => Number.parseInt(byte, 16));
}

function concat(parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

async function decryptCbc(data, keyBytes, iv, bits) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
  // WebCrypto removes PKCS#7. UniFi uses zero padding; append one valid block and remove it afterwards.
  const block = new Uint8Array(16).fill(16);
  const last = data.slice(-16);
  const bridge = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: last },
    await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']),
    block
  );
  const padded = concat([data, new Uint8Array(bridge)]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, padded));
  return plain.slice(0, data.length);
}

export async function encryptUnf(plain) {
  const length = Math.ceil(plain.length / 16) * 16;
  const padded = new Uint8Array(length);
  padded.set(plain);
  // Add and later discard a PKCS#7 block to obtain no-padding CBC through WebCrypto.
  const key = await crypto.subtle.importKey('raw', UNF_KEY, { name: 'AES-CBC' }, false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: UNF_IV }, key, padded));
  return encrypted.slice(0, length);
}

function trimZeroPadding(data) {
  let end = data.length;
  while (end > 0 && data[end - 1] === 0) end--;
  return data.slice(0, end);
}

function hasZipSignature(data, at, third, fourth) {
  return data[at] === 0x50 && data[at + 1] === 0x4b && data[at + 2] === third && data[at + 3] === fourth;
}

// Läuft das Zentralverzeichnis ab `start` ab. Liefert die Eintragszahl, wenn die Kette exakt bei `end` endet.
function centralDirectoryEntries(data, start, end) {
  const view = new DataView(data.buffer, data.byteOffset, data.length);
  let position = start;
  let entries = 0;
  while (position + 46 <= end && hasZipSignature(data, position, 0x01, 0x02)) {
    position += 46 + view.getUint16(position + 28, true) + view.getUint16(position + 30, true) + view.getUint16(position + 32, true);
    entries++;
  }
  return position === end ? entries : 0;
}

// Site-Exporte verlieren beim Verschlüsseln den letzten angefangenen AES-Block, also bis zu 15 Byte
// des 22 Byte langen ZIP-Endverzeichnisses. Dessen Felder sind redundant: Sie werden aus dem
// vollständigen Zentralverzeichnis neu berechnet. Passt die Kette nicht, bleibt die Datei ein Fehler.
function repairZipEnd(data) {
  for (let end = data.length - 21; end <= data.length - 4; end++) {
    if (!hasZipSignature(data, end, 0x05, 0x06)) continue;
    for (let start = 0; start + 46 <= end; start++) {
      const entries = centralDirectoryEntries(data, start, end);
      if (!entries) continue;
      const record = new Uint8Array(22);
      const view = new DataView(record.buffer);
      view.setUint32(0, 0x06054b50, true);
      view.setUint16(8, entries, true);
      view.setUint16(10, entries, true);
      view.setUint32(12, end - start, true);
      view.setUint32(16, start, true);
      return concat([data.slice(0, end), record]);
    }
  }
  return null;
}

function trimZip(data) {
  // End of central directory: PK\x05\x06 + 18 bytes + optional comment.
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557 - 16); i--) {
    if (hasZipSignature(data, i, 0x05, 0x06)) {
      const commentLength = data[i + 20] | (data[i + 21] << 8);
      return data.slice(0, i + 22 + commentLength);
    }
  }
  const repaired = repairZipEnd(data);
  if (repaired) return repaired;
  throw new Error('Entschlüsselter Inhalt ist kein gültiges ZIP-Archiv.');
}

function readTar(data) {
  const files = new Map();
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.slice(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = strFromU8(header.slice(0, 100)).replace(/\0.*$/, '');
    const prefix = strFromU8(header.slice(345, 500)).replace(/\0.*$/, '');
    const sizeText = strFromU8(header.slice(124, 136)).replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    const path = prefix ? `${prefix}/${name}` : name;
    offset += 512;
    if (header[156] !== 53) files.set(path.replace(/^\.\//, ''), data.slice(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

function parseProperties(bytes) {
  const text = bytes ? strFromU8(bytes) : '';
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.search(/[:=]/);
    if (index >= 0) values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return { text, values };
}

function parseDatabase(dbGz) {
  const bytes = gunzipSync(dbGz);
  const collections = new Map();
  const rawCollections = new Map();
  let current = null;
  for (let offset = 0; offset + 4 <= bytes.length;) {
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0, true);
    if (size < 5 || offset + size > bytes.length) break;
    const raw = bytes.slice(offset, offset + size);
    const doc = deserialize(raw, { promoteLongs: false, promoteValues: true });
    if (doc.__cmd === 'select') {
      current = doc.collection;
      if (!collections.has(current)) { collections.set(current, []); rawCollections.set(current, []); }
    } else if (current) {
      collections.get(current).push(doc);
      rawCollections.get(current).push(raw);
    }
    offset += size;
  }
  const sites = (collections.get('site') || []).map((site) => ({
    id: String(site._id), name: site.name || 'default', description: site.desc || site.name || 'Unbenannt', hidden: Boolean(site.attr_hidden)
  }));
  return { collections, rawCollections, sites };
}

export async function openBackup(file) {
  const input = new Uint8Array(await file.arrayBuffer());
  let files;
  let type;
  if (file.name.toLowerCase().endsWith('.unifi')) {
    type = 'UniFi OS (.unifi)';
    const iv = input.slice(0, 16);
    const encrypted = input.slice(16);
    const plain = await decryptCbc(encrypted, UNIFI_KEY, iv, 256);
    files = readTar(gunzipSync(trimZeroPadding(plain)));
  } else {
    type = 'Network (.unf)';
    const plain = await decryptCbc(input, UNF_KEY, UNF_IV, 128);
    files = new Map(Object.entries(unzipSync(trimZip(plain))));
  }
  const networkPrefix = files.has('backup/network/db.gz') ? 'backup/network/' : '';
  const dbGz = files.get(`${networkPrefix}db.gz`);
  if (!dbGz) throw new Error('Kein Network-Datenbankdump (db.gz) gefunden.');
  const database = parseDatabase(dbGz);
  const properties = parseProperties(files.get(`${networkPrefix}system.properties`));
  const metadata = {};
  for (const path of ['backup/metadata.json','backup/package-versions.json','backup/uos/manifest.json','backup/ucore/system-data.json']) {
    if (files.has(path)) try { metadata[path] = JSON.parse(strFromU8(files.get(path))); } catch { /* show raw file elsewhere */ }
  }
  const pgTables = [...files.keys()].filter((path) => /backup\/ucore\/database\/\d+\.dat\.gz$/.test(path));
  return { name: file.name, size: file.size, type, files, networkPrefix, dbGz, ...database, properties, metadata, pgTables };
}

export function jsonValue(value) {
  return EJSON.stringify(value, null, 2, { relaxed: true });
}

export function downloadBlob(data, name, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportRawZip(backup) {
  const entries = {};
  for (const [path, bytes] of backup.files) entries[path] = bytes;
  downloadBlob(zipSync(entries, { level: 6 }), `${backup.name.replace(/\.(unf|unifi)$/i, '')}-decoded.zip`, 'application/zip');
}

export function detectedVersion(backup) {
  const bytes = backup.files.get(`${backup.networkPrefix}version`);
  return bytes ? strFromU8(bytes).trim() : '10.4.57';
}

export async function createSiteUnf(backup, site, targetVersion) {
  const siteObjects = backup.collections.get('site') || [];
  const index = siteObjects.findIndex((item) => String(item._id) === site.id);
  if (index < 0) throw new Error('Site-Datensatz nicht gefunden.');
  const siteObject = siteObjects[index];

  // FAITHFUL-NATIVE export - a byte-for-byte mirror of what the controller itself
  // writes when you download a single site. Verified as GROUND TRUTH against
  // check/10.4.57_default.unf (a genuine controller download of this exact
  // loechnerhaus "default" site) compared field-by-field to its source backup:
  //
  //   field          source default     native download    => action
  //   _id            620cd0...e86f98     620cd0...e86f98     KEEP verbatim
  //   name           "default"           "default"          KEEP verbatim
  //   attr_no_delete true                true               KEEP verbatim
  //   attr_hidden_id "default"           "default"          KEEP verbatim
  //   anonymous_id   16f81cb2-...        16f81cb2-...        KEEP verbatim
  //   external_id    <Binary>            <Binary, identical> KEEP verbatim (Binary!)
  //   child.site_id  <hex String>        <hex String, ==_id> KEEP verbatim (String)
  //
  // So EVERY earlier theory was wrong: the controller does NOT mint a new _id,
  // does NOT rename, does NOT drop attr_*/protection flags, and does NOT
  // regenerate external_id/anonymous_id (external_id is even a BSON Binary, not a
  // base64 string). It ships the site doc and all child docs completely unchanged.
  // The import path on the destination is what assigns a fresh local id and uses
  // the preserved external_id/anonymous_id as the remap key - that is precisely
  // why they MUST be preserved verbatim, and why regenerating them produced the
  // "site imports but is EMPTY" symptom.
  //
  // The two things a native single-site export does NOT ship (and which, when we
  // shipped them, caused "import error + forced re-login"):
  //   1. NO system.properties     (that file belongs to a full controller backup;
  //                                shipping it makes the importer touch GLOBAL
  //                                controller state -> current session's site
  //                                context is invalidated -> re-login).
  //   2. NO controller-global collections (already handled by ALLOWED_COLLECTIONS).
  const originalId = String(siteObject._id);
  const originalName = siteObject.name || slugify(site.description);
  const siteName = originalName;
  const renamed = false;

  // Site document: emit VERBATIM. It already carries the exact native field set,
  // order and BSON types (incl. external_id as Binary), because the native export
  // is literally this same document.
  const parts = [serialize({ __cmd: 'select', collection: 'site' })];
  parts.push(serialize(siteObject));

  // Child documents: emit VERBATIM for the allowlisted collections, matched to the
  // exported site by its ORIGINAL id. site_id stays exactly as stored (a hex
  // String, matching site._id.toHexString()). We coerce to that hex String only
  // as a defensive no-op in case a source ever stored it as an ObjectId - the
  // controller attaches child docs by comparing child.site_id (String) to
  // site._id.toHexString(), so a String is mandatory.
  for (const collection of backup.collections.keys()) {
    if (collection === 'site') continue;
    if (!ALLOWED_COLLECTIONS.has(collection)) continue;
    const docs = backup.collections.get(collection) || [];
    const matches = docs.filter((doc) => doc.site_id != null && String(doc.site_id) === originalId);
    if (!matches.length) continue;
    parts.push(serialize({ __cmd: 'select', collection }));
    for (const doc of matches) {
      if (doc.site_id != null && typeof doc.site_id !== 'string') {
        parts.push(serialize({ ...doc, site_id: originalId }));
      } else {
        parts.push(serialize(doc));
      }
    }
  }

  const dbGz = gzipSync(concat(parts));
  // The controller compares this version string against its own before accepting
  // the import; keeping the source's (often newer) version here is what makes
  // exports from a newer Network app fail to import into an older one. Let the
  // caller pin a target version so exports can be made backward-compatible.
  const version = (targetVersion && targetVersion.trim()) || detectedVersion(backup);
  const entries = {
    'db.gz': dbGz,
    version: strToU8(version),
    timestamp: strToU8(String(Date.now()))
  };
  // NO system.properties. A genuine native single-site download does NOT contain
  // it (verified: check/10.4.57_default.unf ships only db.gz, version, timestamp
  // and the sites/ tree - no system.properties). That file belongs to a FULL
  // controller backup; shipping it made the destination importer touch GLOBAL
  // controller state, which invalidated the current session's site context ->
  // "import error + forced re-login". Omitting it is what makes the import behave
  // exactly like a native one: site visible immediately, no re-login.

  // Source portal files live under the site's original name; copy them 1:1 into
  // the archive under that same name (native keeps the original site folder name).
  const prefixes = [`${backup.networkPrefix}sites/${originalName}/`, `sites/${originalName}/`];
  const siteFiles = [];
  for (const prefix of prefixes) {
    let found = false;
    for (const [path, bytes] of backup.files) if (path.startsWith(prefix) && path !== prefix) {
      siteFiles.push([path.slice(prefix.length), bytes]); found = true;
    }
    if (found) break;
  }
  // CRITICAL - EXPLICIT ZIP DIRECTORY ENTRIES. A genuine controller export that
  // carries portal uploads ALWAYS writes the directory entries FIRST, in this
  // exact native order, before any file:
  //     sites/  ->  sites/<name>/  ->  sites/<name>/portalfile/  -> <files...>
  // (Verified by parsing the raw local-file-headers of a native full backup:
  // it ships all three dir entries; a native single-site export WITHOUT uploads
  // ships none.)
  //
  // This was the "site imports but throws an error + needs a RE-LOGIN, and a site
  // WITH a guest-portal logo fails while one WITHOUT works" bug. fflate drops
  // directory entries when reading, so an archive that held only the file entries
  // (sites/<name>/portalfile/<id>) LOOKED complete but was missing the parent
  // directory records. The controller's site importer registers the site file
  // area via those directory entries / new File(".../portalfile").list(); without
  // them the portal-file restore step aborts -> the site row is created but its
  // context can't be finalised -> "Fail to import" + forced re-login. Emitting the
  // native directory chain makes a site WITH portal uploads import exactly like a
  // native one. When there are no uploads we still emit the (harmless) empty
  // portalfile directory so list() returns [] instead of null.
  entries[`sites/`] = new Uint8Array(0);
  entries[`sites/${siteName}/`] = new Uint8Array(0);
  entries[`sites/${siteName}/portalfile/`] = new Uint8Array(0);
  for (const [rel, bytes] of siteFiles) entries[`sites/${siteName}/${rel}`] = bytes;
  const zip = zipSync(entries, { level: 6 });

  // Refuse to download a corrupt result. This verifies the complete generated
  // container and BSON stream before it is encrypted as .unf, and confirms the
  // preserved identity survived the round-trip.
  const checked = unzipSync(zip);
  const parsed = parseDatabase(checked['db.gz']);
  if (parsed.sites.length !== 1 || parsed.sites[0].id !== originalId) {
    throw new Error('Interne Prüfung des Site-Exports fehlgeschlagen.');
  }
  return { data: await encryptUnf(zip), siteName, renamed };
}

export async function exportSite(backup, site, targetVersion) {
  const { data, siteName, renamed } = await createSiteUnf(backup, site, targetVersion);
  downloadBlob(data, `${siteName}-${Date.now()}.unf`);
  return { siteName, renamed };
}
