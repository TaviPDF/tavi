// Texterkennung im Hintergrund (Tesseract, läuft komplett lokal)
/* global TesseractCore */
const base = new URL('./vendor/tesseract/', self.location.href).href;
importScripts(base + 'tesseract-core-simd-lstm.js');
let M = null, api = null, langs = '';
const loaded = new Set();

async function init(lang) {
  if (!M) M = await TesseractCore({ locateFile: (p) => base + p });
  if (api && langs === lang) return;
  if (api) { api.End(); M.destroy(api); }
  for (const l of lang.split('+')) {
    if (!loaded.has(l)) {
      loaded.add(l);
      const r = await fetch(base + `${l}.traineddata`);
      M.FS.writeFile(`${l}.traineddata`, new Uint8Array(await r.arrayBuffer()));
    }
  }
  api = new M.TessBaseAPI();
  if (api.Init(null, lang) !== 0) throw new Error('Sprachdaten konnten nicht geladen werden.');
  langs = lang;
}

function recognize(png) {
  M.FS.writeFile('/input', new Uint8Array(png));
  api.SetImageFile();
  const tsv = api.GetTSVText(0);
  const words = [];
  for (const row of tsv.split('\n')) {
    const c = row.split('\t');
    if (c[0] !== '5' || c.length < 12) continue;
    const text = c.slice(11).join('\t').trim();
    const conf = Number(c[10]);
    if (!text || conf < 0) continue;
    const [x, y, w, h] = c.slice(6, 10).map(Number);
    words.push({ text, x, y, w, h, line: `${c[2]}-${c[3]}-${c[4]}`, conf });
  }
  return words;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') { await init(data.lang); self.postMessage({ id: data.id, ok: true }); }
    else if (data.type === 'ocr') self.postMessage({ id: data.id, ok: true, words: recognize(data.png) });
  } catch (e) {
    self.postMessage({ id: data.id, ok: false, error: String(e?.message || e) });
  }
};
