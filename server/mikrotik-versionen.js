// FAH-Extraktor · Urheber: Fabian Hammer
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, rename, stat, unlink, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Unzip, UnzipInflate } from 'fflate';

// RouterOS-Versionen für die MikroTik-Vorschau: Kanäle von upgrade.mikrotik.com,
// lokal vorhandene CHR-Rohimages im Cache-Volume, Vorschlag je Backup und das
// einmalige Laden eines Images (ZIP von download.mikrotik.com, entpackt, atomar).
// Nur RouterOS 7: die Konsolen-Steuerung (:onerror) und REST gibt es erst in v7.
export const CHR_CACHE = process.env.CHR_CACHE || '/cache';
export const KANAELE = ['stable', 'long-term', 'testing'];
// WICHTIG: die "a"-Endpunkte - NEWEST7.stable liefert veraltet 7.12.1 (verifiziert 10.10.2026).
const QUELLE = (hauptversion, kanal) => `https://upgrade.mikrotik.com/routeros/NEWESTa${hauptversion}.${kanal}`;
const DOWNLOAD = (version) => `https://download.mikrotik.com/routeros/${version}/chr-${version}.img.zip`;
const VERSION = /^7\.\d{1,2}(\.\d{1,2})?(rc\d+|beta\d+)?$/;
const CACHE_STUNDEN = 6;
const BEKANNT = '7.24.5'; // letzte verifizierte stable, falls upgrade.mikrotik.com nicht erreichbar ist

export const istChrVersion = (text) => VERSION.test(String(text || ''));

// "7.24.5 1790691687" -> { version, zeit }
export function versionZeileParsen(text) {
  const m = /^\s*(\d+\.\d+(?:\.\d+)?(?:rc\d+|beta\d+)?)\s+(\d+)/.exec(String(text || ''));
  return m ? { version: m[1], zeit: Number(m[2]) } : null;
}

function zerlegen(version) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?(?:(rc|beta)(\d+))?$/.exec(String(version || ''));
  if (!m) return null;
  return { teile: [Number(m[1]), Number(m[2]), Number(m[3] || 0)], stufe: m[4] === 'beta' ? 0 : m[4] === 'rc' ? 1 : 2, nummer: Number(m[5] || 0) };
}

// Sortierung: Zahlen je Segment, Vorabversionen (beta < rc) vor der Freigabe.
export function vergleiche(a, b) {
  const x = zerlegen(a), y = zerlegen(b);
  if (!x || !y) return String(a).localeCompare(String(b));
  for (let i = 0; i < 3; i++) if (x.teile[i] !== y.teile[i]) return x.teile[i] - y.teile[i];
  if (x.stufe !== y.stufe) return x.stufe - y.stufe;
  return x.nummer - y.nummer;
}

// "Mindestens 7.25" erfüllt auch 7.25rc1: nur die Zahlen zählen.
function erfuellt(version, mindestens) {
  const x = zerlegen(version), y = zerlegen(mindestens);
  if (!x || !y) return true;
  for (let i = 0; i < 3; i++) if (x.teile[i] !== y.teile[i]) return x.teile[i] > y.teile[i];
  return true;
}

const hauptversionVon = (version) => String(version).split('.')[0];

const cache = new Map(); // Hauptversion -> { zeit, kanaele }

