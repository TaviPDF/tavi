// Markieren und Kommentieren: Textmarker, Unterstreichen, Durchstreichen, Notizen, Stift, Radierer.
// Alles wird als normale PDF-Anmerkung gespeichert (mit Darstellung), damit Adobe, Edge & Co. es auch zeigen.

export const ANNOT_COLORS = [
  { id: 'yellow', name: 'Gelb', hex: '#FFD54A' },
  { id: 'green', name: 'Grün', hex: '#7EE08A' },
  { id: 'blue', name: 'Blau', hex: '#7CC4FF' },
  { id: 'pink', name: 'Rosa', hex: '#FF8FC8' },
  { id: 'red', name: 'Rot', hex: '#E5484D' }
];
const MARKUP = ['highlight', 'underline', 'strike'];
const EXISTING_TYPES = new Set(['Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Text', 'Ink', 'FreeText', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine', 'Stamp', 'Caret']);
const SVGNS = 'http://www.w3.org/2000/svg';
import { localPoint, localRect } from './geom.js';
export { EXISTING_TYPES };
const STAMP_RED = new Set(['ABGELEHNT', 'ENTWURF', 'VERTRAULICH', 'KOPIE']);
const DRAG_TOOLS = ['rect', 'arrow', 'redact-area'];
// Stempelmaße in PDF-Punkten (gleich für Anzeige und Speichern)
function stampSize(text) {
  const c = stampSize.c ||= document.createElement('canvas').getContext('2d');
  c.font = 'bold 18px Helvetica, Arial, sans-serif';
  return { w: Math.ceil(Math.max(c.measureText(text).width, 70) + 28), h: 40 };
}

export function initAnnotate({ getDoc, getScale, getPageEl, toast, onChange, onSave, onEnter }) {
  const $ = (id) => document.getElementById(id);
  let seq = 1;
  const A = (doc) => (doc.annot ||= { active: false, tool: 'highlight', color: 'yellow', items: [], removed: new Set(), undo: [], redo: [], existing: new Map() });

  /* ---------- Ansicht je Seite ---------- */
  const vpCache = new WeakMap();
  async function viewport(doc, n) {
    let m = vpCache.get(doc);
    if (!m) vpCache.set(doc, (m = new Map()));
    const key = `${n}@${getScale()}`;
    if (!m.has(key)) m.set(key, (await doc.pdf.getPage(n)).getViewport({ scale: getScale() }));
    return m.get(key);
  }

  async function renderPage(n) {
    const doc = getDoc();
    const pageEl = getPageEl(n);
    if (!doc || !pageEl) return;
    const S = A(doc);
    const items = S.items.filter(i => i.page === n);
    pageEl.querySelector('.annotLayer')?.remove();
    const showExisting = S.active && S.tool === 'erase';
    if (!items.length && !S.active && !S.removed.size) return;
    const vp = await viewport(doc, n);
    if (getDoc() !== doc) return;
    pageEl.querySelector('.annotLayer')?.remove();
    const layer = document.createElement('div');
    layer.className = 'annotLayer' + (S.active ? ` tool-${S.tool}` : '');
    layer.dataset.page = n;
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('width', vp.width); svg.setAttribute('height', vp.height);
    layer.append(svg);
    const P = (x, y) => vp.convertToViewportPoint(x, y);
    const box = (r) => { const [ax, ay] = P(r[0], r[1]); const [bx, by] = P(r[2], r[3]); return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) }; };

    for (const it of items) {
      const col = hex(it.color);
      const g = document.createElementNS(SVGNS, 'g');
      g.dataset.id = it.id;
      g.classList.add('an-item');
      if (MARKUP.includes(it.type)) {
        for (const r of it.rects) {
          const b = box(r);
          const hit = rectEl(b, 'transparent'); hit.classList.add('an-hit'); g.append(hit);
          if (it.type === 'highlight') { const e = rectEl(b, col); e.setAttribute('class', 'an-hl'); g.append(e); }
          else {
            const t = Math.max(1, b.h * 0.08);
            const y = it.type === 'underline' ? b.y + b.h - t / 2 : b.y + b.h * 0.55;
            const l = document.createElementNS(SVGNS, 'line');
            l.setAttribute('x1', b.x); l.setAttribute('x2', b.x + b.w); l.setAttribute('y1', y); l.setAttribute('y2', y);
            l.setAttribute('stroke', col); l.setAttribute('stroke-width', t);
            g.append(l);
          }
        }
      } else if (it.type === 'ink') {
        for (const path of it.paths) {
          const pl = document.createElementNS(SVGNS, 'polyline');
          pl.setAttribute('points', path.map(([x, y]) => P(x, y).join(',')).join(' '));
          pl.setAttribute('fill', 'none'); pl.setAttribute('stroke', col);
          pl.setAttribute('stroke-width', it.width * getScale()); pl.setAttribute('stroke-linecap', 'round'); pl.setAttribute('stroke-linejoin', 'round');
          g.append(pl);
          const hit = pl.cloneNode(); hit.setAttribute('stroke', 'transparent'); hit.setAttribute('stroke-width', Math.max(12, it.width * getScale() + 8)); hit.classList.add('an-hit'); g.append(hit);
        }
      } else if (it.type === 'rect' || it.type === 'redact') {
        const b = box(it.rect);
        const r = rectEl(b, it.type === 'redact' ? 'rgba(0,0,0,.55)' : 'none');
        r.setAttribute('stroke', it.type === 'redact' ? '#000' : col);
        r.setAttribute('stroke-width', it.type === 'redact' ? 1.5 : it.width * getScale());
        if (it.type === 'redact') r.setAttribute('class', 'an-redact');
        g.append(r);
        const hit = rectEl(b, 'transparent'); hit.classList.add('an-hit'); g.append(hit);
      } else if (it.type === 'arrow') {
        const [x1, y1] = P(it.from[0], it.from[1]); const [x2, y2] = P(it.to[0], it.to[1]);
        const w = it.width * getScale();
        const l = document.createElementNS(SVGNS, 'line');
        Object.entries({ x1, y1, x2, y2, stroke: col, 'stroke-width': w, 'stroke-linecap': 'round' }).forEach(([k, v]) => l.setAttribute(k, v));
        g.append(l);
        const head = document.createElementNS(SVGNS, 'polyline');
        const ang = Math.atan2(y2 - y1, x2 - x1), hl = Math.max(10, w * 5);
        head.setAttribute('points', [[x2 - hl * Math.cos(ang - 0.45), y2 - hl * Math.sin(ang - 0.45)], [x2, y2], [x2 - hl * Math.cos(ang + 0.45), y2 - hl * Math.sin(ang + 0.45)]].map(p => p.join(',')).join(' '));
        Object.entries({ fill: 'none', stroke: col, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }).forEach(([k, v]) => head.setAttribute(k, v));
        g.append(head);
        const hit = l.cloneNode(); hit.setAttribute('stroke', 'transparent'); hit.setAttribute('stroke-width', 14); hit.classList.add('an-hit'); g.append(hit);
      } else if (it.type === 'stamp') {
        const b = box([it.x, it.y - it.h, it.x + it.w, it.y]);
        const c = STAMP_RED.has(it.text) ? '#C62828' : '#2E7D32';
        const r = rectEl(b, 'rgba(255,255,255,.5)'); r.setAttribute('rx', 4 * getScale()); r.setAttribute('stroke', c); r.setAttribute('stroke-width', 2.2 * getScale());
        g.append(r);
        const t = document.createElementNS(SVGNS, 'text');
        Object.entries({ x: b.x + b.w / 2, y: b.y + b.h * 0.5, fill: c, 'text-anchor': 'middle', 'font-family': 'Helvetica, Arial, sans-serif', 'font-weight': 700, 'font-size': 18 * getScale() }).forEach(([k, v]) => t.setAttribute(k, v));
        t.textContent = it.text;
        const d = document.createElementNS(SVGNS, 'text');
        Object.entries({ x: b.x + b.w / 2, y: b.y + b.h * 0.85, fill: c, 'text-anchor': 'middle', 'font-family': 'Helvetica, Arial, sans-serif', 'font-size': 9 * getScale() }).forEach(([k, v]) => d.setAttribute(k, v));
        d.textContent = it.date;
        g.append(t, d);
        const hit = rectEl(b, 'transparent'); hit.classList.add('an-hit'); g.append(hit);
      }
      if (it.type !== 'note') svg.append(g);
      if (it.type === 'note') layer.append(noteEl(it, P));
    }
    // vorhandene Anmerkungen im PDF: löschbar mit dem Radierer
    if (showExisting || S.removed.size) {
      let list = S.existing.get(n);
      if (!list) {
        try {
          const annots = await (await doc.pdf.getPage(n)).getAnnotations({ intent: 'display' });
          list = annots.filter(a => EXISTING_TYPES.has(a.subtype) && a.rect && a.id).map(a => ({ id: a.id, rect: a.rect, subtype: a.subtype, text: a.contentsObj?.str || '' }));
        } catch { list = []; }
        S.existing.set(n, list);
      }
      for (const a of list) {
        const removed = S.removed.has(a.id);
        if (!removed && !showExisting) continue;
        const b = box(a.rect);
        const d = document.createElement('button');
        d.type = 'button';
        d.className = 'an-existing' + (removed ? ' removed' : '');
        d.title = removed ? 'Wird beim Speichern gelöscht. Klicken zum Behalten.' : 'Vorhandene Anmerkung löschen';
        Object.assign(d.style, { left: `${b.x - 2}px`, top: `${b.y - 2}px`, width: `${b.w + 4}px`, height: `${b.h + 4}px` });
        d.onclick = (e) => {
          e.stopPropagation();
          if (S.tool !== 'erase' && !removed) return;
          snapshot(S);
          removed ? S.removed.delete(a.id) : S.removed.add(a.id);
          changed();
        };
        layer.append(d);
      }
    }
    // Klicks: Radierer, Notiz setzen, Stift
    svg.addEventListener('click', (e) => {
      if (!S.active || S.tool !== 'erase') return;
      const g = e.target.closest('.an-item');
      if (g) removeItem(Number(g.dataset.id));
    });
    layer.addEventListener('pointerdown', (e) => onPointerDown(e, layer, n, vp));
    pageEl.append(layer);
  }

  function rectEl(b, fill) {
    const r = document.createElementNS(SVGNS, 'rect');
    r.setAttribute('x', b.x); r.setAttribute('y', b.y); r.setAttribute('width', b.w); r.setAttribute('height', b.h);
    r.setAttribute('fill', fill);
    return r;
  }

  function noteEl(it, P) {
    const [x, y] = P(it.x, it.y);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'an-note';
    b.dataset.id = it.id;
    b.style.left = `${x}px`; b.style.top = `${y}px`;
    b.style.setProperty('--c', hex(it.color));
    b.title = it.text || 'Leere Notiz';
    b.setAttribute('aria-label', `Notiz: ${it.text || 'leer'}`);
    b.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h11v8h-5l-3 3v-3h-3z" fill="currentColor" stroke="#1d2433" stroke-width="1" stroke-linejoin="round"/><path d="M5 5.5h6M5 8h4" stroke="#1d2433" stroke-width="1" stroke-linecap="round"/></svg>';
    b.onclick = (e) => {
      e.stopPropagation();
      const S = A(getDoc());
      if (S.active && S.tool === 'erase') return removeItem(it.id);
      openNote(it);
    };
    return b;
  }

  /* ---------- Werkzeuge ---------- */
  let drawing = null;
  function onPointerDown(e, layer, n, vp) {
    const doc = getDoc();
    const S = A(doc);
    if (!S.active || e.button !== 0) return;
    if (e.target.closest('.an-note, .an-existing')) return;
    const pageEl = layer.parentElement;
    const pt = () => localPoint(pageEl, e.clientX, e.clientY);
    if (S.tool === 'stamp') {
      e.preventDefault();
      const [cx, cy] = vp.convertToPdfPoint(...pt());
      const text = $('annotStamp').value;
      const { w, h } = stampSize(text);
      add(S, { type: 'stamp', page: n, x: cx - w / 2, y: cy + h / 2, w, h, text, date: new Date().toLocaleDateString('de-DE') });
    } else if (DRAG_TOOLS.includes(S.tool)) {
      e.preventDefault();
      layer.setPointerCapture(e.pointerId);
      const svg = layer.querySelector('svg');
      const shape = document.createElementNS(SVGNS, S.tool === 'arrow' ? 'line' : 'rect');
      shape.setAttribute('fill', S.tool === 'redact-area' ? 'rgba(0,0,0,.5)' : 'none');
      shape.setAttribute('stroke', S.tool === 'redact-area' ? '#000' : hex(S.color));
      shape.setAttribute('stroke-width', penWidth() * getScale());
      svg.append(shape);
      drawing = { kind: S.tool, layer, pageEl, n, vp, start: pt(), end: pt(), shape };
    } else if (S.tool === 'note') {
      e.preventDefault();
      const [x, y] = vp.convertToPdfPoint(...pt());
      const it = add(S, { type: 'note', page: n, x, y, text: '', color: S.color });
      requestAnimationFrame(() => openNote(it, true));
    } else if (S.tool === 'pen') {
      e.preventDefault();
      layer.setPointerCapture(e.pointerId);
      const svg = layer.querySelector('svg');
      const pl = document.createElementNS(SVGNS, 'polyline');
      pl.setAttribute('fill', 'none'); pl.setAttribute('stroke', hex(S.color));
      pl.setAttribute('stroke-width', penWidth() * getScale()); pl.setAttribute('stroke-linecap', 'round'); pl.setAttribute('stroke-linejoin', 'round');
      svg.append(pl);
      drawing = { kind: 'pen', layer, pageEl, n, vp, pts: [pt()], pl };
      pl.setAttribute('points', drawing.pts.map(p => p.join(',')).join(' '));
    }
  }
  document.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = localPoint(drawing.pageEl, e.clientX, e.clientY);
    if (drawing.kind !== 'pen') {
      drawing.end = p;
      const [a, b] = [drawing.start, p];
      if (drawing.kind === 'arrow') { drawing.shape.setAttribute('x1', a[0]); drawing.shape.setAttribute('y1', a[1]); drawing.shape.setAttribute('x2', b[0]); drawing.shape.setAttribute('y2', b[1]); }
      else { drawing.shape.setAttribute('x', Math.min(a[0], b[0])); drawing.shape.setAttribute('y', Math.min(a[1], b[1])); drawing.shape.setAttribute('width', Math.abs(b[0] - a[0])); drawing.shape.setAttribute('height', Math.abs(b[1] - a[1])); }
      return;
    }
    const last = drawing.pts[drawing.pts.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1.5) return;
    drawing.pts.push(p);
    drawing.pl.setAttribute('points', drawing.pts.map(q => q.join(',')).join(' '));
  });
  document.addEventListener('pointerup', () => {
    if (!drawing) return;
    const d = drawing; drawing = null;
    const S = A(getDoc());
    if (d.kind !== 'pen') {
      const [a, b] = [d.start, d.end];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 6) { d.shape.remove(); return; }
      const A1 = d.vp.convertToPdfPoint(...a).map(v => Math.round(v * 100) / 100);
      const B1 = d.vp.convertToPdfPoint(...b).map(v => Math.round(v * 100) / 100);
      const rect = [Math.min(A1[0], B1[0]), Math.min(A1[1], B1[1]), Math.max(A1[0], B1[0]), Math.max(A1[1], B1[1])];
      if (d.kind === 'arrow') add(S, { type: 'arrow', page: d.n, from: A1, to: B1, color: S.color, width: penWidth() });
      else if (d.kind === 'rect') add(S, { type: 'rect', page: d.n, rect, color: S.color, width: penWidth() });
      else add(S, { type: 'redact', page: d.n, rect });
      return;
    }
    if (d.pts.length < 2) d.pts.push([d.pts[0][0] + 0.5, d.pts[0][1] + 0.5]);
    const path = simplify(d.pts, 0.8).map(p => d.vp.convertToPdfPoint(...p).map(v => Math.round(v * 100) / 100));
    // kurz nacheinander gezeichnete Striche gehören zu einer Anmerkung (z. B. ein Kreuz)
    const last = S.items[S.items.length - 1];
    if (last && last.type === 'ink' && last.page === d.n && last.color === S.color && last.width === penWidth() && Date.now() - last.at < 1500) {
      snapshot(S);
      last.paths.push(path); last.at = Date.now();
      changed();
    } else add(S, { type: 'ink', page: d.n, paths: [path], color: S.color, width: penWidth(), at: Date.now() });
  });
  const penWidth = () => Number($('annotWidth')?.value || 2);

  // Text markieren: Auswahl wird zur Markierung
  // Auswahl genau beim Loslassen lesen (danach kann Chrome sie kurz zurücksetzen)
  let lastSnap = null;
  document.addEventListener('mouseup', () => {
    const doc = getDoc();
    lastSnap = collect();
    if (doc?.annot?.active && lastSnap && (MARKUP.includes(doc.annot.tool) || doc.annot.tool === 'redact-text')) commit(lastSnap, doc.annot.tool === 'redact-text' ? 'redact-text' : doc.annot.tool, doc.annot.color);
  }, true);
  // Auch ohne Markier-Modus nutzbar (Auswahl-Leiste): nimmt die beim Loslassen gemerkte Auswahl
  function applyToSelection(type, color) {
    const snap = lastSnap && lastSnap.doc === getDoc() ? lastSnap : collect();
    return snap ? commit(snap, type, color) : false;
  }
  function collect() {
    const doc = getDoc();
    const sel = document.getSelection();
    if (!doc || !sel || sel.isCollapsed || !sel.rangeCount) return null;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    const byPage = new Map();
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      for (const pageEl of document.querySelectorAll('#pages .page')) {
        if (!range.intersectsNode(pageEl)) continue;
        const W = pageEl.offsetWidth, H = pageEl.offsetHeight;
        const rs = [...range.getClientRects()].filter(r => r.width > 1 && r.height > 1).map(r => localRect(pageEl, r))
          .filter(r => (r.l + r.r) / 2 > 0 && (r.l + r.r) / 2 < W && (r.t + r.b) / 2 > 0 && (r.t + r.b) / 2 < H);
        if (!rs.length) continue;
        const hs = rs.map(r => r.b - r.t).sort((a, b) => a - b);
        const med = hs[Math.floor(hs.length / 2)];
        const list = byPage.get(pageEl) || [];
        for (const r of rs) if (r.b - r.t <= med * 2.2 && r.r - r.l < W * 0.98) list.push(r);
        byPage.set(pageEl, list);
      }
    }
    if (!byPage.size) return null;
    return { doc, text, byPage };
  }
  async function commit({ doc, text, byPage }, type, color) {
    if (doc !== getDoc()) return false;
    const S = A(doc);
    lastSnap = null;
    snapshot(S);
    for (const [pageEl, rects] of byPage) {
      const n = Number(pageEl.dataset.n);
      const vp = await viewport(doc, n);
      const lines = mergeLines(rects);
      const pdfRects = lines.map(l => {
        const [x1, y1] = vp.convertToPdfPoint(l.l, l.t);
        const [x2, y2] = vp.convertToPdfPoint(l.r, l.b);
        return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)].map(v => Math.round(v * 100) / 100);
      });
      if (pdfRects.length && type === 'redact-text') pdfRects.forEach(r => S.items.push({ id: seq++, type: 'redact', page: n, rect: [r[0], r[1] - 0.5, r[2], r[3] + 0.5], text }));
      else if (pdfRects.length) S.items.push({ id: seq++, type, page: n, rects: pdfRects, color, text });
    }
    S.redo = [];
    document.getSelection()?.removeAllRanges();
    changed();
    return true;
  }
  function mergeLines(rects) {
    rects.sort((a, b) => a.t - b.t || a.l - b.l);
    const lines = [];
    for (const r of rects) {
      const last = lines[lines.length - 1];
      const h = last ? last.b - last.t : 0;
      if (last && Math.abs((r.t + r.b) / 2 - (last.t + last.b) / 2) < h * 0.5 && r.l - last.r < h * 1.5) {
        last.l = Math.min(last.l, r.l); last.r = Math.max(last.r, r.r); last.t = Math.min(last.t, r.t); last.b = Math.max(last.b, r.b);
      } else lines.push({ ...r });
    }
    return lines;
  }

  /* ---------- Notiz-Editor ---------- */
  let noteOpen = null;
  function openNote(it, isNew = false) {
    closeNote();
    const pageEl = getPageEl(it.page);
    const btn = pageEl?.querySelector(`.an-note[data-id="${it.id}"]`);
    if (!btn) return;
    const box = document.createElement('div');
    box.className = 'an-pop';
    box.style.left = btn.style.left; box.style.top = `calc(${btn.style.top} + 26px)`;
    box.innerHTML = '<textarea rows="4" placeholder="Notiz schreiben …" aria-label="Notiz"></textarea><div class="an-pop-row"><button type="button" class="btn ghost small" data-act="del">Löschen</button><span class="spacer"></span><button type="button" class="btn primary small" data-act="ok">Fertig</button></div>';
    const ta = box.querySelector('textarea');
    ta.value = it.text;
    const before = it.text;
    box.addEventListener('pointerdown', (e) => e.stopPropagation());
    box.querySelector('[data-act="ok"]').onclick = () => closeNote();
    box.querySelector('[data-act="del"]').onclick = () => { noteOpen = null; box.remove(); removeItem(it.id); };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeNote(); }
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); closeNote(); }
    });
    pageEl.append(box);
    noteOpen = { box, it, before, isNew, ta };
    ta.focus();
  }
  function closeNote() {
    if (!noteOpen) return;
    const { box, it, before, ta } = noteOpen;
    noteOpen = null;
    box.remove();
    if (ta.value !== before) { const S = A(getDoc()); snapshot(S); it.text = ta.value.trim(); changed(); }
    else renderPage(it.page);
  }
  document.addEventListener('pointerdown', (e) => { if (noteOpen && !e.target.closest('.an-pop, .an-note')) closeNote(); });

  /* ---------- Änderungen, Rückgängig ---------- */
  const clone = (S) => ({ items: JSON.parse(JSON.stringify(S.items)), removed: [...S.removed] });
  function snapshot(S) { S.undo.push(clone(S)); if (S.undo.length > 100) S.undo.shift(); S.redo = []; }
  function restore(S, st) { S.items = st.items; S.removed = new Set(st.removed); }
  function add(S, item) { snapshot(S); item.id = seq++; S.items.push(item); changed(); return item; }
  function removeItem(id) {
    const S = A(getDoc());
    const i = S.items.findIndex(x => x.id === id);
    if (i < 0) return;
    snapshot(S);
    S.items.splice(i, 1);
    changed();
  }
  function undo() {
    const doc = getDoc(); if (!doc?.annot?.undo.length) return false;
    const S = doc.annot; S.redo.push(clone(S)); restore(S, S.undo.pop()); changed(); return true;
  }
  function redo() {
    const doc = getDoc(); if (!doc?.annot?.redo.length) return false;
    const S = doc.annot; S.undo.push(clone(S)); restore(S, S.redo.pop()); changed(); return true;
  }
  function changed() {
    const doc = getDoc();
    refreshAll();
    renderBar();
    onChange?.(doc);
  }
  function refreshAll() {
    const doc = getDoc();
    if (!doc) return;
    document.querySelectorAll('#pages .page').forEach(p => { if (p.querySelector('canvas')) renderPage(Number(p.dataset.n)); });
  }

  /* ---------- Leiste ---------- */
  function renderBar() {
    const doc = getDoc();
    const S = doc?.annot;
    const on = !!S?.active;
    $('annotBar').hidden = !on;
    $('btnAnnot').classList.toggle('active', on);
    document.body.classList.toggle('annotating', on);
    document.body.classList.toggle('redacting', on && !!S.redact);
    document.body.dataset.annotTool = on ? S.tool : '';
    document.dispatchEvent(new Event('tavi:mode'));
    if (!on) return;
    document.querySelectorAll('[data-atool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.atool === S.tool));
    document.querySelectorAll('[data-acolor]').forEach(b => b.setAttribute('aria-pressed', b.dataset.acolor === S.color));
    $('annotWidthWrap').hidden = !['pen', 'rect', 'arrow'].includes(S.tool);
    $('annotStampWrap').hidden = S.tool !== 'stamp';
    $('annotSave').textContent = S.redact ? 'Schwärzen anwenden …' : 'Speichern';
    const redactN = S.items.filter(i => i.type === 'redact').length;
    const n = pendingCount(doc);
    if (S.redact) {
      $('annotStatus').textContent = redactN ? `${redactN} ${redactN === 1 ? 'Stelle' : 'Stellen'} zum Schwärzen markiert` : (S.tool === 'redact-area' ? 'Rechteck über die Stelle ziehen' : 'Text mit der Maus markieren');
      $('annotUndo').disabled = !S.undo.length;
      return;
    }
    $('annotStatus').textContent = n ? `${n} ${n === 1 ? 'Änderung' : 'Änderungen'} nicht gespeichert` : ({
      highlight: 'Text mit der Maus markieren', underline: 'Text mit der Maus markieren', strike: 'Text mit der Maus markieren',
      note: 'Auf die Seite klicken, um eine Notiz zu setzen', pen: 'Mit gedrückter Maustaste zeichnen', erase: 'Anmerkung anklicken, um sie zu löschen',
      rect: 'Rechteck aufziehen', arrow: 'Vom Anfang zur Spitze ziehen', stamp: 'Auf die Seite klicken, um den Stempel zu setzen'
    }[S.tool]);
    $('annotUndo').disabled = !S.undo.length;
  }
  const pendingCount = (doc) => (doc?.annot ? doc.annot.items.length + doc.annot.removed.size : 0);

  function setTool(tool) {
    const S = A(getDoc());
    S.tool = tool;
    renderBar();
    refreshAll();
  }
  function enter(redact = false) {
    const doc = getDoc();
    if (!doc) { toast('Öffne zuerst ein PDF.'); document.dispatchEvent(new Event('tavi:mode')); return; }
    onEnter?.();
    const S = A(doc);
    S.active = true;
    if (redact) { S.redact = true; S.tool = 'redact-text'; }
    else if (S.redact) { S.redact = false; S.tool = 'highlight'; }
    renderBar();
    refreshAll();
  }
  function leave() {
    const doc = getDoc();
    closeNote();
    if (doc?.annot) { doc.annot.active = false; if (doc.annot.redact) { doc.annot.redact = false; doc.annot.tool = 'highlight'; } }
    renderBar();
    refreshAll();
  }
  function syncDoc() { closeNote(); renderBar(); }

  // Palette einmal aufbauen
  $('annotColors').replaceChildren(...ANNOT_COLORS.map(c => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'swatch'; b.dataset.acolor = c.id; b.title = c.name; b.setAttribute('aria-label', c.name);
    b.style.setProperty('--c', c.hex);
    b.onclick = () => { const S = A(getDoc()); S.color = c.id; renderBar(); };
    return b;
  }));
  document.querySelectorAll('[data-atool]').forEach(b => { b.onclick = () => setTool(b.dataset.atool); });
  $('btnAnnot').onclick = () => (getDoc()?.annot?.active ? leave() : enter());
  $('annotDone').onclick = leave;
  $('annotUndo').onclick = undo;
  $('annotSave').onclick = () => onSave();
  document.addEventListener('keydown', (e) => {
    const doc = getDoc();
    if (!doc?.annot?.active || document.querySelector('dialog[open]') || e.target.closest?.('input, textarea, select')) return;
    if (e.key === 'Escape') { leave(); return; }
    if (doc.annot.redact) return;
    const map = { h: 'highlight', u: 'underline', d: 'strike', n: 'note', p: 'pen', e: 'erase', r: 'rect', a: 'arrow', s: 'stamp' };
    if (!e.ctrlKey && !e.altKey && !e.metaKey && map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
  });

  /* ---------- Speichern ins PDF ---------- */
  async function apply(bytes, doc) {
    const S = doc.annot;
    if (!S || (!S.items.some(i => i.type !== 'redact') && !S.removed.size)) return bytes;
    const { PDFDocument, PDFName, PDFHexString, PDFArray, PDFRef, StandardFonts } = window.PDFLib;
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const ctx = pdf.context;
    const pages = pdf.getPages();
    // Löschen vorhandener Anmerkungen
    if (S.removed.size) {
      const ids = new Set([...S.removed].map(id => { const m = /^(\d+)R(\d*)$/.exec(id); return m ? `${m[1]} ${m[2] || 0}` : null; }).filter(Boolean));
      for (const p of pages) {
        const arr = p.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
        if (!arr) continue;
        const key = (r) => (r instanceof PDFRef ? `${r.objectNumber} ${r.generationNumber}` : null);
        for (let i = arr.size() - 1; i >= 0; i--) {
          const ref = arr.get(i);
          const dict = arr.lookup(i);
          const parent = dict?.get?.(PDFName.of('Parent'));
          if (ids.has(key(ref)) || (parent && ids.has(key(parent)))) { arr.remove(i); if (ref instanceof PDFRef) ctx.delete(ref); }
        }
      }
    }
    const now = pdfDate(new Date());
    let stampFont = null;
    for (const it of S.items) {
      const page = pages[it.page - 1];
      if (!page) continue;
      const [r, g, b] = rgb(it.color);
      let rect, content, extra = {}, resources;
      if (MARKUP.includes(it.type)) {
        const rs = it.rects;
        rect = [Math.min(...rs.map(q => q[0])), Math.min(...rs.map(q => q[1])), Math.max(...rs.map(q => q[2])), Math.max(...rs.map(q => q[3]))];
        extra.QuadPoints = rs.flatMap(([x1, y1, x2, y2]) => [x1, y2, x2, y2, x1, y1, x2, y1]);
        if (it.type === 'highlight') {
          resources = { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', CA: 1, ca: 1 } } };
          content = `/GS0 gs ${f(r)} ${f(g)} ${f(b)} rg ` + rs.map(([x1, y1, x2, y2]) => `${f(x1)} ${f(y1)} ${f(x2 - x1)} ${f(y2 - y1)} re`).join(' ') + ' f';
        } else {
          content = `${f(r)} ${f(g)} ${f(b)} RG ` + rs.map(([x1, y1, x2, y2]) => {
            const h = y2 - y1; const t = Math.max(0.6, h * 0.08);
            const y = it.type === 'underline' ? y1 + t / 2 : y1 + h * 0.45;
            return `${f(t)} w ${f(x1)} ${f(y)} m ${f(x2)} ${f(y)} l S`;
          }).join(' ');
        }
      } else if (it.type === 'ink') {
        const all = it.paths.flat();
        const pad = it.width;
        rect = [Math.min(...all.map(p => p[0])) - pad, Math.min(...all.map(p => p[1])) - pad, Math.max(...all.map(p => p[0])) + pad, Math.max(...all.map(p => p[1])) + pad];
        extra.InkList = it.paths.map(p => p.flat());
        extra.BS = { Type: 'Border', W: it.width, S: 'S' };
        content = `${f(r)} ${f(g)} ${f(b)} RG ${f(it.width)} w 1 J 1 j ` + it.paths.map(p => p.map(([x, y], i) => `${f(x)} ${f(y)} ${i ? 'l' : 'm'}`).join(' ') + ' S').join(' ');
      } else if (it.type === 'note') {
        rect = [it.x, it.y - 20, it.x + 20, it.y];
        extra.Name = 'Comment';
        extra.Open = false;
        const [x, y] = rect;
        content = `${f(r)} ${f(g)} ${f(b)} rg 0.11 0.14 0.2 RG 1 w ${f(x + 1.5)} ${f(y + 5.5)} m ${f(x + 18.5)} ${f(y + 5.5)} l ${f(x + 18.5)} ${f(y + 18.5)} l ${f(x + 1.5)} ${f(y + 18.5)} l ${f(x + 1.5)} ${f(y + 5.5)} l ${f(x + 5)} ${f(y + 5.5)} m ${f(x + 5)} ${f(y + 1.5)} l ${f(x + 9)} ${f(y + 5.5)} l B `
          + `${f(x + 5)} ${f(y + 14)} m ${f(x + 15)} ${f(y + 14)} l ${f(x + 5)} ${f(y + 10)} m ${f(x + 12)} ${f(y + 10)} l S`;
      } else if (it.type === 'rect') {
        const w = it.width, [x1, y1, x2, y2] = it.rect;
        rect = [x1 - w, y1 - w, x2 + w, y2 + w];
        extra.BS = { Type: 'Border', W: w, S: 'S' };
        content = `${f(r)} ${f(g)} ${f(b)} RG ${f(w)} w ${f(x1)} ${f(y1)} ${f(x2 - x1)} ${f(y2 - y1)} re S`;
      } else if (it.type === 'arrow') {
        const w = it.width, [x1, y1] = it.from, [x2, y2] = it.to;
        const ang = Math.atan2(y2 - y1, x2 - x1), hl = Math.max(8, w * 5);
        const h1 = [x2 - hl * Math.cos(ang - 0.45), y2 - hl * Math.sin(ang - 0.45)], h2 = [x2 - hl * Math.cos(ang + 0.45), y2 - hl * Math.sin(ang + 0.45)];
        const xs = [x1, x2, h1[0], h2[0]], ys = [y1, y2, h1[1], h2[1]];
        rect = [Math.min(...xs) - w, Math.min(...ys) - w, Math.max(...xs) + w, Math.max(...ys) + w];
        extra.L = [x1, y1, x2, y2];
        extra.LE = ['None', 'OpenArrow'];
        extra.BS = { Type: 'Border', W: w, S: 'S' };
        content = `${f(r)} ${f(g)} ${f(b)} RG ${f(w)} w 1 J 1 j ${f(x1)} ${f(y1)} m ${f(x2)} ${f(y2)} l S ${f(h1[0])} ${f(h1[1])} m ${f(x2)} ${f(y2)} l ${f(h2[0])} ${f(h2[1])} l S`;
      } else if (it.type === 'stamp') {
        const font = await (stampFont ||= pdf.embedFont(StandardFonts.HelveticaBold));
        const red = STAMP_RED.has(it.text);
        const [cr, cg, cb] = red ? [0.776, 0.157, 0.157] : [0.18, 0.49, 0.196];
        const x = it.x, y = it.y - it.h, W = it.w, H = it.h;
        rect = [x, y, x + W, y + H];
        const tw = font.widthOfTextAtSize(it.text, 18), dw = font.widthOfTextAtSize(it.date, 9);
        resources = { Font: { F1: font.ref } };
        content = `${cr} ${cg} ${cb} RG 2.2 w ${f(x + 1.1)} ${f(y + 1.1)} ${f(W - 2.2)} ${f(H - 2.2)} re S ${cr} ${cg} ${cb} rg `
          + `BT /F1 18 Tf ${f(x + (W - tw) / 2)} ${f(y + H * 0.42)} Td ${font.encodeText(it.text).toString()} Tj ET `
          + `BT /F1 9 Tf ${f(x + (W - dw) / 2)} ${f(y + 6)} Td ${font.encodeText(it.date).toString()} Tj ET`;
        extra.Name = PDFName.of(red ? 'NotApproved' : 'Approved');
        it.contents = `${it.text} ${it.date}`;
      } else continue;
      const subtype = { highlight: 'Highlight', underline: 'Underline', strike: 'StrikeOut', ink: 'Ink', note: 'Text', rect: 'Square', arrow: 'Line', stamp: 'Stamp' }[it.type];
      const apDict = { Type: 'XObject', Subtype: 'Form', BBox: rect, FormType: 1 };
      if (resources) apDict.Resources = resources;
      const ap = ctx.register(ctx.stream(content, apDict));
      const annot = ctx.obj({ Type: 'Annot', Subtype: subtype, Rect: rect, C: [r, g, b], F: 4, M: PDFHexString.fromText(now), ...extra, AP: { N: ap } });
      annot.set(PDFName.of('NM'), PDFHexString.fromText(`tavi-${Date.now().toString(36)}-${it.id}`));
      if (it.text || it.contents) annot.set(PDFName.of('Contents'), PDFHexString.fromText(it.contents || it.text));
      if (it.type === 'highlight' || it.type === 'underline' || it.type === 'strike') annot.set(PDFName.of('CA'), ctx.obj(1));
      page.node.addAnnot(ctx.register(annot));
    }
    return pdf.save({ useObjectStreams: false });
  }
  function clearDoc(doc) {
    if (!doc.annot) return;
    doc.annot.items = []; doc.annot.removed = new Set(); doc.annot.undo = []; doc.annot.redo = []; doc.annot.existing = new Map();
  }

  return {
    enter, leave, syncDoc, renderPage, refreshAll, apply, clearDoc, undo, redo, applyToSelection, renderBar,
    isActive: () => !!getDoc()?.annot?.active,
    pending: pendingCount,
    resetCache: (doc) => { vpCache.delete(doc); if (doc.annot) doc.annot.existing = new Map(); }
  };
}

/* ---------- Hilfen ---------- */
const hex = (id) => (ANNOT_COLORS.find(c => c.id === id) || ANNOT_COLORS[0]).hex;
function rgb(id) { const h = hex(id); return [1, 3, 5].map(i => Math.round(parseInt(h.slice(i, i + 2), 16) / 255 * 1000) / 1000); }
const f = (v) => (Math.round(v * 100) / 100).toString();
function pdfDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
// Ramer-Douglas-Peucker, damit Freihandlinien nicht riesig werden
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let max = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const d = Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
    if (d > max) { max = d; idx = i; }
  }
  if (max <= eps) return [a, b];
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)];
}
