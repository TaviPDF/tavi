/* PDF umwandeln in Word (.docx), PowerPoint (.pptx), Excel (.xlsx) oder JPEG-Bilder. */
import { parseRanges, formatRanges } from './merge.js';

/* ================= Textlage auswerten ================= */
// Ein PDF kennt nur Textstücke an Positionen. Daraus bauen wir Zeilen, Absätze und Spalten.
export async function pageLayout(page) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (!('str' in it) || !it.str || !it.str.trim()) continue;
    const [a, b, , , e, f] = it.transform;
    const size = Math.hypot(a, b) || it.height || 10;
    const style = tc.styles?.[it.fontName] || {};
    items.push({
      str: it.str, x: e, base: vp.height - f, w: it.width || it.str.length * size * 0.5, size,
      bold: /bold|black|heavy|semibold|demi/i.test(`${it.fontName} ${style.fontFamily || ''}`)
    });
  }
  items.sort((p, q) => p.base - q.base || p.x - q.x);
  const lines = [];
  for (const it of items) {
    const ln = lines[lines.length - 1];
    if (ln && Math.abs(it.base - ln.base) < Math.max(ln.size, it.size) * 0.45) ln.items.push(it);
    else lines.push({ base: it.base, size: it.size, items: [it] });
    const cur = lines[lines.length - 1];
    cur.size = Math.max(cur.size, it.size);
  }
  for (const ln of lines) {
    ln.items.sort((p, q) => p.x - q.x);
    // Zellen (für Tabellen): große Lücken trennen
    ln.cells = [];
    let text = '';
    let cell = null;
    let prev = null;
    for (const it of ln.items) {
      const gap = prev ? it.x - (prev.x + prev.w) : 0;
      if (!cell || gap > Math.max(ln.size * 1.1, 6)) {
        cell = { x: it.x, end: it.x + it.w, text: it.str };
        ln.cells.push(cell);
        if (prev) text += /\s$/.test(text) ? '' : ' ';
      } else {
        const space = gap > ln.size * 0.15 && !/\s$/.test(cell.text) && !/^\s/.test(it.str);
        cell.text += (space ? ' ' : '') + it.str;
        cell.end = it.x + it.w;
        if (space && !/\s$/.test(text)) text += ' ';
      }
      text += it.str;
      prev = it;
    }
    ln.cells.forEach(c => { c.text = c.text.replace(/\s+/g, ' ').trim(); });
    ln.cells = ln.cells.filter(c => c.text);
    // Aufzählungszeichen gehört zum Text dahinter, ist keine eigene Spalte
    if (ln.cells.length >= 2 && /^[•·▪◦‣●○■□–\-*]$/.test(ln.cells[0].text)) {
      ln.cells[1].text = ln.cells[0].text + ' ' + ln.cells[1].text;
      ln.cells[1].x = ln.cells[0].x;
      ln.cells.shift();
    }
    ln.text = text.replace(/\s+/g, ' ').trim();
    ln.x = ln.items[0].x;
    ln.end = Math.max(...ln.items.map(i => i.x + i.w));
    ln.top = ln.base - ln.size * 0.85;
    ln.bold = ln.items.every(i => i.bold || !i.str.trim());
  }
  return { width: vp.width, height: vp.height, lines: lines.filter(l => l.text) };
}

// Häufigste Schriftgröße (nach Zeichenanzahl) = Fließtext
function bodySize(layouts) {
  const count = new Map();
  for (const L of layouts) for (const ln of L.lines) {
    const k = Math.round(ln.size * 2) / 2;
    count.set(k, (count.get(k) || 0) + ln.text.length);
  }
  let best = 11, n = -1;
  for (const [k, v] of count) if (v > n) { best = k; n = v; }
  return best;
}

const BULLET = /^([•·▪◦‣●○■□–\-*])\s+/;

