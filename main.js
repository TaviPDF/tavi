const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage, nativeTheme, protocol, net, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// Eigene Adresse app://tavi/… statt file://, damit Web-Worker (PDF-Darstellung),
// Schriftarten und Bilddecoder zuverlässig laden.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);
// Umzug von „Lesepult“ zu „Tavi“: alte Einstellungen samt verschlüsseltem API-Schlüssel weiterverwenden.
// Muss vor dem Start (ready) passieren, weil Electron den Ordner danach benutzt.
(function migrateFromLesepult() {
  try {
    const appData = app.getPath('appData');
    const oldDir = path.join(appData, 'Lesepult');
    const newDir = path.join(appData, 'Tavi');
    if (!fs.existsSync(path.join(oldDir, 'settings.json')) || fs.existsSync(path.join(newDir, 'settings.json'))) return;
    try {
      if (fs.existsSync(newDir) && fs.readdirSync(newDir).length === 0) fs.rmdirSync(newDir);
      if (!fs.existsSync(newDir)) { fs.renameSync(oldDir, newDir); return; }
    } catch { /* Umbenennen nicht möglich */ }
    app.setPath('userData', oldDir); // dann den alten Ordner einfach weiter benutzen
  } catch { /* ohne Umzug weiter */ }
})();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf', '.icc': 'application/octet-stream', '.map': 'application/json'
};
function registerAppProtocol() {
  protocol.handle('app', async (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    const full = path.normalize(path.join(__dirname, rel));
    if (!full.startsWith(__dirname)) return new Response('Verboten', { status: 403 });
    try {
      const r = await net.fetch(pathToFileURL(full).toString());
      if (!r.ok) return new Response('Nicht gefunden', { status: 404 });
      const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
      return new Response(r.body, { status: 200, headers: { 'Content-Type': type } });
    } catch {
      return new Response('Nicht gefunden', { status: 404 });
    }
  });
}

const AUTO = 'auto';
const RESOLVE_MAX_AGE = 3 * 24 * 60 * 60 * 1000; // alle 3 Tage neu prüfen, ob es bessere Modelle gibt
let win = null; // zuletzt aktives Fenster
const owner = () => BrowserWindow.getFocusedWindow() || win;
let pendingPath = null;

/* ---------- Einstellungen (lokal im Benutzerordner, Schlüssel verschlüsselt) ---------- */
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
// Mac: Tavi bietet an, sich selbst in den Programme-Ordner zu verschieben
async function offerMoveToApplications() {
  if (process.platform !== 'darwin' || process.defaultApp) return false;
  try { if (app.isInApplicationsFolder()) return false; } catch { return false; }
  const s = loadSettings();
  if (s.noMoveAsk) return false;
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['In „Programme“ verschieben', 'Nicht jetzt'],
    defaultId: 0, cancelId: 1,
    message: 'Tavi in den Programme-Ordner verschieben?',
    detail: 'Dort findest du Tavi im Launchpad, und Tavi kann sich selbst aktualisieren. Tavi startet danach automatisch neu.',
    checkboxLabel: 'Nicht mehr fragen'
  });
  if (response !== 0) {
    if (checkboxChecked) { s.noMoveAsk = true; saveSettings(s); }
    return false;
  }
  try {
    return app.moveToApplicationsFolder({
      conflictHandler: (type) => type !== 'exists' || dialog.showMessageBoxSync({
        type: 'question', buttons: ['Ersetzen', 'Abbrechen'], defaultId: 0, cancelId: 1,
        message: 'In „Programme“ gibt es schon eine Tavi-App.', detail: 'Soll sie durch diese Version ersetzt werden?'
      }) === 0
    });
  } catch (e) {
    dialog.showErrorBox('Verschieben nicht möglich', `${e.message}\n\nZieh Tavi einfach selbst im Finder in den Ordner „Programme“.`);
    return false;
  }
}
function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { /* neu */ }
  if (s.v !== 2) {
    // Ab 1.0.2: automatische Modellwahl als Standard
    s.models = { gemini: AUTO, groq: AUTO };
    s.resolved = {};
    s.v = 2;
    try { saveSettings(s); } catch { /* egal */ }
  }
  return s;
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}
function encryptKey(key) {
  if (safeStorage.isEncryptionAvailable()) return { e: true, v: safeStorage.encryptString(key).toString('base64') };
  return { e: false, v: key };
}
function decryptKey(o) {
  if (!o) return '';
  try { return o.e ? safeStorage.decryptString(Buffer.from(o.v, 'base64')) : o.v; } catch { return ''; }
}
function publicSettings() {
  const s = loadSettings();
  return {
    provider: s.provider || 'gemini',
    level: s.level || 'normal',
    aiNotice: !!s.aiNotice,
    models: { gemini: s.models?.gemini || AUTO, groq: s.models?.groq || AUTO },
    active: { gemini: s.resolved?.gemini?.model || '', groq: s.resolved?.groq?.model || '' },
    hasKey: { gemini: !!decryptKey(s.keys?.gemini), groq: !!decryptKey(s.keys?.groq) }
  };
}

