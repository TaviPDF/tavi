// Bilder für die KI: Seiten oder Ausschnitte als JPEG aufnehmen, Abbildungen im PDF finden.

const toB64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

// rect: Bereich in PDF-Koordinaten [x1, y1, x2, y2] oder null für die ganze Seite
export async function captureImage(pdfDoc, n, rect = null, maxSide = 1600, viewRot = 0) {
  const page = await pdfDoc.getPage(n);
  const rotation = (page.rotate + viewRot) % 360;
  const v1 = page.getViewport({ scale: 1, rotation });
  let scale, box;
  if (rect) {
    const a = v1.convertToViewportPoint(rect[0], rect[1]), b = v1.convertToViewportPoint(rect[2], rect[3]);
    const w1 = Math.abs(b[0] - a[0]), h1 = Math.abs(b[1] - a[1]);
    scale = Math.min(5, Math.max(1.5, maxSide / Math.max(w1, h1, 1)));
    box = { x: Math.min(a[0], b[0]) * scale, y: Math.min(a[1], b[1]) * scale, w: w1 * scale, h: h1 * scale };
  } else {
    scale = Math.min(3, maxSide / Math.max(v1.width, v1.height));
  }
  const vp = page.getViewport({ scale, rotation });
  const full = document.createElement('canvas');
  full.width = Math.ceil(vp.width); full.height = Math.ceil(vp.height);
  const fctx = full.getContext('2d');
  fctx.fillStyle = '#fff'; fctx.fillRect(0, 0, full.width, full.height);
  await page.render({ canvasContext: fctx, viewport: vp }).promise;
  let out = full;
  if (box) {
    out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(box.w)); out.height = Math.max(1, Math.round(box.h));
    out.getContext('2d').drawImage(full, box.x, box.y, box.w, box.h, 0, 0, out.width, out.height);
  }
  const blob = await new Promise(r => out.toBlob(r, 'image/jpeg', 0.86));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // kleines Vorschaubild für den Chat
  const t = document.createElement('canvas');
  const ts = Math.min(1, 220 / Math.max(out.width, out.height));
  t.width = Math.round(out.width * ts); t.height = Math.round(out.height * ts);
  t.getContext('2d').drawImage(out, 0, 0, t.width, t.height);
  return { mime: 'image/jpeg', data: toB64(bytes), thumb: t.toDataURL('image/jpeg', 0.8) };
}

// Abbildungen auf einer Seite finden (über die Zeichenbefehle des PDFs)
const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
export async function findImages(pdfjsLib, page) {
  const OPS = pdfjsLib.OPS;
  let ops;
  try { ops = await page.getOperatorList(); } catch { return []; }
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const out = [];
  const paint = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat, OPS.paintJpegXObject].filter(v => v != null));
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) ctm = mul(ctm, Array.from(args[0])); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (paint.has(fn)) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    }
  }
  // gleiche/überlappende Bilder zusammenfassen
  const merged = [];
  for (const r of out) {
    const m = merged.find(q => !(r[2] < q[0] || r[0] > q[2] || r[3] < q[1] || r[1] > q[3]));
    if (m) { m[0] = Math.min(m[0], r[0]); m[1] = Math.min(m[1], r[1]); m[2] = Math.max(m[2], r[2]); m[3] = Math.max(m[3], r[3]); }
    else merged.push([...r]);
  }
  return merged;
}

// Kleine Knöpfe „Bild erklären“ an Abbildungen
export async function addImageButtons(pdfjsLib, page, vp, pageEl, onExplain) {
  const rects = await findImages(pdfjsLib, page);
  pageEl.querySelectorAll('.img-btn').forEach(b => b.remove());
  const pageArea = vp.width * vp.height;
  for (const r of rects) {
    const a = vp.convertToViewportPoint(r[0], r[1]), b = vp.convertToViewportPoint(r[2], r[3]);
    const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
    if (w < 70 || h < 50 || (w * h) / pageArea > 0.85) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'img-btn';
    btn.title = 'Die KI beschreibt und erklärt diese Abbildung';
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.6 3.9 3.9 1.6-3.9 1.6L8 12.5 6.4 8.6 2.5 7l3.9-1.6z" fill="currentColor"/></svg>Bild erklären';
    btn.style.left = `${x + w - 6}px`;
    btn.style.top = `${y + 6}px`;
    btn.addEventListener('click', (e) => { e.stopPropagation(); onExplain(r); });
    pageEl.append(btn);
  }
}