// Zeilen zu Absätzen zusammenfassen, Überschriften und Aufzählungen erkennen
export function paragraphs(layout, body) {
  const out = [];
  let cur = null;
  const lines = layout.lines;
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    if (ln.cells.length >= 2) {
      let k = li;
      while (k + 1 < lines.length && lines[k + 1].cells.length >= 2 && lines[k + 1].top - lines[k].base < lines[k].size * 2.2) k++;
      if (k > li) {
        const block = lines.slice(li, k + 1);
        out.push({ table: true, rows: tableRows({ lines: block }), x: Math.min(...block.map(l => l.x)), top: block[0].top, end: Math.max(...block.map(l => l.end)), bottom: block[block.length - 1].base + block[block.length - 1].size * 0.4, size: block[0].size });
        cur = null;
        li = k;
        continue;
      }
    }
    const bullet = BULLET.test(ln.text);
    const rel = ln.size / body;
    const level = bullet ? 0 : rel >= 1.5 ? 1 : rel >= 1.2 ? 2 : (rel >= 1.08 || (ln.bold && ln.text.length < 90 && rel >= 0.95 && ln.cells.length < 2)) ? 3 : 0;
    const text = bullet ? ln.text.replace(BULLET, '') : ln.text;
    const gap = cur ? ln.top - cur.bottom : Infinity;
    const sameStyle = cur && cur.level === level && Math.abs(cur.size - ln.size) < ln.size * 0.12;
    const joins = cur && !bullet && sameStyle && level === 0 && gap < ln.size * 0.9 && !cur.bulletEnd;
    const headJoins = cur && !bullet && sameStyle && level > 0 && gap < ln.size * 0.5;
    if (joins || headJoins) {
      // Silbentrennung am Zeilenende zusammenführen
      if (/[a-zäöüß]-$/i.test(cur.text) && /^[a-zäöüß]/.test(text)) cur.text = cur.text.slice(0, -1) + text;
      else cur.text += ' ' + text;
      cur.bottom = ln.base + ln.size * 0.25;
      cur.end = Math.max(cur.end, ln.end);
      cur.lines.push(ln);
    } else {
      cur = { text, level, bullet, size: ln.size, bold: ln.bold, x: ln.x, top: ln.top, end: ln.end, bottom: ln.base + ln.size * 0.25, lines: [ln] };
      out.push(cur);
    }
  }
  return out;
}

/* ================= Hilfen ================= */
async function renderJpeg(page, dpi, quality = 0.9) {
  const vp = page.getViewport({ scale: dpi / 72 });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp, background: 'rgb(255,255,255)' }).promise;
  const blob = await new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('Bild konnte nicht erstellt werden.'))), 'image/jpeg', quality));
  const buf = new Uint8Array(await blob.arrayBuffer());
  c.width = c.height = 0; // Speicher freigeben
  return { bytes: buf, w: vp.width, h: vp.height };
}
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const xmlEsc = (s) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const colName = (i) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

