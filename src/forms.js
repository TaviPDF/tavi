/* Formularfelder erkennen und ausgefüllte PDFs schreiben.
   Koordinaten: „Ansichtspunkte“ = Viewport mit scale 1 (Ursprung oben links, Einheit pt). */

let seq = 1;
export const newId = () => `f${Date.now().toString(36)}${(seq++).toString(36)}`;

/* ================= Erkennung ================= */
export async function detectFields(pdf, pdfjsLib, onProgress) {
  const all = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    onProgress?.(n, pdf.numPages);
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const acro = await acroFields(page, vp, n);
    if (acro.length) {
      const texts = await textBoxes(page, vp);
      for (const a of acro) {
        const lbl = findLabel(a.rect, texts, a.kind);
        if (lbl && !a.labelFixed) a.label = lbl;
        if (a.kind === 'text' && /datum|date|geburtstag/i.test(a.label + ' ' + (a.acro?.name || ''))) a.hint = 'date';
      }
    }
    const flat = await flatFields(page, vp, n, pdfjsLib, acro);
    all.push(...acro, ...flat);
  }
  return all;
}

// 1) Echte Formularfelder (AcroForm)
async function acroFields(page, vp, n) {
  const out = [];
  let annots = [];
  try { annots = await page.getAnnotations({ intent: 'display' }); } catch { return out; }
  for (const a of annots) {
    if (a.subtype !== 'Widget' || !a.rect || a.hidden) continue;
    const [x1, y1] = vp.convertToViewportPoint(a.rect[0], a.rect[1]);
    const [x2, y2] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
    const rect = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    if (rect.w < 3 || rect.h < 3) continue;
    const base = { id: newId(), page: n, rect, source: 'acro', readOnly: !!a.readOnly, label: a.alternativeText || prettyName(a.fieldName), labelFixed: !!a.alternativeText,
      acro: { name: a.fieldName, type: a.fieldType } };
    if (a.fieldType === 'Tx') {
      out.push({ ...base, kind: 'text', value: typeof a.fieldValue === 'string' ? a.fieldValue : '', multiLine: !!a.multiLine || rect.h > 30, maxLen: a.maxLen || 0 });
    } else if (a.fieldType === 'Btn' && a.checkBox) {
      out.push({ ...base, kind: 'check', value: !!a.fieldValue && a.fieldValue !== 'Off' && a.fieldValue === a.exportValue, acro: { ...base.acro, exportValue: a.exportValue } });
    } else if (a.fieldType === 'Btn' && a.radioButton) {
      out.push({ ...base, kind: 'radio', value: a.fieldValue === a.buttonValue, acro: { ...base.acro, exportValue: a.buttonValue } });
    } else if (a.fieldType === 'Ch') {
      const options = (a.options || []).map(o => ({ value: o.exportValue ?? o.displayValue, label: o.displayValue ?? o.exportValue }));
      const v = Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue;
      out.push({ ...base, kind: 'choice', value: v || '', options });
    } else if (a.fieldType === 'Sig') {
      out.push({ ...base, kind: 'sig', value: null });
    }
  }
  return out;
}
const prettyName = (s) => (s || '').split('.').pop().replace(/[_-]+/g, ' ').replace(/([a-zäöü])([A-ZÄÖÜ])/g, '$1 $2').trim();