export async function versionenAbfragen(hauptversion = '7') {
  const alt = cache.get(hauptversion);
  if (alt && Date.now() - alt.zeit < CACHE_STUNDEN * 3600e3) return { kanaele: alt.kanaele, quelle: 'upgrade.mikrotik.com', stand: alt.zeit };
  const kanaele = [];
  await Promise.all(KANAELE.map(async (kanal) => {
    try {
      const antwort = await fetch(QUELLE(hauptversion, kanal), { signal: AbortSignal.timeout(15000) });
      if (!antwort.ok) return;
      const eintrag = versionZeileParsen(await antwort.text());
      if (eintrag && hauptversionVon(eintrag.version) === String(hauptversion)) kanaele.push({ kanal, ...eintrag });
    } catch { /* Kanal nicht erreichbar - die übrigen reichen */ }
  }));
  kanaele.sort((a, b) => KANAELE.indexOf(a.kanal) - KANAELE.indexOf(b.kanal));
  if (kanaele.length) {
    cache.set(hauptversion, { zeit: Date.now(), kanaele });
    return { kanaele, quelle: 'upgrade.mikrotik.com', stand: Date.now() };
  }
  if (alt) return { kanaele: alt.kanaele, quelle: 'cache', stand: alt.zeit };
  return { kanaele: [], quelle: 'offline', stand: null };
}

// Rohimages im Cache-Volume (chr-<version>.img), neueste zuerst.
export async function lokaleVersionen() {
  try {
    const namen = await readdir(CHR_CACHE);
    return namen.map((name) => /^chr-(.+)\.img$/.exec(name)?.[1]).filter(istChrVersion).sort(vergleiche).reverse();
  } catch { return []; }
}

export function waehleChrVersion(kanaele = [], lokal = [], hauptversion = '7', mindestens = '') {
  const passend = (eintrag) => hauptversionVon(eintrag.version) === String(hauptversion);
  const stable = kanaele.find((k) => k.kanal === 'stable' && passend(k));
  let vorschlag = stable?.version || null;
  let hinweis = null;
  if (vorschlag && mindestens && !erfuellt(vorschlag, mindestens)) {
    const neuere = kanaele.filter((k) => k.kanal !== 'stable' && passend(k) && erfuellt(k.version, mindestens)).sort((a, b) => vergleiche(a.version, b.version))[0];
    if (neuere) {
      vorschlag = neuere.version;
      hinweis = `Das Backup braucht mindestens RouterOS ${mindestens} – vorgeschlagen ist daher ${neuere.version} (${neuere.kanal}).`;
    } else {
      hinweis = `Das Backup ist neuer als die stabile Version ${vorschlag} – es lässt sich möglicherweise nicht einspielen.`;
    }
  }
  if (!vorschlag) {
    const vorhanden = lokal.filter((v) => hauptversionVon(v) === String(hauptversion)).sort(vergleiche).at(-1);
    vorschlag = vorhanden || BEKANNT;
    hinweis = vorhanden
      ? 'upgrade.mikrotik.com ist nicht erreichbar – vorgeschlagen ist die neueste lokal vorhandene Version.'
      : `upgrade.mikrotik.com ist nicht erreichbar – vorgeschlagen ist die bekannte Version ${BEKANNT}.`;
  }
  return { vorschlag, hinweis };
}

// Streamend entpacken: die ZIP enthält genau ein Rohimage chr-<version>.img (~128 MiB).
function entpacken(zipPfad, imgPfad) {
  return new Promise((resolve, reject) => {
    let fertig = false;
    const ende = (f) => { if (!fertig) { fertig = true; f ? reject(f) : resolve(); } };
    const aus = createWriteStream(imgPfad);
    const ein = createReadStream(zipPfad, { highWaterMark: 1 << 20 });
    const unz = new Unzip();
    unz.register(UnzipInflate);
    let gefunden = false;
    unz.onfile = (datei) => {
      if (gefunden || !/\.img$/i.test(datei.name)) return;
      gefunden = true;
      datei.ondata = (f, teil, letzter) => {
        if (f) return ende(f);
        if (teil?.length) aus.write(teil);
        if (letzter) aus.end();
      };
      datei.start();
    };
    aus.on('finish', () => ende(gefunden ? null : new Error('Die ZIP von MikroTik enthält kein Rohimage.')));
    aus.on('error', ende);
    ein.on('error', ende);
    ein.on('data', (teil) => {
      try { unz.push(new Uint8Array(teil.buffer, teil.byteOffset, teil.length), false); } catch (f) { ein.destroy(); return ende(f); }
      if (aus.writableNeedDrain) { ein.pause(); aus.once('drain', () => ein.resume()); }
    });
    ein.on('end', () => {
      try { unz.push(new Uint8Array(0), true); } catch (f) { return ende(f); }
      if (!gefunden) ende(new Error('Die ZIP von MikroTik enthält kein Rohimage.'));
    });
  });
}