/* ================= Word ================= */
async function toDocx(ctx) {
  const D = window.docx;
  const { pages, opts, progress } = ctx;
  const sections = [];
  if (opts.docxMode === 'images') {
    for (let i = 0; i < pages.length; i++) {
      progress(i, pages.length, `Seite ${pages[i]} wird gezeichnet`);
      const page = await ctx.pdf.getPage(pages[i]);
      const img = await renderJpeg(page, 150, 0.88);
      const v = page.getViewport({ scale: 1 });
      const px = (pt) => Math.round(pt * 96 / 72);
      sections.push({
        properties: { page: { size: { width: Math.round(v.width * 20), height: Math.round(v.height * 20) }, margin: { top: 0, bottom: 0, left: 0, right: 0, header: 0, footer: 0 } } },
        children: [new D.Paragraph({ spacing: { before: 0, after: 0, line: 240 }, children: [new D.ImageRun({ type: 'jpg', data: img.bytes, transformation: { width: px(v.width) - 2, height: Math.floor(px(v.height) * 0.985) } })] })]
      });
    }
  } else {
    const layouts = [];
    for (let i = 0; i < pages.length; i++) {
      progress(i, pages.length, `Seite ${pages[i]} wird gelesen`);
      layouts.push(await pageLayout(await ctx.pdf.getPage(pages[i])));
    }
    if (!layouts.some(L => L.lines.length)) throw new Error('Dieses PDF enthält keinen auswählbaren Text (vermutlich eingescannt). Wähle bei Word „Seiten als Bilder“.');
    const body = bodySize(layouts);
    const HL = { 1: D.HeadingLevel.HEADING_1, 2: D.HeadingLevel.HEADING_2, 3: D.HeadingLevel.HEADING_3 };
    const children = [];
    layouts.forEach((L, idx) => {
      const paras = paragraphs(L, body);
      paras.forEach((p, j) => {
        const pageBreak = idx > 0 && j === 0 && opts.docxPageBreak;
        if (p.table) {
          if (pageBreak) children.push(new D.Paragraph({ pageBreakBefore: true, children: [] }));
          const ncol = Math.max(...p.rows.map(r => r.length));
          children.push(new D.Table({
            width: { size: 100, type: D.WidthType.PERCENTAGE },
            rows: p.rows.map((r, ri) => new D.TableRow({
              tableHeader: ri === 0,
              children: Array.from({ length: ncol }, (_, c) => new D.TableCell({
                margins: { top: 40, bottom: 40, left: 80, right: 80 },
                children: [new D.Paragraph({ children: [new D.TextRun({ text: r[c] || '', bold: ri === 0 || undefined })] })]
              }))
            }))
          }));
          children.push(new D.Paragraph({ children: [] }));
          return;
        }
        children.push(new D.Paragraph({
          heading: p.level ? HL[p.level] : undefined,
          bullet: p.bullet ? { level: 0 } : undefined,
          pageBreakBefore: pageBreak || undefined,
          spacing: { after: p.level ? 80 : 120 },
          children: [new D.TextRun({ text: p.text, bold: p.level === 0 && p.bold ? true : undefined })]
        }));
      });
    });
    sections.push({ properties: {}, children });
  }
  progress(pages.length, pages.length, 'Word-Datei wird geschrieben');
  const doc = new D.Document({
    creator: 'Tavi', title: ctx.baseName,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections
  });
  const blob = await D.Packer.toBlob(doc);
  return [{ name: `${ctx.baseName}.docx`, data: new Uint8Array(await blob.arrayBuffer()), filterName: 'Word-Dokument', ext: 'docx' }];
}

/* ================= PowerPoint ================= */
async function toPptx(ctx) {
  const { pages, opts, progress } = ctx;
  const pptx = new window.PptxGenJS();
  const first = (await ctx.pdf.getPage(pages[0])).getViewport({ scale: 1 });
  const SW = first.width / 72, SH = first.height / 72; // Zoll
  pptx.defineLayout({ name: 'PDF', width: SW, height: SH });
  pptx.layout = 'PDF';
  pptx.title = ctx.baseName;
  pptx.company = 'Tavi';
  let body = null;
  for (let i = 0; i < pages.length; i++) {
    progress(i, pages.length, `Folie ${i + 1} von ${pages.length}`);
    const page = await ctx.pdf.getPage(pages[i]);
    const v = page.getViewport({ scale: 1 });
    // Seiten mit anderem Format mittig einpassen
    const k = Math.min(SW / (v.width / 72), SH / (v.height / 72));
    const ox = (SW - (v.width / 72) * k) / 2, oy = (SH - (v.height / 72) * k) / 2;
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    let layout = null;
    if (opts.pptxMode === 'text' || opts.pptxNotes) layout = await pageLayout(page);
    if (opts.pptxMode === 'images') {
      const img = await renderJpeg(page, 160, 0.88);
      slide.addImage({ data: 'data:image/jpeg;base64,' + b64(img.bytes), x: ox, y: oy, w: (v.width / 72) * k, h: (v.height / 72) * k });
    } else {
      if (!body) body = bodySize([layout]);
      for (const p of paragraphs(layout, body)) {
        const x = ox + (p.x / 72) * k, y = oy + (p.top / 72) * k;
        if (p.table) {
          const ncol = Math.max(...p.rows.map(r => r.length));
          slide.addTable(p.rows.map((r, ri) => Array.from({ length: ncol }, (_, c) => ({ text: r[c] || '', options: { bold: ri === 0 } }))), {
            x, y, w: Math.min(SW - x - 0.1, Math.max(1, ((p.end - p.x) / 72) * k * 1.15)),
            fontFace: 'Calibri', fontSize: Math.max(6, Math.round(p.size * k * 10) / 10), color: '1B2430',
            border: { type: 'solid', pt: 0.5, color: 'BFC6D1' }, margin: 0.04
          });
          continue;
        }
        const w = Math.max(0.5, ((p.end - p.x) / 72) * k * 1.04 + 0.1);
        const h = Math.max(0.2, ((p.bottom - p.top) / 72) * k);
        slide.addText((p.bullet ? '• ' : '') + p.text, {
          x, y, w: Math.min(w, SW - x), h, fontFace: 'Calibri', fontSize: Math.max(6, Math.round(p.size * k * 10) / 10),
          bold: p.level > 0 || p.bold, color: '1B2430', margin: 0, valign: 'top', fit: 'none', paraSpaceAfter: 0
        });
      }
    }
    if (opts.pptxNotes && layout?.lines.length) slide.addNotes(layout.lines.map(l => l.text).join('\n'));
  }
  progress(pages.length, pages.length, 'PowerPoint-Datei wird geschrieben');
  const data = await pptx.write({ outputType: 'uint8array', compression: true });
  return [{ name: `${ctx.baseName}.pptx`, data: new Uint8Array(data), filterName: 'PowerPoint-Präsentation', ext: 'pptx' }];
}