// Textstücke der Seite als Rechtecke (Ansichtspunkte)
async function textBoxes(page, vp) {
  const tc = await page.getTextContent();
  const boxes = [];
  for (const it of tc.items) {
    if (!('str' in it) || !it.str || !it.str.trim()) continue;
    const m = multiply(vp.transform, it.transform);
    const size = Math.hypot(m[2], m[3]) || Math.hypot(it.transform[2], it.transform[3]) || 10;
    const x = m[4], base = m[5];
    const w = (it.width || 0) * vp.scale;
    const cw = w / Math.max(1, it.str.length);
    // „Ort, Datum: ______“ in Beschriftung und Schreiblinie aufteilen
    const re = /_{3,}|\.{5,}|…{2,}|·{5,}/g;
    let last = 0, mm;
    const piece = (a, b, filler) => {
      const str = it.str.slice(a, b);
      if (!str.trim()) return;
      const lead = str.length - str.trimStart().length, trail = str.length - str.trimEnd().length;
      boxes.push({ str: str.trim(), x: x + (a + lead) * cw, y: base - size * 0.85, w: (b - a - lead - trail) * cw, h: size * 1.1, base, size, filler });
    };
    while ((mm = re.exec(it.str))) { piece(last, mm.index, false); piece(mm.index, mm.index + mm[0].length, true); last = mm.index + mm[0].length; }
    piece(last, it.str.length, false);
  }
  return boxes;
}
const multiply = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// Gezeichnete Linien und Rechtecke aus der Operatorliste holen
async function shapes(page, vp, pdfjsLib) {
  const OPS = pdfjsLib.OPS;
  const ops = await page.getOperatorList({ annotationMode: pdfjsLib.AnnotationMode.DISABLE });
  const lines = [], rects = [], verticals = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const DRAW = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const STROKED = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const toView = (x, y) => { const [px, py] = apply(ctm, x, y); return vp.convertToViewportPoint(px, py); };
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = multiply(ctm, args);
    else if (fn === OPS.constructPath) {
      const [op, data] = args;
      if (!DRAW.has(op)) continue;
      const path = data?.[0];
      if (!path || (typeof Path2D !== 'undefined' && path instanceof Path2D) || typeof path.length !== 'number') continue;
      // Pfad in Teilpfade zerlegen
      const subs = [];
      let cur = null;
      for (let k = 0; k < path.length;) {
        const c = path[k++];
        if (c === 0) { cur = [[path[k], path[k + 1]]]; subs.push(cur); k += 2; }
        else if (c === 1) { if (!cur) { cur = []; subs.push(cur); } cur.push([path[k], path[k + 1]]); k += 2; }
        else if (c === 2) { cur?.push([path[k + 4], path[k + 5]]); k += 6; }
        else if (c === 3) { cur?.push([path[k + 2], path[k + 3]]); k += 4; }
        else if (c === 4) { if (cur?.length) cur.closed = true; }
        else break;
      }
      for (const s of subs) {
        if (!s.length) continue;
        const pts = s.map(([x, y]) => toView(x, y));
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        const b = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), stroked: STROKED.has(op) };
        if (b.h <= 2.5 && b.w >= 30) lines.push({ x: b.x, y: b.y + b.h / 2, w: b.w });
        else if (b.w <= 2.5 && b.h >= 8) verticals.push({ x: b.x + b.w / 2, y1: b.y, y2: b.y + b.h });
        else if (b.w >= 4 && b.h >= 4 && pts.length >= 4 && pts.length <= 6) {
          rects.push(b);
          if (b.h >= 8) { verticals.push({ x: b.x, y1: b.y, y2: b.y + b.h, frame: true }); verticals.push({ x: b.x + b.w, y1: b.y, y2: b.y + b.h, frame: true }); }
          // Rahmen eines Rechtecks zählt auch als Ober- und Unterlinie
          if (b.w >= 30) { lines.push({ x: b.x, y: b.y, w: b.w, frame: true }); lines.push({ x: b.x, y: b.y + b.h, w: b.w, frame: true }); }
        }
      }
    }
  }
  return { lines, rects, verticals };
}

// Freie Abschnitte eines waagerechten Bereichs (ohne Text darüber)
function freeRuns(x1, x2, y1, y2, texts, minW) {
  const busy = texts.filter(t => t.y < y2 && t.y + t.h > y1 && t.x < x2 && t.x + t.w > x1).map(t => [Math.max(x1, t.x - 3), Math.min(x2, t.x + t.w + 3)]).sort((a, b) => a[0] - b[0]);
  const runs = [];
  let at = x1;
  for (const [a, b] of busy) { if (a - at >= minW) runs.push([at, a]); at = Math.max(at, b); }
  if (x2 - at >= minW) runs.push([at, x2]);
  return runs;
}

