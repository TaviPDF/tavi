// Werkzeuge: Texterkennung, Schwärzen, Verkleinern, Aufteilen, einzelne Seitenbefehle, Vergleichen.
// Alles läuft lokal auf dem PC.

const L = () => window.PDFLib;

/* ---------- Unsichtbarer Text (für OCR und Schwärzen) ---------- */
function textWriter(pdf) {
  let font = null;
  const keys = new Map();
  const okChar = new Map();
  return {
    async setup() { font ||= await pdf.embedFont(L().StandardFonts.Helvetica); },
    clean(str) {
      let out = '';
      for (const ch of str) {
        if (!okChar.has(ch)) { try { font.encodeText(ch); okChar.set(ch, true); } catch { okChar.set(ch, false); } }
        out += okChar.get(ch) ? ch : '?';
      }
      return out;
    },
    // runs: { text, x, y (Grundlinie), dx, dy (Richtung, Einheitsvektor), width, size }
    add(page, runs) {
      const { PDFName, beginText, endText, setFontAndSize, setTextRenderingMode, TextRenderingMode, setCharacterSqueeze, setTextMatrix, showText, pushGraphicsState, popGraphicsState } = L();
      let key = keys.get(page);
      if (!key) { key = page.node.newFontDictionary('TaviTxt', font.ref); keys.set(page, key); }
      const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
      for (const r of runs) {
        const t = this.clean(r.text);
        if (!t.trim() || r.size < 1) continue;
        const natural = font.widthOfTextAtSize(t, r.size);
        if (!natural) continue;
        const tz = Math.max(10, Math.min(400, (100 * r.width) / natural));
        ops.push(setFontAndSize(key, r.size), setCharacterSqueeze(tz), setTextMatrix(r.dx, r.dy, -r.dy, r.dx, r.x, r.y), showText(font.encodeText(t)));
      }
      ops.push(endText(), popGraphicsState());
      page.pushOperators(...ops);
      void PDFName;
    }
  };
}

const canvasFor = async (page, vp, withAnnots = true) => {
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp, intent: withAnnots ? 'print' : 'display' }).promise;
  return c;
};
const blobBytes = async (c, type, q) => new Uint8Array(await (await new Promise(r => c.toBlob(r, type, q))).arrayBuffer());

/* ================= Texterkennung (OCR) ================= */
let worker = null, seq = 0;
const pending = new Map();
function ocrWorker() {
  if (!worker) {
    worker = new Worker(new URL('./ocr-worker.js', import.meta.url));
    worker.onmessage = ({ data }) => { const p = pending.get(data.id); if (!p) return; pending.delete(data.id); data.ok ? p.res(data) : p.rej(new Error(data.error)); };
    worker.onerror = (e) => { for (const p of pending.values()) p.rej(new Error(e.message || 'Texterkennung abgebrochen')); pending.clear(); worker = null; };
  }
  return worker;
}
const call = (msg, transfer) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ocrWorker().postMessage({ ...msg, id }, transfer || []); });

export async function pageHasText(pdfjsPage) {
  const tc = await pdfjsPage.getTextContent();
  return tc.items.reduce((s, i) => s + (i.str || '').trim().length, 0) > 25;
}

// pdfjsDoc: geöffnetes pdf.js-Dokument derselben Bytes
export async function ocrPdf({ bytes, pdfjsDoc, lang = 'deu', pages, onProgress, signal }) {
  const { PDFDocument } = L();
  await call({ type: 'init', lang });
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const tw = textWriter(pdf);
  await tw.setup();
  let done = 0, words = 0;
  for (const n of pages) {
    if (signal?.aborted) throw new Error('abgebrochen');
    onProgress?.(done, pages.length, n);
    const page = await pdfjsDoc.getPage(n);
    const v1 = page.getViewport({ scale: 1 });
    const scale = Math.min(300 / 72, 3600 / Math.max(v1.width, v1.height));
    const vp = page.getViewport({ scale });
    const png = await blobBytes(await canvasFor(page, vp, false), 'image/png');
    const res = await call({ type: 'ocr', png: png.buffer }, [png.buffer]);
    const runs = [];
    for (const w of res.words) {
      if (w.conf < 20) continue;
      const bl = vp.convertToPdfPoint(w.x, w.y + w.h * 0.8);
      const br = vp.convertToPdfPoint(w.x + w.w, w.y + w.h * 0.8);
      const tl = vp.convertToPdfPoint(w.x, w.y);
      const dx = br[0] - bl[0], dy = br[1] - bl[1], len = Math.hypot(dx, dy) || 1;
      const size = Math.hypot(tl[0] - bl[0], tl[1] - bl[1]) / 0.8 * 0.95;
      runs.push({ text: w.text + ' ', x: bl[0], y: bl[1], dx: dx / len, dy: dy / len, width: len + size * 0.28, size });
    }
    words += runs.length;
    tw.add(pdf.getPage(n - 1), runs);
    done++;
  }
  onProgress?.(done, pages.length);
  return { bytes: await pdf.save({ useObjectStreams: false }), words };
}