/* ================= Excel ================= */
// Zellen einer Seite in Spalten einsortieren, indem Zellanfänge geclustert werden
function tableRows(layout) {
  const lines = layout.lines.filter(l => l.cells.length);
  if (!lines.length) return [];
  const starts = lines.flatMap(l => l.cells.map(c => c.x)).sort((a, b) => a - b);
  const cols = [];
  for (const x of starts) {
    const last = cols[cols.length - 1];
    if (last && x - last.max < 9) { last.max = x; last.sum += x; last.n++; }
    else cols.push({ min: x, max: x, sum: x, n: 1 });
  }
  const centers = cols.map(c => c.sum / c.n);
  return lines.map(l => {
    const row = [];
    let lastCol = -1;
    for (const c of l.cells) {
      let best = 0, d = Infinity;
      centers.forEach((cx, i) => { const dd = Math.abs(cx - c.x); if (dd < d) { d = dd; best = i; } });
      if (best <= lastCol) best = lastCol + 1;
      row[best] = row[best] ? row[best] + ' ' + c.text : c.text;
      lastCol = best;
    }
    return row;
  });
}
// "1.234,56" / "1234.5" / "-3" → Zahl, sonst Text
function toNumber(s) {
  const t = s.replace(/\s/g, '');
  const pct = t.match(/^([-+]?\d+(?:[.,]\d+)?)%$/);
  if (pct) return { pct: Number(pct[1].replace(',', '.')) / 100 };
  if (/^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) return Number(t.replace(/\./g, '').replace(',', '.'));
  if (/^[-+]?\d+,\d+$/.test(t)) return Number(t.replace(',', '.'));
  if (/^[-+]?\d+(\.\d+)?$/.test(t) && !/^0\d/.test(t)) return Number(t);
  return null;
}
function sheetXml(rows) {
  const widths = [];
  const body = rows.map((row, r) => {
    const cells = [];
    (row || []).forEach((v, c) => {
      if (v == null || v === '') return;
      widths[c] = Math.max(widths[c] || 8, Math.min(60, String(v).length + 2));
      const ref = colName(c) + (r + 1);
      const n = typeof v === 'string' ? toNumber(v) : null;
      if (n && typeof n === 'object') cells.push(`<c r="${ref}" s="2"><v>${n.pct}</v></c>`);
      else if (n != null && Number.isFinite(n)) cells.push(`<c r="${ref}"><v>${n}</v></c>`);
      else cells.push(`<c r="${ref}" t="inlineStr"${row.header ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEsc(String(v))}</t></is></c>`);
    });
    return `<row r="${r + 1}">${cells.join('')}</row>`;
  }).join('');
  const cols = widths.length ? `<cols>${widths.map((w, i) => w ? `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>` : '').join('')}</cols>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`;
}
async function toXlsx(ctx) {
  const { pages, opts, progress } = ctx;
  const sheets = [];
  let any = false;
  const all = [];
  for (let i = 0; i < pages.length; i++) {
    progress(i, pages.length, `Seite ${pages[i]} wird ausgewertet`);
    const rows = tableRows(await pageLayout(await ctx.pdf.getPage(pages[i])));
    if (rows.length) any = true;
    if (opts.xlsxMode === 'one') {
      if (pages.length > 1) { const h = [`Seite ${pages[i]}`]; h.header = true; all.push(h); }
      all.push(...rows, []);
    } else sheets.push({ name: `Seite ${pages[i]}`, rows });
  }
  if (!any) throw new Error('Auf den gewählten Seiten wurde kein auswählbarer Text gefunden (vermutlich eingescannt).');
  if (opts.xlsxMode === 'one') sheets.push({ name: 'Inhalt', rows: all });
  progress(pages.length, pages.length, 'Excel-Datei wird geschrieben');
  const zip = new window.JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEsc(ctx.baseName)}</dc:title><dc:creator>Tavi</dc:creator></cp:coreProperties>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Standard" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)));
  const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return [{ name: `${ctx.baseName}.xlsx`, data, filterName: 'Excel-Arbeitsmappe', ext: 'xlsx' }];
}