// Beschriftung zu einem Feld: Text links daneben, sonst darüber
function findLabel(rect, texts, kind) {
  const cy = rect.y + rect.h / 2;
  let best = null, bd = Infinity;
  // Ankreuzfelder: Beschriftung steht meist rechts daneben
  if (kind === 'check' || kind === 'radio') {
    const right = texts.filter(t => !t.filler && Math.abs((t.y + t.h / 2) - cy) < Math.max(rect.h, t.h) * 0.8 && t.x >= rect.x + rect.w - 2 && t.x - (rect.x + rect.w) < 40)
      .sort((a, b) => a.x - b.x);
    if (right.length) {
      const row = [right[0]];
      for (const t of texts.filter(t => !t.filler && Math.abs((t.y + t.h / 2) - (right[0].y + right[0].h / 2)) < right[0].h * 0.5 && t.x > right[0].x).sort((a, b) => a.x - b.x)) {
        const prev = row[row.length - 1];
        if (t.x - (prev.x + prev.w) > 12) break; // nächstes Kästchen beginnt
        row.push(t);
      }
      return row.map(t => t.str).join(' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    }
  }
  for (const t of texts) {
    if (t.filler) continue;
    const tcy = t.y + t.h / 2;
    const leftGap = rect.x - (t.x + t.w);
    if (Math.abs(tcy - cy) < Math.max(rect.h, t.h) * 0.8 && leftGap > -2 && leftGap < 220) { const d = leftGap; if (d < bd) { bd = d; best = t; } }
  }
  if (!best) {
    for (const t of texts) {
      if (t.filler) continue;
      const above = rect.y - (t.y + t.h);
      if (above > -2 && above < 18 && t.x < rect.x + rect.w && t.x + t.w > rect.x - 10) { const d = above + 300; if (d < bd) { bd = d; best = t; } }
    }
  }
  if (!best) return '';
  // ganze Zeile links vom Feld nehmen, nicht nur das letzte Wort
  const row = texts.filter(t => !t.filler && Math.abs((t.y + t.h / 2) - (best.y + best.h / 2)) < best.h * 0.5 && t.x <= best.x + 1 && best.x - (t.x + t.w) < 40)
    .sort((a, b) => a.x - b.x);
  return row.map(t => t.str).join(' ').replace(/\s+/g, ' ').replace(/[:\s.]+$/, '').trim().slice(0, 60);
}

const CHECK_GLYPH = /[☐□▢❏❑❒◻⬜]/;

// 2) Felder in „flachen“ PDFs
async function flatFields(page, vp, n, pdfjsLib, acro) {
  const texts = await textBoxes(page, vp);
  const realText = texts.filter(t => !t.filler);
  let lines = [], rects = [], verticals = [];
  try { ({ lines, rects, verticals } = await shapes(page, vp, pdfjsLib)); } catch { /* ohne Grafik weiter */ }
  const found = [];
  const add = (f) => found.push({ id: newId(), page: n, source: 'auto', value: f.kind === 'check' ? false : '', ...f });

  // a) Kästchen zum Ankreuzen
  for (const r of rects) {
    if (Math.abs(r.w - r.h) <= Math.max(2, r.w * 0.2) && r.w >= 6 && r.w <= 20 && r.stroked) {
      const inside = realText.some(t => t.x < r.x + r.w - 1 && t.x + t.w > r.x + 1 && t.y < r.y + r.h - 1 && t.y + t.h > r.y + 1);
      if (!inside) add({ kind: 'check', rect: { x: r.x, y: r.y, w: r.w, h: r.h } });
    }
  }
  for (const t of texts) {
    const m = t.str.match(CHECK_GLYPH);
    if (m) {
      const k = t.str.indexOf(m[0]);
      const cw = t.w / Math.max(1, t.str.length);
      add({ kind: 'check', rect: { x: t.x + k * cw, y: t.base - t.size * 0.8, w: t.size * 0.85, h: t.size * 0.85 } });
    }
  }
  // b) Leere Kästen (Eingabefelder mit Rahmen)
  for (const r of rects) {
    if (r.w < 40 || r.h < 11 || r.h > 120) continue;
    if (Math.abs(r.w - r.h) <= 2 && r.w <= 20) continue;
    const inner = realText.filter(t => t.x < r.x + r.w && t.x + t.w > r.x && t.y < r.y + r.h && t.y + t.h > r.y);
    if (inner.length && inner.some(t => t.h > r.h * 0.75 && t.w > r.w * 0.5)) continue; // beschrifteter Kasten
    if (!inner.length) { add({ kind: 'text', rect: { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 }, multiLine: r.h > 34 }); continue; }
    // Kleine Beschriftung oben im Kasten: Feld darunter
    const bottom = Math.max(...inner.map(t => t.y + t.h));
    if (r.y + r.h - bottom >= 11) add({ kind: 'text', rect: { x: r.x + 1, y: bottom + 1, w: r.w - 2, h: r.y + r.h - bottom - 2 }, multiLine: r.y + r.h - bottom > 34 });
    else {
      const runs = freeRuns(r.x, r.x + r.w, r.y + 2, r.y + r.h - 2, realText, 40);
      for (const [a, b] of runs) if (a > r.x + 4) add({ kind: 'text', rect: { x: a, y: r.y + 1, w: b - a - 1, h: r.h - 2 } });
    }
  }
  // c) Linien zum Draufschreiben
  const sortedLines = lines.filter(l => !l.frame).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const l of sortedLines) {
    const inX = (v) => v.x > l.x + 2 && v.x < l.x + l.w - 2;
    const nearEnds = (v) => Math.abs(v.x - l.x) < 3 || Math.abs(v.x - (l.x + l.w)) < 3;
    // Senkrechte, die nur nach unten gehen: Oberkante einer Tabelle, darüber ist kein Feld
    const down = verticals.filter(v => (inX(v) || nearEnds(v)) && Math.abs(v.y1 - l.y) < 3 && v.y2 > l.y + 6);
    const up = verticals.filter(v => (inX(v) || nearEnds(v)) && v.y1 < l.y - 6 && v.y2 > l.y - 3);
    if (down.length && !up.length) continue;
    // Abstand zur nächsten Linie darüber (Tabellenzeile) bestimmt die Feldhöhe
    const above = lines.filter(o => o !== l && o.y < l.y - 6 && o.y > l.y - 45 && o.x < l.x + l.w - 10 && o.x + o.w > l.x + 10).sort((a, b) => b.y - a.y)[0];
    const h = up.length && above ? Math.min(40, l.y - above.y - 3) : Math.min(above ? l.y - above.y - 3 : 18, 18);
    if (h < 9) continue;
    const top = l.y - h;
    const cuts = up.filter(inX).map(v => v.x).sort((a, b) => a - b);
    if (cuts.length) {
      // Tabellenzeile: leere Zellen sind Felder, Zellen mit Text sind Beschriftungen
      const edges = [l.x, ...cuts, l.x + l.w];
      for (let i = 0; i < edges.length - 1; i++) {
        const a = edges[i], b = edges[i + 1];
        if (b - a < 30) continue;
        const busy = realText.some(t => t.y < l.y - 1 && t.y + t.h > top + 1 && t.x < b - 2 && t.x + t.w > a + 2);
        if (!busy) add({ kind: 'text', rect: { x: a + 2, y: top, w: b - a - 4, h: h - 1 } });
      }
    } else {
      const runs = freeRuns(l.x, l.x + l.w, top, l.y - 1, realText, 36);
      for (const [a, b] of runs) add({ kind: 'text', rect: { x: a + 1, y: top, w: b - a - 2, h: h - 1 } });
    }
  }
  // d) Unterstriche und Punktlinien im Text
  for (const t of texts) {
    if (!t.filler || t.w < 24) continue;
    add({ kind: 'text', rect: { x: t.x, y: t.base - t.size * 1.3, w: t.w, h: t.size * 1.4 } });
  }

  // Aufräumen: Überschneidungen mit echten Feldern und Dubletten entfernen
  const kept = [];
  const overlap = (a, b) => {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return (ix * iy) / Math.min(a.w * a.h, b.w * b.h);
  };
  found.sort((a, b) => (a.kind === 'check') - (b.kind === 'check') || b.rect.w * b.rect.h - a.rect.w * a.rect.h);
  for (const f of found) {
    if (f.rect.x < -2 || f.rect.y < -2 || f.rect.x + f.rect.w > vp.width + 2 || f.rect.y + f.rect.h > vp.height + 2) continue;
    if (acro.some(a => overlap(a.rect, f.rect) > 0.3)) continue;
    if (kept.some(k => k.kind === f.kind && overlap(k.rect, f.rect) > 0.5)) continue;
    if (f.kind === 'text' && kept.some(k => k.kind === 'check' && overlap(k.rect, f.rect) > 0.5)) continue;
    kept.push(f);
  }
  for (const f of kept) {
    f.label = findLabel(f.rect, texts, f.kind);
    // Unterschriftsfelder: Platz nach oben schaffen
    if (f.kind === 'text' && /unterschrift|signatur|signature|unterzeichn/i.test(f.label)) {
      f.kind = 'sig';
      const want = Math.max(f.rect.h, 30);
      f.rect = { ...f.rect, y: f.rect.y + f.rect.h - want, h: want };
      f.value = null;
    }
    if (f.kind === 'text' && /datum|date|geburtstag|geb\./i.test(f.label)) f.hint = 'date';
  }
  return kept;
}

/* ================= Speichern ================= */
// Zeichen, die die Standardschrift (WinAnsi) kann
const WIN_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const winAnsi = (s) => [...String(s)].map(c => {
  const code = c.codePointAt(0);
  if (c === '\n' || (code >= 32 && code <= 126) || (code >= 160 && code <= 255) || WIN_EXTRA.includes(c)) return c;
  return '?';
}).join('');

function wrap(text, font, size, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const t = line + word;
      if (line && font.widthOfTextAtSize(t.trimEnd(), size) > maxW) { out.push(line.trimEnd()); line = word.trimStart(); }
      else line = t;
    }
    out.push(line.trimEnd());
  }
  return out;
}