// Rückfall, falls fflate die ZIP nicht lesen kann: BusyBox-unzip des Node-Images.
function entpackenMitUnzip(zipPfad, imgPfad) {
  return new Promise((resolve, reject) => {
    const aus = createWriteStream(imgPfad);
    const kind = spawn('unzip', ['-p', zipPfad], { stdio: ['ignore', 'pipe', 'ignore'] });
    kind.on('error', reject);
    kind.stdout.pipe(aus);
    aus.on('error', reject);
    aus.on('finish', () => resolve());
    kind.on('exit', (code) => { if (code !== 0) { aus.destroy(); reject(new Error(`unzip endete mit Code ${code}`)); } });
  });
}

const existiert = (pfad) => stat(pfad).then(() => true, () => false);

const laufend = new Map(); // Version -> Promise (gleichzeitige Anfragen derselben Version zusammenfassen)

// Reste abgebrochener Downloads wegräumen - nur solche, die gerade niemand lädt.
async function resteLoeschen() {
  try {
    for (const name of await readdir(CHR_CACHE)) {
      const m = /^\.chr-(.+)\.(zip|img)\.teil$/.exec(name);
      if (m && !laufend.has(m[1])) await unlink(`${CHR_CACHE}/${name}`).catch(() => {});
    }
  } catch { /* Cache noch nicht vorhanden */ }
}

export async function imageSicherstellen(version, beiFortschritt) {
  if (!istChrVersion(version)) throw new Error('Ungültige RouterOS-Version.');
  const ziel = `${CHR_CACHE}/chr-${version}.img`;
  if (await existiert(ziel)) return ziel;
  if (laufend.has(version)) return laufend.get(version);
  const auftrag = (async () => {
    await mkdir(CHR_CACHE, { recursive: true }).catch(() => {});
    await resteLoeschen();
    const zipTeil = `${CHR_CACHE}/.chr-${version}.zip.teil`;
    const imgTeil = `${CHR_CACHE}/.chr-${version}.img.teil`;
    try {
      const antwort = await fetch(DOWNLOAD(version), { signal: AbortSignal.timeout(30 * 60000), redirect: 'follow' });
      if (antwort.status === 404) throw new Error(`RouterOS ${version} gibt es bei MikroTik nicht.`);
      if (!antwort.ok || !antwort.body) throw new Error(`download.mikrotik.com antwortet mit ${antwort.status}.`);
      const gesamt = Number(antwort.headers.get('content-length')) || 0;
      let geladen = 0;
      await pipeline(
        Readable.fromWeb(antwort.body),
        new Transform({ transform(teil, _, weiter) { geladen += teil.length; beiFortschritt?.(geladen, gesamt || geladen, 'laden'); weiter(null, teil); } }),
        createWriteStream(zipTeil)
      );
      beiFortschritt?.(geladen, geladen, 'entpacken');
      try { await entpacken(zipTeil, imgTeil); } catch (f) {
        console.error(`[mikrotik] fflate konnte chr-${version}.img.zip nicht entpacken (${f.message}) – Rückfall unzip`);
        await unlink(imgTeil).catch(() => {});
        await entpackenMitUnzip(zipTeil, imgTeil);
      }
      const info = await stat(imgTeil);
      if (info.size < 32 * 1024 * 1024) throw new Error('Das entpackte Rohimage ist unvollständig.');
      await rename(imgTeil, ziel);
      return ziel;
    } finally {
      await unlink(zipTeil).catch(() => {});
      await unlink(imgTeil).catch(() => {});
    }
  })();
  laufend.set(version, auftrag);
  try { return await auftrag; } finally { laufend.delete(version); }
}