/* ================= JPEG ================= */
async function toJpeg(ctx) {
  const { pages, opts, progress } = ctx;
  const out = [];
  const digits = String(Math.max(...pages)).length;
  for (let i = 0; i < pages.length; i++) {
    progress(i, pages.length, `Bild ${i + 1} von ${pages.length}`);
    const img = await renderJpeg(await ctx.pdf.getPage(pages[i]), Number(opts.jpegDpi), 0.92);
    out.push({ name: `${ctx.baseName} - Seite ${String(pages[i]).padStart(digits, '0')}.jpg`, data: img.bytes, filterName: 'JPEG-Bild', ext: 'jpg' });
    if (ctx.cancelled()) break;
  }
  return out;
}

const CONVERTERS = { docx: toDocx, pptx: toPptx, xlsx: toXlsx, jpeg: toJpeg };

/* ================= Fenster ================= */
export function initExport({ getDoc, toast, api }) {
  const $ = (id) => document.getElementById(id);
  const dlg = $('export');
  let fmt = 'docx';
  let running = false;
  let cancel = false;

  const opts = () => ({
    docxMode: document.querySelector('input[name="docxMode"]:checked').value,
    docxPageBreak: $('docxPageBreak').checked,
    pptxMode: document.querySelector('input[name="pptxMode"]:checked').value,
    pptxNotes: $('pptxNotes').checked,
    xlsxMode: document.querySelector('input[name="xlsxMode"]:checked').value,
    jpegDpi: document.querySelector('input[name="jpegDpi"]:checked').value
  });

  function selectFormat(f) {
    fmt = f;
    document.querySelectorAll('.fmt').forEach(b => {
      const on = b.dataset.fmt === f;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on);
      b.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll('.fmt-opts').forEach(p => { p.hidden = p.dataset.fmt !== f; });
    $('docxPageBreakRow').hidden = f !== 'docx' || opts().docxMode !== 'text';
    updateGo();
  }

  function selectedPages() {
    const doc = getDoc();
    const total = doc.pdf.numPages;
    const set = $('exRange').value.trim() ? parseRanges($('exRange').value, total) : new Set(Array.from({ length: total }, (_, i) => i + 1));
    return [...set].sort((a, b) => a - b);
  }

  function updateGo() {
    const doc = getDoc();
    if (!doc) return;
    let pages = [];
    try {
      pages = selectedPages();
      $('exRange').classList.remove('bad');
      $('exError').hidden = true;
    } catch (e) {
      $('exRange').classList.add('bad');
      $('exError').textContent = e.message;
      $('exError').hidden = false;
    }
    const n = pages.length;
    const total = doc.pdf.numPages;
    $('exCount').textContent = n === total ? `alle ${total} ${total === 1 ? 'Seite' : 'Seiten'}` : `${n} von ${total} Seiten`;
    const what = { docx: 'Word-Datei', pptx: `PowerPoint mit ${n} ${n === 1 ? 'Folie' : 'Folien'}`, xlsx: 'Excel-Datei', jpeg: `${n} JPEG-${n === 1 ? 'Bild' : 'Bilder'}` }[fmt];
    $('exSummary').textContent = n ? `Ergebnis: ${what}` : 'Keine Seiten gewählt';
    $('exGo').disabled = !n || running;
    $('exGo').textContent = fmt === 'jpeg' && n > 1 ? 'Umwandeln und in Ordner speichern …' : 'Umwandeln und speichern …';
  }

  function progress(done, total, label) {
    $('exProgress').hidden = false;
    $('exBar').style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
    $('exStatus').textContent = label;
  }

  async function run() {
    const doc = getDoc();
    if (!doc || running) return;
    let pages;
    try { pages = selectedPages(); } catch { return; }
    if (!pages.length) return;
    // Bei vielen Bildern zuerst den Ordner wählen, dann rechnen
    let dir = null;
    if (fmt === 'jpeg' && pages.length > 1) {
      dir = await api.pickFolder();
      if (!dir) return;
    }
    running = true; cancel = false;
    $('exGo').disabled = true;
    $('exCancel').textContent = 'Abbrechen';
    const baseName = doc.name.replace(/\.pdf$/i, '');
    try {
      const files = await CONVERTERS[fmt]({ pdf: doc.pdf, pages, opts: opts(), baseName, progress: (d, t, l) => { if (cancel) throw new Error('__abbruch__'); progress(d, t, l); }, cancelled: () => cancel });
      if (cancel) throw new Error('__abbruch__');
      if (dir) {
        progress(1, 1, 'Bilder werden gespeichert');
        let last = null;
        for (const f of files) {
          const r = await api.writeInto(dir, f.name, f.data);
          if (!r.ok) throw new Error(`Speichern fehlgeschlagen: ${r.message}`);
          last = r.path;
        }
        toast(`${files.length} Bilder gespeichert`);
        api.showInFolder(last);
      } else {
        const f = files[0];
        const r = await api.saveAs(f.data, f.name, f.filterName, f.ext);
        if (r.canceled) { $('exStatus').textContent = 'Nicht gespeichert.'; return; }
        if (!r.ok) throw new Error(`Speichern fehlgeschlagen: ${r.message}`);
        toast(`Gespeichert: ${r.name}`);
        api.showInFolder(r.path);
      }
      $('exBar').style.width = '100%';
      $('exStatus').textContent = 'Fertig.';
    } catch (e) {
      if (e.message === '__abbruch__') { $('exStatus').textContent = 'Abgebrochen.'; }
      else { console.error(e); $('exStatus').textContent = e.message || 'Umwandeln fehlgeschlagen.'; toast(e.message || 'Umwandeln fehlgeschlagen.'); }
    } finally {
      running = false;
      $('exCancel').textContent = 'Schließen';
      updateGo();
    }
  }

  $('exFormats').addEventListener('click', (e) => { const b = e.target.closest('.fmt'); if (b && !running) selectFormat(b.dataset.fmt); });
  $('exFormats').addEventListener('keydown', (e) => {
    const order = ['docx', 'pptx', 'xlsx', 'jpeg'];
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key) || running) return;
    e.preventDefault();
    const i = order.indexOf(fmt) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1);
    selectFormat(order[(i + order.length) % order.length]);
    document.querySelector('.fmt.on')?.focus();
  });
  dlg.addEventListener('change', (e) => { if (e.target.name === 'docxMode') selectFormat(fmt); });
  $('exRange').addEventListener('input', updateGo);
  $('exAll').onclick = () => { $('exRange').value = ''; updateGo(); };
  $('exCurrent').onclick = () => { $('exRange').value = String(getDoc()?.current || 1); updateGo(); };
  $('exGo').onclick = run;
  $('exCancel').onclick = () => { if (running) cancel = true; else dlg.close(); };
  $('exClose').onclick = () => { if (running) cancel = true; dlg.close(); };
  dlg.addEventListener('cancel', (e) => { if (running) { e.preventDefault(); cancel = true; } });

  return {
    open: () => {
      const doc = getDoc();
      if (!doc) return toast('Öffne zuerst ein PDF, das umgewandelt werden soll.');
      $('exDoc').textContent = doc.name;
      $('exRange').value = '';
      $('exProgress').hidden = true;
      $('exStatus').textContent = '';
      $('exCancel').textContent = 'Schließen';
      selectFormat(fmt);
      dlg.showModal();
    }
  };
}
export { formatRanges };