export const autoFontSize = (f) => f.fontSize || Math.max(7, Math.min(13, (f.multiLine ? 11 : f.rect.h * 0.62)));

export async function buildFilledPdf({ pdf, fields, flatten }) {
  const { PDFDocument, StandardFonts, rgb, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = window.PDFLib;
  const bytes = await pdf.getData();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.07, 0.09, 0.2);
  let form = null;
  try { form = doc.getForm(); } catch { /* kein Formular */ }
  const pages = doc.getPages();
  const vps = {};
  const vpOf = async (n) => (vps[n] ||= (await pdf.getPage(n)).getViewport({ scale: 1 }));
  const problems = [];

  for (const f of fields) {
    const empty = f.value == null || f.value === '' || f.value === false;
    // Echte Formularfelder direkt füllen
    if (f.source === 'acro' && form && f.kind !== 'sig') {
      try {
        const field = form.getField(f.acro.name);
        if (field instanceof PDFTextField) { field.setText(empty ? '' : winAnsi(f.value)); continue; }
        if (field instanceof PDFCheckBox) { f.value ? field.check() : field.uncheck(); continue; }
        if (field instanceof PDFRadioGroup) { if (f.value) field.select(f.acro.exportValue); continue; }
        if (field instanceof PDFDropdown || field instanceof PDFOptionList) { if (!empty) field.select(String(f.value)); continue; }
      } catch (e) { problems.push(f.label || f.acro.name); }
      // sonst: wie ein normales Feld einzeichnen
    }
    if (empty) continue;
    const page = pages[f.page - 1];
    if (!page) continue;
    const vp = await vpOf(f.page);
    const P = (x, y) => vp.convertToPdfPoint(x, y);
    const r = f.rect;
    if (f.kind === 'text' || f.kind === 'choice') {
      const size = autoFontSize(f);
      const text = winAnsi(f.kind === 'choice' ? (f.options?.find(o => o.value === f.value)?.label || f.value) : f.value);
      const lines = f.multiLine ? wrap(text, font, size, r.w - 4) : [text.replace(/\n/g, ' ')];
      const lh = size * 1.18;
      let y = f.multiLine ? r.y + 2 + size * 0.95 : r.y + r.h / 2 + size * 0.36;
      for (const ln of lines) {
        if (y > r.y + r.h + size * 0.3) break;
        const [px, py] = P(r.x + 2, y);
        page.drawText(ln, { x: px, y: py, size, font, color: ink });
        y += lh;
      }
    } else if (f.kind === 'check' || f.kind === 'radio') {
      const pad = Math.min(r.w, r.h) * 0.2;
      const a = P(r.x + pad, r.y + pad), b = P(r.x + r.w - pad, r.y + r.h - pad);
      const c = P(r.x + pad, r.y + r.h - pad), d = P(r.x + r.w - pad, r.y + pad);
      const thickness = Math.max(1, Math.min(r.w, r.h) * 0.12);
      page.drawLine({ start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, thickness, color: ink });
      page.drawLine({ start: { x: c[0], y: c[1] }, end: { x: d[0], y: d[1] }, thickness, color: ink });
    } else if (f.kind === 'sig' && f.value?.data) {
      const png = await doc.embedPng(f.value.data);
      // Bild ins Feld einpassen, Seitenverhältnis halten
      const ar = png.width / png.height;
      let w = r.w, h = r.w / ar;
      if (h > r.h) { h = r.h; w = r.h * ar; }
      const x = r.x + (r.w - w) / 2, y = r.y + (r.h - h) / 2;
      const [px, py] = P(x, y + h);
      page.drawImage(png, { x: px, y: py, width: w, height: h });
    }
  }
  if (form) {
    try {
      form.updateFieldAppearances(font);
      if (flatten) form.flatten();
    } catch { /* Darstellung bleibt dem Programm überlassen */ }
  }
  return { bytes: await doc.save(), problems };
}