/* ================= Schwärzen ================= */
// redactions: [{ page, rect:[x1,y1,x2,y2] }] in PDF-Koordinaten
export async function redactPdf({ bytes, pdfjsLib, pdfOptions, redactions, dpi = 200 }) {
  const { PDFDocument } = L();
  const src = await PDFDocument.load(bytes, { updateMetadata: false });
  const task = pdfjsLib.getDocument({ ...pdfOptions, data: bytes.slice() });
  const jsdoc = await task.promise;
  const tw = textWriter(src);
  await tw.setup();
  const byPage = new Map();
  for (const r of redactions) (byPage.get(r.page) || byPage.set(r.page, []).get(r.page)).push(r.rect);
  const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  try {
    for (const [n, rects] of [...byPage].sort((a, b) => b[0] - a[0])) {
      const page = await jsdoc.getPage(n);
      const vp = page.getViewport({ scale: dpi / 72, rotation: 0 });
      const c = await canvasFor(page, vp, true);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#000';
      for (const r of rects) {
        const [ax, ay] = vp.convertToViewportPoint(r[0], r[1]);
        const [bx, by] = vp.convertToViewportPoint(r[2], r[3]);
        ctx.fillRect(Math.min(ax, bx) - 1, Math.min(ay, by) - 1, Math.abs(bx - ax) + 2, Math.abs(by - ay) + 2);
      }
      // Text behalten, der nicht geschwärzt wurde (zeichenweise geschätzt)
      const tc = await page.getTextContent();
      const runs = [];
      for (const it of tc.items) {
        if (!it.str?.trim()) continue;
        const [a, b, , , e, f] = it.transform;
        const size = Math.hypot(a, b) || it.height || 10;
        const dx = a / size, dy = b / size;
        const chars = [...it.str];
        const per = (it.width || size * chars.length * 0.5) / chars.length;
        let cur = null;
        chars.forEach((ch, i) => {
          const x = e + dx * per * i, y = f + dy * per * i;
          const box = [Math.min(x, x + dx * per) - 0.1, y - size * 0.25, Math.max(x, x + dx * per) + 0.1, y + size * 0.85];
          const hit = rects.some(r => overlaps(box, r));
          if (hit) { if (cur) runs.push(cur); cur = null; return; }
          if (!cur) cur = { text: '', x, y, dx, dy, width: 0, size };
          cur.text += ch; cur.width += per;
        });
        if (cur) runs.push(cur);
      }
      const jpg = await blobBytes(c, 'image/jpeg', 0.9);
      const old = src.getPage(n - 1);
      const [x0, y0, x1, y1] = page.view;
      const rot = old.getRotation().angle;
      src.removePage(n - 1);
      const np = src.insertPage(n - 1, [x1 - x0, y1 - y0]);
      np.setMediaBox(x0, y0, x1 - x0, y1 - y0);
      np.setRotation(L().degrees(rot));
      const img = await src.embedJpg(jpg);
      np.drawImage(img, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
      tw.add(np, runs);
    }
  } finally { task.destroy(); }
  // Neu aufbauen, damit gelöschte Inhalte wirklich nicht mehr in der Datei stecken
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, src.getPageIndices());
  copied.forEach(p => out.addPage(p));
  try { const t = src.getTitle(); if (t) out.setTitle(t); } catch { /* egal */ }
  return out.save({ useObjectStreams: true });
}