/* ---------- KI-Anbindung ---------- */
class AIError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

async function http(url, opts) {
  let r;
  try { r = await fetch(url, opts); } catch { throw new AIError('network', 'Keine Verbindung zum KI-Dienst. Bist du online?'); }
  let j = {};
  try { j = await r.json(); } catch { /* leere Antwort */ }
  if (!r.ok) {
    const msg = j.error?.message || `HTTP ${r.status}`;
    let code = 'api';
    if (r.status === 429 || /quota|rate limit|resource.?exhausted/i.test(msg)) code = 'rate';
    else if (r.status === 401 || /api key|api_key|unauthenticated/i.test(msg)) code = 'key';
    else if (r.status === 404 || (/model/i.test(msg) && /not found|not supported|does not exist|decommissioned|deprecated|no longer available|access/i.test(msg))) code = 'model';
    else if (r.status === 403) code = 'key';
    else if (r.status >= 500) code = 'server';
    throw new AIError(code, msg);
  }
  return j;
}

async function listModels(provider, key) {
  if (provider === 'groq') {
    const j = await http('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + key } });
    return (j.data || []).filter(m => m.active !== false).map(m => m.id)
      .filter(id => !/whisper|tts|guard|playai|orpheus|distil|compound|prompt|safeguard/i.test(id));
  }
  const out = [];
  let token = '';
  do {
    const j = await http(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200${token ? '&pageToken=' + token : ''}`, { headers: { 'x-goog-api-key': key } });
    for (const m of j.models || []) {
      if (!m.supportedGenerationMethods?.includes('generateContent')) continue;
      const n = m.name.replace(/^models\//, '');
      if (!/^(gemini|gemma)/i.test(n)) continue;
      if (/image|tts|live|embedding|audio|robotics|computer-use|native|learnlm|aqa|veo|imagen|nano/i.test(n)) continue;
      out.push(n);
    }
    token = j.nextPageToken || '';
  } while (token);
  return out;
}

/* Rangfolge „bestes Modell zuerst“.
   Gemini: Flash vor Pro (Pro hat im Gratis-Kontingent kaum Anfragen frei), dann Lite, dann Gemma;
   innerhalb einer Familie die höchste Versionsnummer, fertige Versionen vor Vorschau-Versionen. */
function rankModels(provider, list) {
  const uniq = [...new Set(list)];
  if (provider === 'groq') {
    const order = [/gpt-oss-120b/, /llama-4-maverick/, /llama-3\.3-70b/, /kimi-k2/, /qwen3?-.*32b|qwen3/, /llama-4-scout/, /gpt-oss-20b/, /llama-3\.1-8b/];
    const rank = (m) => { const i = order.findIndex(r => r.test(m)); return i === -1 ? order.length : i; };
    return uniq.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }
  const info = (m) => {
    const v = parseFloat((m.match(/(?:gemini|gemma)-(\d+(?:\.\d+)?)/) || [])[1] || '0');
    const family = /gemma/.test(m) ? 4 : /lite/.test(m) ? 3 : /flash/.test(m) ? 1 : /pro/.test(m) ? 2 : 5;
    const preview = /preview|exp|experimental/.test(m) ? 1 : 0;
    const alias = /latest/.test(m) ? 1 : 0;
    const dated = /-\d{2,}$|-\d{4}$/.test(m) ? 1 : 0; // feste Datums-Snapshots nach dem Hauptnamen
    return { v, family, preview, alias, dated };
  };
  return uniq.sort((a, b) => {
    const A = info(a), B = info(b);
    return A.family - B.family || B.v - A.v || A.preview - B.preview || A.alias - B.alias || A.dated - B.dated || a.localeCompare(b);
  });
}

async function generate(provider, key, model, system, messages) {
  if (provider === 'groq') {
    const j = await http('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, temperature: 0.3, messages: [{ role: 'system', content: system }, ...messages.map(m => (m.images?.length
        ? { role: m.role, content: [{ type: 'text', text: m.content }, ...m.images.slice(0, 5).map(i => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } }))] }
        : { role: m.role, content: m.content }))] })
    });
    const t = j.choices?.[0]?.message?.content?.trim();
    if (!t) throw new AIError('empty', 'Die KI hat keine Antwort geliefert.');
    return t;
  }
  const j = await http(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }, ...(m.images || []).map(i => ({ inlineData: { mimeType: i.mime, data: i.data } }))] })),
      generationConfig: { temperature: 0.3 }
    })
  });
  const c = j.candidates?.[0];
  const t = c?.content?.parts?.filter(p => !p.thought).map(p => p.text || '').join('').trim();
  if (!t) {
    if (j.promptFeedback?.blockReason || c?.finishReason === 'SAFETY') throw new AIError('blocked', 'Die KI hat diese Anfrage abgelehnt.');
    throw new AIError('empty', 'Die KI hat keine Antwort geliefert.');
  }
  return t;
}

const asError = (e) => ({ ok: false, code: e.code || 'api', message: e.message || String(e) });
// Bei diesen Fehlern lohnt ein anderes Modell (jedes Modell hat eigenes Gratis-Kontingent)
const TRY_NEXT = new Set(['model', 'rate', 'server', 'empty']);

/* Fragt die KI. Im Automatik-Modus wird das zuletzt funktionierende Modell zuerst
   genommen; scheitert es, werden die nächstbesten der Reihe nach probiert. */
const VISION = { gemini: (m) => /^gemini/i.test(m) && !/gemma/i.test(m), groq: (m) => /llama-4|vision|scout|maverick/i.test(m) };
async function askWithBestModel(provider, key, system, messages) {
  const s = loadSettings();
  const vision = messages.some(m => m.images?.length);
  const slot = vision ? `${provider}:vision` : provider;
  let chosen = s.models?.[provider] || AUTO;
  if (vision && chosen !== AUTO && !VISION[provider](chosen)) chosen = AUTO;
  const cached = s.resolved?.[slot];
  const fresh = cached && Date.now() < (cached.expires || cached.at + RESOLVE_MAX_AGE);

  let candidates = [];
  if (chosen !== AUTO) candidates.push(chosen);
  else if (fresh) candidates.push(cached.model);

  let ranked = null;
  const loadRanked = async () => {
    if (!ranked) {
      ranked = rankModels(provider, await listModels(provider, key));
      if (vision) {
        ranked = ranked.filter(VISION[provider]);
        if (provider === 'groq') ranked.sort((a, b) => /maverick/.test(b) - /maverick/.test(a));
        if (!ranked.length) throw new AIError('model', provider === 'groq' ? 'Bei Groq ist gerade kein Modell verfügbar, das Bilder versteht. Mit Google Gemini klappt es.' : 'Kein Modell verfügbar, das Bilder versteht.');
      }
    }
    return ranked;
  };
  if (!candidates.length) candidates = (await loadRanked()).slice(0, 8);

  const tried = new Set();
  let lastErr = null;
  for (let round = 0; round < 2; round++) {
    for (const model of candidates) {
      if (tried.has(model) || tried.size >= 8) continue;
      tried.add(model);
      try {
        const text = await generate(provider, key, model, system, messages);
        const prev = cached?.model;
        // Ausweich-Modell nur 1 Stunde merken, danach wieder das beste versuchen
        const now = Date.now();
        let expires = now + RESOLVE_MAX_AGE;
        if (ranked) expires = model === ranked[0] ? now + RESOLVE_MAX_AGE : now + 60 * 60 * 1000;
        else if (cached?.model === model && cached.expires) expires = cached.expires;
        s.resolved = { ...(s.resolved || {}), [slot]: { model, at: now, expires } };
        if (!vision && chosen !== AUTO && model !== chosen) s.models[provider] = AUTO; // manuelles Modell kaputt: auf Automatik umstellen
        saveSettings(s);
        return { ok: true, text, model, modelChanged: !vision && prev && prev !== model ? model : undefined };
      } catch (e) {
        lastErr = e;
        if (!TRY_NEXT.has(e.code)) throw e;
      }
    }
    // Zweite Runde: frische Rangliste vom Anbieter holen
    candidates = (await loadRanked()).slice(0, 8);
  }
  throw lastErr || new AIError('model', 'Kein Modell verfügbar.');
}

ipcMain.handle('ai:ask', async (_e, { system, messages }) => {
  const s = loadSettings();
  const provider = s.provider || 'gemini';
  const key = decryptKey(s.keys?.[provider]);
  if (!key) return { ok: false, code: 'nokey', message: 'Kein API-Schlüssel hinterlegt.' };
  try { return await askWithBestModel(provider, key, system, messages); } catch (e) { return asError(e); }
});

ipcMain.handle('ai:models', async (_e, provider) => {
  const key = decryptKey(loadSettings().keys?.[provider]);
  if (!key) return { ok: false, code: 'nokey', message: 'Kein API-Schlüssel hinterlegt.' };
  try { return { ok: true, models: rankModels(provider, await listModels(provider, key)) }; } catch (e) { return asError(e); }
});

ipcMain.handle('settings:get', () => publicSettings());
ipcMain.handle('settings:set', (_e, p) => {
  const s = loadSettings();
  s.keys = s.keys || {};
  s.models = s.models || {};
  s.resolved = s.resolved || {};
  if (p.provider === 'gemini' || p.provider === 'groq') s.provider = p.provider;
  if (p.level) s.level = p.level;
  if (p.aiNotice) s.aiNotice = true;
  const prov = p.provider || s.provider || 'gemini';
  if (typeof p.model === 'string') {
    const m = p.model.trim() || AUTO;
    if (m !== s.models[prov]) delete s.resolved[prov];
    s.models[prov] = m;
  }
  if (typeof p.key === 'string' && p.key.trim()) { s.keys[prov] = encryptKey(p.key.trim()); delete s.resolved[prov]; }
  if (p.removeKey) { delete s.keys[prov]; delete s.resolved[prov]; }
  saveSettings(s);
  return publicSettings();
});

/* ---------- Dateien ---------- */
ipcMain.handle('file:open', async () => {
  const r = await dialog.showOpenDialog(owner(), { title: 'PDF öffnen', properties: ['openFile'], filters: [{ name: 'PDF-Dokumente', extensions: ['pdf'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return readPdf(r.filePaths[0]);
});
ipcMain.handle('file:openMany', async () => {
  const r = await dialog.showOpenDialog(owner(), { title: 'PDFs zum Zusammenführen wählen', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF-Dokumente', extensions: ['pdf'] }] });
  if (r.canceled) return [];
  return r.filePaths.map(readPdf).filter(Boolean);
});
ipcMain.handle('file:save', async (_e, { data, name }) => {
  const r = await dialog.showSaveDialog(owner(), {
    title: 'Zusammengeführtes PDF speichern',
    defaultPath: path.join(app.getPath('documents'), name || 'Zusammengeführt.pdf'),
    filters: [{ name: 'PDF-Dokument', extensions: ['pdf'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, Buffer.from(data));
    return { ok: true, path: r.filePath, name: path.basename(r.filePath) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});
// Umwandeln: eine Datei speichern (Dateityp frei wählbar)
ipcMain.handle('file:saveAs', async (_e, { data, name, filterName, ext }) => {
  const r = await dialog.showSaveDialog(owner(), {
    title: 'Umgewandelte Datei speichern',
    defaultPath: path.join(app.getPath('documents'), name),
    filters: [{ name: filterName, extensions: [ext] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try { fs.writeFileSync(r.filePath, Buffer.from(data)); return { ok: true, path: r.filePath, name: path.basename(r.filePath) }; }
  catch (e) { return { ok: false, message: e.message }; }
});
// Umwandeln: Zielordner wählen (für mehrere Bilder)
ipcMain.handle('folder:pick', async () => {
  const r = await dialog.showOpenDialog(owner(), { title: 'Ordner für die Bilder wählen', defaultPath: app.getPath('pictures'), properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});
// Eine Datei in einen gewählten Ordner schreiben, ohne Vorhandenes zu überschreiben
ipcMain.handle('file:writeInto', async (_e, { dir, name, data }) => {
  try {
    const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
    const ext = path.extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    let target = path.join(dir, safe);
    for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${stem} (${i})${ext}`);
    fs.writeFileSync(target, Buffer.from(data));
    return { ok: true, path: target };
  } catch (e) { return { ok: false, message: e.message }; }
});
// Gespeicherte Unterschriften (verschlüsselt, nur auf diesem PC)
const sigFile = () => path.join(app.getPath('userData'), 'signatures.json');
function loadSigs() {
  try {
    const raw = JSON.parse(fs.readFileSync(sigFile(), 'utf8'));
    return (raw.items || []).map(it => ({ id: it.id, w: it.w, h: it.h, data: decryptKey(it.data) })).filter(it => it.data.startsWith('data:image/png'));
  } catch { return []; }
}
function storeSigs(list) {
  fs.mkdirSync(path.dirname(sigFile()), { recursive: true });
  fs.writeFileSync(sigFile(), JSON.stringify({ items: list.map(it => ({ id: it.id, w: it.w, h: it.h, data: encryptKey(it.data) })) }));
}
ipcMain.handle('sig:list', () => loadSigs());
ipcMain.handle('sig:save', (_e, sig) => {
  if (!sig?.data?.startsWith('data:image/png')) return false;
  const list = loadSigs().filter(s => s.data !== sig.data);
  list.unshift({ id: Date.now().toString(36), w: sig.w, h: sig.h, data: sig.data });
  storeSigs(list.slice(0, 6));
  return true;
});
ipcMain.handle('sig:delete', (_e, id) => { storeSigs(loadSigs().filter(s => s.id !== id)); return true; });
ipcMain.handle('path:show', (_e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); });
// Nur Dateien, die der Nutzer selbst geöffnet oder gespeichert hat, dürfen überschrieben werden
const openedPaths = new Set();
const remember = (p) => openedPaths.add(path.resolve(p).toLowerCase());
function readPdf(p) {
  try { const f = { name: path.basename(p), path: p, data: fs.readFileSync(p) }; addRecent(p); remember(p); return f; } catch { return null; }
}
const IMG_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'];
function readImage(p) {
  try { return { name: path.basename(p), path: p, data: fs.readFileSync(p), image: true }; } catch { return null; }
}
ipcMain.handle('file:openDocs', async () => {
  const r = await dialog.showOpenDialog(owner(), { title: 'PDF öffnen', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDFs und Bilder', extensions: ['pdf', ...IMG_EXT] }, { name: 'PDF-Dokumente', extensions: ['pdf'] }] });
  if (r.canceled) return [];
  return r.filePaths.map(p => (/\.pdf$/i.test(p) ? readPdf(p) : readImage(p))).filter(Boolean);
});
ipcMain.handle('file:openImages', async () => {
  const r = await dialog.showOpenDialog(owner(), { title: 'Bilder für das PDF wählen', defaultPath: app.getPath('pictures'), properties: ['openFile', 'multiSelections'], filters: [{ name: 'Bilder', extensions: IMG_EXT }] });
  if (r.canceled) return [];
  return r.filePaths.map(readImage).filter(Boolean);
});
// Bearbeitetes PDF in die Originaldatei zurückschreiben (über eine Zwischendatei, damit nichts kaputtgeht)
ipcMain.handle('file:writeBack', async (_e, { path: p, data }) => {
  if (typeof p !== 'string' || !/\.pdf$/i.test(p) || !openedPaths.has(path.resolve(p).toLowerCase())) return { ok: false, message: 'Diese Datei darf Tavi nicht überschreiben.' };
  const tmp = `${p}.tavi-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, Buffer.from(data));
    fs.renameSync(tmp, p);
    return { ok: true, path: p, name: path.basename(p) };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* egal */ }
    const busy = /EBUSY|EPERM|EACCES/.test(e.code || '');
    return { ok: false, message: busy ? 'Die Datei ist gerade in einem anderen Programm geöffnet oder schreibgeschützt. Nutze „Speichern unter“.' : e.message };
  }
});
ipcMain.handle('file:savePdfAs', async (_e, { data, name, dir }) => {
  const r = await dialog.showSaveDialog(owner(), {
    title: 'PDF speichern',
    defaultPath: path.join(dir && fs.existsSync(dir) ? dir : app.getPath('documents'), name || 'Dokument.pdf'),
    filters: [{ name: 'PDF-Dokument', extensions: ['pdf'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try { fs.writeFileSync(r.filePath, Buffer.from(data)); remember(r.filePath); addRecent(r.filePath); return { ok: true, path: r.filePath, name: path.basename(r.filePath) }; }
  catch (e) { return { ok: false, message: e.message }; }
});
// Meine Daten: nur lokal, verschlüsselt mit der Windows-Kontoverschlüsselung
const profileFile = () => path.join(app.getPath('userData'), 'meine-daten.json');
ipcMain.handle('profile:get', () => {
  try { const o = JSON.parse(fs.readFileSync(profileFile(), 'utf8')); return JSON.parse(decryptKey(o.data) || '{}'); } catch { return {}; }
});
ipcMain.handle('profile:set', (_e, data) => {
  const clean = {};
  for (const [k, v] of Object.entries(data || {})) if (typeof v === 'string' && v.trim() && k.length < 40) clean[k] = v.slice(0, 300);
  fs.mkdirSync(path.dirname(profileFile()), { recursive: true });
  if (!Object.keys(clean).length) { try { fs.unlinkSync(profileFile()); } catch { /* nichts da */ } return true; }
  fs.writeFileSync(profileFile(), JSON.stringify({ data: encryptKey(JSON.stringify(clean)) }));
  return true;
});
// Zuletzt geöffnet und offene Tabs (nur Pfade, keine Inhalte)
const stateFile = () => path.join(app.getPath('userData'), 'session.json');
function loadState() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return { recent: [], session: [] }; } }
function saveState(st) { try { fs.mkdirSync(path.dirname(stateFile()), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(st)); } catch { /* egal */ } }
function addRecent(p) {
  const st = loadState();
  st.recent = [p, ...(st.recent || []).filter(x => x.toLowerCase() !== p.toLowerCase())].slice(0, 12);
  saveState(st);
}
ipcMain.handle('recent:list', () => (loadState().recent || []).filter(p => fs.existsSync(p)).map(p => ({ path: p, name: path.basename(p), dir: path.dirname(p) })));
ipcMain.handle('recent:clear', () => { const st = loadState(); st.recent = []; saveState(st); return true; });
ipcMain.handle('file:openPath', (_e, p) => (typeof p === 'string' && /\.pdf$/i.test(p) && fs.existsSync(p) ? readPdf(p) : null));
// Jedes Fenster meldet seine Tabs, gespeichert wird die Summe aller Fenster
const sessionParts = new Map();
function writeSession() { const st = loadState(); st.session = [...sessionParts.values()].flat().slice(0, 30); saveState(st); }
ipcMain.handle('session:save', (e, list) => { sessionParts.set(e.sender.id, Array.isArray(list) ? list.slice(0, 30) : []); writeSession(); return true; });
ipcMain.handle('session:load', () => (loadState().session || []).filter(t => t?.path && fs.existsSync(t.path)));
// Drucken über den Windows-Druckdialog
ipcMain.handle('print:run', (e, o = {}) => new Promise((res) => {
  const opts = { silent: false, printBackground: true, margins: { marginType: 'none' }, landscape: !!o.landscape };
  if (['simplex', 'longEdge', 'shortEdge'].includes(o.duplexMode)) opts.duplexMode = o.duplexMode;
  if (Number.isInteger(o.copies) && o.copies > 1 && o.copies < 100) opts.copies = o.copies;
  e.sender.print(opts, (ok, reason) => res({ ok, reason }));
}));
ipcMain.handle('win:fullscreen', (e, on) => { const w = BrowserWindow.fromWebContents(e.sender); if (!w) return false; w.setFullScreen(typeof on === 'boolean' ? on : !w.isFullScreen()); return w.isFullScreen(); });
ipcMain.handle('win:close', (e) => { BrowserWindow.fromWebContents(e.sender)?.close(); });

/* ---------- Tabs in eigene Fenster ziehen ---------- */
// Tab aus dem Fenster gezogen: neues Fenster dort öffnen, wo die Maus losgelassen wurde
ipcMain.handle('tab:tearOff', (e, payload, mode) => {
  const src = BrowserWindow.fromWebContents(e.sender);
  if (!src || !payload?.data) return false;
  const pt = screen.getCursorScreenPoint();
  const b = src.getBounds();
  const inside = pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height;
  if (mode === 'drop' && inside) return false; // im eigenen Fenster losgelassen
  const area = screen.getDisplayMatching(b).workArea;
  if (mode === 'side') {
    if (src.isFullScreen()) src.setFullScreen(false);
    if (src.isMaximized()) src.unmaximize();
    const half = Math.floor(area.width / 2);
    src.setBounds({ x: area.x, y: area.y, width: half, height: area.height });
    createWindow({ payload, bounds: { x: area.x + half, y: area.y, width: area.width - half, height: area.height } });
    return true;
  }
  let bounds;
  if (mode === 'drop') {
    const d = screen.getDisplayNearestPoint(pt).workArea;
    const width = Math.min(Math.max(900, Math.round(b.width * 0.8)), d.width), height = Math.min(Math.max(600, Math.round(b.height * 0.9)), d.height);
    // Die Tableiste landet ungefähr unter der Maus
    const x = Math.min(Math.max(d.x, pt.x - 120), d.x + d.width - width), y = Math.min(Math.max(d.y, pt.y - 60), d.y + d.height - height);
    bounds = { x, y, width, height };
  } else {
    bounds = { x: Math.min(b.x + 40, area.x + area.width - 900), y: Math.min(b.y + 40, area.y + area.height - 600), width: b.width, height: b.height };
  }
  createWindow({ payload, bounds });
  return true;
});
// Tab in ein anderes Tavi-Fenster gezogen: das Quellfenster gibt ihn ab
const pulls = new Map();
let pullSeq = 1;
ipcMain.handle('tab:pull', (e, srcId, tabId) => new Promise((res) => {
  const src = BrowserWindow.getAllWindows().find(w => w.webContents.id === Number(srcId));
  if (!src || src.webContents === e.sender) return res(null);
  const id = pullSeq++;
  const t = setTimeout(() => { pulls.delete(id); res(null); }, 30000);
  pulls.set(id, (p) => { clearTimeout(t); pulls.delete(id); res(p); });
  src.webContents.send('tab:give', { id, tabId });
}));
ipcMain.handle('tab:given', (_e, id, payload) => { pulls.get(id)?.(payload || null); return true; });
ipcMain.handle('win:id', (e) => e.sender.id);
ipcMain.handle('tab:menu', (e, info = {}) => new Promise((res) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const items = [
    { label: 'In neuem Fenster öffnen', enabled: !!info.canDetach, click: () => res('window') },
    { label: 'Nebeneinander anzeigen', enabled: !!info.canDetach, click: () => res('side') },
    { type: 'separator' },
    { label: 'Im Ordner zeigen', enabled: !!info.hasPath, click: () => res('folder') },
    { type: 'separator' },
    { label: 'Schließen', click: () => res('close') }
  ];
  Menu.buildFromTemplate(items).popup({ window: w, callback: () => setTimeout(() => res(null), 50) });
}));
ipcMain.handle('defaults:open', () => shell.openExternal('ms-settings:defaultapps'));
function sendFile(p) {
  const f = readPdf(p);
  if (f && win) win.webContents.send('open-file', f);
}
ipcMain.handle('link:open', (_e, url) => {
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) shell.openExternal(url);
});

/* ---------- Fenster & Menü ---------- */
function send(cmd) { owner()?.webContents.send('menu', cmd); }
function buildMenu() {
  const tpl = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'Datei', submenu: [
      { label: 'PDF öffnen …', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
      { label: 'PDFs zusammenführen …', accelerator: 'CmdOrCtrl+M', click: () => send('merge') },
      { label: 'Umwandeln in Word, PowerPoint, Excel, JPEG …', accelerator: 'CmdOrCtrl+E', click: () => send('export') },
      { label: 'Speichern', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
      { label: 'Speichern unter …', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('saveAs') },
      { type: 'separator' },
      { label: 'Markieren und kommentieren', accelerator: 'CmdOrCtrl+H', click: () => send('annotate') },
      { label: 'Ausfüllen und unterschreiben', accelerator: 'CmdOrCtrl+U', click: () => send('fill') },
      { label: 'Seiten verwalten …', accelerator: 'CmdOrCtrl+G', click: () => send('pages') },
      { label: 'Texterkennung (OCR) …', click: () => send('ocr') },
      { label: 'Bilder zu PDF …', click: () => send('images') },
      { label: 'Tab schließen', accelerator: 'CmdOrCtrl+W', click: () => send('closeTab') },
      { label: 'Neues Fenster', accelerator: 'CmdOrCtrl+N', click: () => createWindow({ empty: true }) },
      { label: 'Tab in neues Fenster', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('detachTab') },
      { type: 'separator' },
      { label: 'Einstellungen …', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
      { type: 'separator' },
      { role: 'quit', label: 'Beenden' }
    ] },
    { label: 'Bearbeiten', submenu: [
      { label: 'Rückgängig', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
      { label: 'Wiederholen', accelerator: 'CmdOrCtrl+Y', click: () => send('redo') },
      { type: 'separator' },
      { role: 'cut', label: 'Ausschneiden' }, { role: 'copy', label: 'Kopieren' }, { role: 'paste', label: 'Einfügen' },
      { role: 'selectAll', label: 'Alles auswählen' }
    ] },
    { label: 'Ansicht', submenu: [
      { label: 'Vergrößern', accelerator: 'CmdOrCtrl+Plus', click: () => send('zoomIn') },
      { label: 'Verkleinern', accelerator: 'CmdOrCtrl+-', click: () => send('zoomOut') },
      { label: 'Seitenbreite', accelerator: 'CmdOrCtrl+0', click: () => send('fit') },
      { type: 'separator' },
      { label: 'KI-Assistent ein/aus', accelerator: 'CmdOrCtrl+J', click: () => send('panel') },
      { type: 'separator' },
      { label: 'Nächster Tab', accelerator: 'Ctrl+Tab', click: () => send('nextTab') },
      { label: 'Vorheriger Tab', accelerator: 'Ctrl+Shift+Tab', click: () => send('prevTab') },
      { type: 'separator' },
      { label: 'Vollbild', accelerator: 'F11', click: () => { const w = owner(); w?.setFullScreen(!w.isFullScreen()); } },
      { label: 'Präsentation', accelerator: 'F5', click: () => send('present') },
      { role: 'toggleDevTools', label: 'Entwicklertools' }
    ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

function createWindow(o = {}) {
  const first = BrowserWindow.getAllWindows().length === 0;
  const w = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600, ...(o.bounds || {}),
    title: 'Tavi',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#12161c' : '#eef1f4',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  if (!win) win = w;
  const wcId = w.webContents.id;
  w.on('focus', () => { win = w; });
  w.on('closed', () => {
    // Tabs eines geschlossenen Fensters nicht wieder öffnen, außer es war das letzte (Programm wird beendet)
    if (BrowserWindow.getAllWindows().length > 0 && sessionParts.delete(wcId)) writeSession();
    if (win === w) win = BrowserWindow.getAllWindows()[0] || null;
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.on('did-finish-load', () => {
    if (o.payload) { w.webContents.send('tab:receive', o.payload); o.payload = null; }
    if (first && pendingPath) { sendFile(pendingPath); pendingPath = null; }
  });
  w.loadURL(first ? 'app://tavi/src/index.html' : 'app://tavi/src/index.html?fenster=2');
  return w;
}

const argPdf = (argv) => argv.slice(1).find(a => a.toLowerCase().endsWith('.pdf') && fs.existsSync(a));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const p = argPdf(argv);
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); if (p) sendFile(p); }
  });
  app.on('open-file', (e, p) => { e.preventDefault(); if (win) sendFile(p); else pendingPath = p; });
  app.whenReady().then(async () => {
    if (await offerMoveToApplications()) return; // Tavi startet aus „Programme“ neu
    pendingPath = pendingPath || argPdf(process.argv);
    registerAppProtocol();
    buildMenu();
    createWindow();
    require('./updater').init({ getWin: () => win, loadSettings, saveSettings });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
