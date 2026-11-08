// Automatische Updates über GitHub-Releases.
// Jede Version liegt als GitHub-Release mit drei Dateien vor:
//   latest.json                 Versionsnummer, Hinweise, Prüfsummen
//   tavi-app-X.Y.Z.json.gz  nur der Programmcode (klein, schnell)
//   Tavi-Setup-X.Y.Z.exe    kompletter Installer (falls sich Electron oder die PDF-Bibliothek ändert)
const { app, net, ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const os = require('os');
const cp = require('child_process');

const pkg = require('./package.json');
// In der Store-Version kommen Updates über den Microsoft Store
const STORE = !!process.windowsStore;
const REPO = STORE ? '' : (pkg.updateRepo || '').trim();           // z. B. "maxmuster/tavi"
const FIRST_CHECK_MS = 15 * 1000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

let ctx = null;          // { getWin, loadSettings, saveSettings }
let timer = null;
let busy = false;
let pending = null;      // { kind: 'app'|'installer', version, files?, exe? }
let applied = false;
const state = { status: STORE ? 'store' : (REPO ? 'idle' : 'off'), current: app.getVersion(), version: null, notes: '', progress: 0, error: '', kind: null, checkedAt: null, repo: REPO };

function emit(patch) {
  Object.assign(state, patch);
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('update:state', { ...state });
}

function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

// GitHub antwortet manchmal kurz mit 5xx (z. B. 504) – dann mit Pause nochmal versuchen
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const busyMsg = (status) => `GitHub ist gerade überlastet (Fehler ${status}). Tavi versucht es später automatisch noch einmal.`;
async function fetchRetry(url) {
  let last;
  for (const wait of [0, 3000, 10000, 25000]) {
    if (wait) await sleep(wait);
    try {
      const r = await net.fetch(url, { cache: 'no-store', headers: { 'User-Agent': 'Tavi-Updater' } });
      if (r.status < 500) return r;
      last = new Error(busyMsg(r.status));
    } catch (e) { last = new Error('Keine Verbindung zu GitHub. Tavi versucht es später automatisch noch einmal.'); }
  }
  throw last;
}

async function getJson(url) {
  const r = await fetchRetry(url);
  if (r.status === 404) throw Object.assign(new Error('Auf GitHub ist noch keine Version veröffentlicht.'), { code: 'none' });
  if (!r.ok) throw new Error(`GitHub antwortet mit Fehler ${r.status}.`);
  return r.json();
}

async function download(url, size) {
  const r = await fetchRetry(url);
  if (!r.ok || !r.body) throw new Error(`Download fehlgeschlagen (Fehler ${r.status}).`);
  const total = Number(r.headers.get('content-length')) || size || 0;
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0, lastPct = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    got += value.length;
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (pct !== lastPct) { lastPct = pct; emit({ progress: pct }); }
  }
  return Buffer.concat(chunks);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Kann der Programmcode direkt ersetzt werden? (Ordner statt app.asar, beschreibbar, gleiche Grundlage)
function canPatch(manifest) {
  if (__dirname.includes('.asar')) return false;
  try { fs.accessSync(__dirname, fs.constants.W_OK); } catch { return false; }
  if (manifest.electron && manifest.electron !== process.versions.electron) return false;
  try {
    const pdfjs = require('./node_modules/pdfjs-dist/package.json').version;
    if (manifest.pdfjs && manifest.pdfjs !== pdfjs) return false;
  } catch { return false; }
  return !!manifest.app;
}

async function check(manual = false) {
  if (!REPO) { emit({ status: STORE ? 'store' : 'off' }); return; }
  if (busy || pending) { emit({}); return; }
  busy = true;
  emit({ status: 'checking', error: '' });
  try {
    const base = `https://github.com/${REPO}/releases`;
    const m = await getJson(`${base}/latest/download/latest.json`);
    if (!m?.version) throw new Error('Die Versionsdatei auf GitHub ist unvollständig.');
    if (!newer(m.version, app.getVersion())) {
      emit({ status: 'current', version: m.version, checkedAt: Date.now() });
      return;
    }
    const tag = m.tag || `v${m.version}`;
    const usePatch = canPatch(m);
    // Mac: kein Windows-Installer, stattdessen Hinweis mit Download-Seite
    if (!usePatch && process.platform !== 'win32') {
      emit({ status: 'manual', version: m.version, notes: m.notes || '', url: `${base}/tag/${tag}`, checkedAt: Date.now() });
      return;
    }
    const asset = usePatch ? m.app : m.installer;
    if (!asset?.file || !asset?.sha256) throw new Error('Für diese Version fehlt eine Update-Datei.');
    emit({ status: 'downloading', version: m.version, notes: m.notes || '', kind: usePatch ? 'app' : 'installer', progress: 0 });
    const file = encodeURIComponent(asset.file);
    // Falls der Tag auf GitHub anders heißt (z. B. ohne „v“), über „latest“ laden
    const buf = await download(`${base}/download/${tag}/${file}`, asset.size)
      .catch(() => download(`${base}/latest/download/${file}`, asset.size));
    if (sha256(buf) !== asset.sha256.toLowerCase()) throw new Error('Die heruntergeladene Datei ist beschädigt (Prüfsumme stimmt nicht). Tavi versucht es später erneut.');
    if (usePatch) {
      const files = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
      pending = { kind: 'app', version: m.version, files };
    } else {
      const exe = path.join(os.tmpdir(), `Tavi-Setup-${m.version}.exe`);
      fs.writeFileSync(exe, buf);
      pending = { kind: 'installer', version: m.version, exe };
    }
    emit({ status: 'ready', progress: 100, checkedAt: Date.now() });
  } catch (e) {
    if (e.code === 'none') emit({ status: 'current', version: null, checkedAt: Date.now() });
    else emit({ status: manual ? 'error' : 'idle', error: e.message || String(e), checkedAt: Date.now() });
  } finally {
    busy = false;
  }
}

// Programmcode überschreiben (die Dateien sind beim Laufen nicht gesperrt)
function writeFiles(files) {
  for (const [rel, b64] of Object.entries(files)) {
    if (rel.includes('..')) continue;
    const out = path.join(__dirname, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = out + '.neu';
    fs.writeFileSync(tmp, Buffer.from(b64, 'base64'));
    fs.renameSync(tmp, out);
  }
}

function apply(restart) {
  if (!pending || applied) return false;
  applied = true;
  try {
    if (pending.kind === 'app') {
      writeFiles(pending.files);
      if (restart) { app.relaunch(); app.exit(0); }
    } else {
      const args = ['/S'];
      if (restart) args.push('/RESTART');
      cp.spawn(pending.exe, args, { detached: true, stdio: 'ignore' }).unref();
      if (restart) app.quit();
    }
    return true;
  } catch (e) {
    applied = false;
    const mac = process.platform === 'darwin' && /EPERM|EACCES/.test(e.code || e.message);
    emit({ status: 'error', error: mac ? 'macOS erlaubt Tavi nicht, sich selbst zu aktualisieren. Lade die neue Version von GitHub und ersetze Tavi im Programme-Ordner.' : `Update konnte nicht eingespielt werden: ${e.message}` });
    return false;
  }
}

function autoEnabled() {
  return ctx.loadSettings().autoUpdate !== false;
}

function schedule() {
  clearTimeout(timer);
  clearInterval(timer);
  if (!REPO || !autoEnabled()) return;
  timer = setTimeout(() => {
    check(false);
    timer = setInterval(() => check(false), INTERVAL_MS);
  }, FIRST_CHECK_MS);
}

function init(c) {
  ctx = c;
  ipcMain.handle('update:get', () => ({ ...state, auto: autoEnabled() }));
  ipcMain.handle('update:check', async () => { await check(true); return { ...state }; });
  ipcMain.handle('update:apply', () => apply(true));
  ipcMain.handle('update:setAuto', (_e, on) => {
    const s = ctx.loadSettings();
    s.autoUpdate = !!on;
    ctx.saveSettings(s);
    schedule();
    return autoEnabled();
  });
  // Nicht geklickt? Dann beim Beenden still einspielen.
  app.on('before-quit', () => { if (pending && !applied) apply(false); });
  schedule();
}

module.exports = { init };