/* ================= Verkleinern ================= */
export const COMPRESS_LEVELS = { leicht: { max: 2480, q: 0.8 }, mittel: { max: 1754, q: 0.7 }, stark: { max: 1240, q: 0.55 } };
export async function compressPdf(bytes, level = 'mittel', onProgress) {
  const { PDFDocument, PDFName, PDFRawStream, PDFArray, PDFNumber, decodePDFRawStream } = L();
  const { max, q } = COMPRESS_LEVELS[level] || COMPRESS_LEVELS.mittel;
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = pdf.context;
  const N = (k) => PDFName.of(k);
  const list = [...ctx.enumerateIndirectObjects()].filter(([, o]) => o instanceof PDFRawStream && o.dict.lookup(N('Subtype')) === N('Image'));
  let i = 0, changed = 0;
  for (const [ref, img] of list) {
    onProgress?.(++i, list.length);
    const d = img.dict;
    const w = d.lookup(N('Width'))?.asNumber(), h = d.lookup(N('Height'))?.asNumber();
    if (!w || !h || w * h < 160 * 160) continue;
    if (d.lookup(N('ImageMask')) || d.lookup(N('Decode')) || d.lookup(N('Mask'))) continue;
    let filter = d.lookup(N('Filter'));
    if (filter instanceof PDFArray) filter = filter.size() === 1 ? filter.lookup(0) : null;
    const cs = d.lookup(N('ColorSpace'));
    const bpc = d.lookup(N('BitsPerComponent'))?.asNumber();
    let bmp = null;
    try {
      if (filter === N('DCTDecode')) {
        if (cs === N('DeviceCMYK')) continue;
        bmp = await createImageBitmap(new Blob([img.contents], { type: 'image/jpeg' }));
      } else if (filter === N('FlateDecode') && bpc === 8 && (cs === N('DeviceRGB') || cs === N('DeviceGray')) && !d.lookup(N('DecodeParms'))) {
        const raw = decodePDFRawStream(img).decode();
        const ch = cs === N('DeviceRGB') ? 3 : 1;
        if (raw.length < w * h * ch) continue;
        const id = new ImageData(w, h);
        for (let p = 0, s = 0; p < w * h; p++, s += ch) {
          id.data[p * 4] = raw[s]; id.data[p * 4 + 1] = raw[s + (ch === 3 ? 1 : 0)]; id.data[p * 4 + 2] = raw[s + (ch === 3 ? 2 : 0)]; id.data[p * 4 + 3] = 255;
        }
        bmp = await createImageBitmap(id);
      } else continue;
    } catch { continue; }
    const sc = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * sc)); c.height = Math.max(1, Math.round(h * sc));
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const jpg = await blobBytes(c, 'image/jpeg', q);
    if (jpg.length >= img.contents.length * 0.92) continue;
    const nd = { Type: 'XObject', Subtype: 'Image', Width: PDFNumber.of(c.width), Height: PDFNumber.of(c.height), ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' };
    const smask = d.get(N('SMask'));
    if (smask) nd.SMask = smask;
    ctx.assign(ref, ctx.stream(jpg, nd));
    changed++;
  }
  const out = await pdf.save({ useObjectStreams: true });
  return { bytes: out, images: list.length, changed };
}

/* ================= Aufteilen und Seitenbefehle ================= */
export async function extractGroups(bytes, groups) {
  const { PDFDocument } = L();
  const src = await PDFDocument.load(bytes, { updateMetadata: false });
  const outs = [];
  for (const g of groups) {
    const out = await PDFDocument.create();
    (await out.copyPages(src, g.map(n => n - 1))).forEach(p => out.addPage(p));
    outs.push(await out.save({ useObjectStreams: true }));
  }
  return outs;
}
export async function pageOp(bytes, op, n) {
  const { PDFDocument, degrees } = L();
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const p = pdf.getPage(n - 1);
  if (op === 'blank') {
    const { width, height } = p.getSize();
    pdf.insertPage(n, [width, height]);
  } else if (op === 'rotate') p.setRotation(degrees((p.getRotation().angle + 90) % 360));
  else if (op === 'delete') {
    if (pdf.getPageCount() < 2) throw new Error('Die letzte Seite kann nicht gelöscht werden.');
    pdf.removePage(n - 1);
  }
  return pdf.save({ useObjectStreams: false });
}

/* ================= Vergleichen ================= */
const norm = (w) => w.normalize('NFKC').toLowerCase().replace(/[„“"'‚‘’.,;:!?()[\]]/g, '');
// Myers-Differenz auf Wortebene
export function diffWords(a, b, limit = 6000) {
  const A = a.map(w => norm(w.t)), B = b.map(w => norm(w.t));
  let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length; while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const a2 = A.slice(s, ea), b2 = B.slice(s, eb), n = a2.length, m = b2.length, max = n + m;
  const off = max + 1, v = new Int32Array(2 * max + 3), trace = [];
  let found = n === 0 && m === 0 ? 0 : -1;
  for (let d = 0; d <= max && found < 0; d++) {
    if (d > limit) return null;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a2[x] === b2[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  // Rückweg
  const ops = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vv = trace[d], k = x - y;
    const prevK = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]) ? k + 1 : k - 1;
    const px = vv[off + prevK], py = px - prevK;
    while (x > px && y > py) { ops.push(['=', s + x - 1, s + y - 1]); x--; y--; }
    if (x === px) ops.push(['+', null, s + y - 1]); else ops.push(['-', s + x - 1, null]);
    x = px; y = py;
  }
  while (x > 0 && y > 0) { ops.push(['=', s + x - 1, s + y - 1]); x--; y--; }
  ops.reverse();
  const head = Array.from({ length: s }, (_, i) => ['=', i, i]);
  const tail = Array.from({ length: A.length - ea }, (_, i) => ['=', ea + i, eb + i]);
  return [...head, ...ops, ...tail];
}
export async function docWords(pdfjsDoc) {
  const words = [];
  for (let n = 1; n <= pdfjsDoc.numPages; n++) {
    const tc = await (await pdfjsDoc.getPage(n)).getTextContent();
    const text = tc.items.map(i => i.str + (i.hasEOL ? ' ' : '')).join(' ');
    for (const t of text.split(/\s+/)) if (t) words.push({ t, page: n });
  }
  return words;
}
