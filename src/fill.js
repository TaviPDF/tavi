/* Ausfüllen und Unterschreiben: Eingabefelder über den PDF-Seiten, eigene Felder, Unterschriften. */
import { detectFields, buildFilledPdf, autoFontSize, newId } from './forms.js';
import { valueFor } from './profile.js';

const DEFAULT_SIZE = { text: { w: 170, h: 18 }, date: { w: 80, h: 18 }, check: { w: 12, h: 12 }, sig: { w: 150, h: 45 } };
const TOOL_HINT = {
  text: 'Klicke auf die Stelle, an der das Textfeld beginnen soll, oder ziehe ein Rechteck auf.',
  check: 'Klicke auf das Kästchen, das angekreuzt werden soll.',
  date: 'Klicke auf die Stelle für das heutige Datum.',
  sig: 'Klicke auf die Stelle für deine Unterschrift oder ziehe ein Rechteck auf.'
};
const today = () => new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const isFilled = (f) => f.kind === 'sig' ? !!f.value?.data : (f.kind === 'check' || f.kind === 'radio') ? !!f.value : String(f.value || '').trim() !== '';

export function initFill({ pdfjsLib, getDoc, getScale, getPageEl, renderedPages, toast, api, onChange, openProfile }) {
  const $ = (id) => document.getElementById(id);
  let sigResolve = null;
  let drawing = null;

  /* ---------- Zustand je Dokument ---------- */
  const fillOf = (doc) => (doc.fill ||= { active: false, fields: [], detected: false, tool: null, pendingSig: null, dirty: false });

  async function enter() {
    const doc = getDoc();
    if (!doc) return toast('Öffne zuerst ein PDF, das du ausfüllen möchtest.');
    const F = fillOf(doc);
    F.active = true;
    document.body.classList.add('filling');
    $('btnFill').classList.add('active');
    renderBar();
    if (!F.detected) await detect(false);
    refreshAll();
  }
  function leave() {
    const doc = getDoc();
    if (doc?.fill) { doc.fill.active = false; doc.fill.tool = null; }
    document.body.classList.remove('filling', 'placing');
    $('btnFill').classList.remove('active');
    document.querySelectorAll('.formLayer').forEach(l => l.remove());
    renderBar();
  }
  // Beim Tab-Wechsel den richtigen Zustand zeigen
  function syncDoc() {
    const doc = getDoc();
    const on = !!doc?.fill?.active;
    document.body.classList.toggle('filling', on);
    document.body.classList.toggle('placing', on && !!doc.fill.tool);
    $('btnFill').classList.toggle('active', on);
    renderBar();
  }

  async function detect(again) {
    const doc = getDoc();
    const F = fillOf(doc);
    $('fillStatus').textContent = 'Suche Felder …';
    try {
      const found = await detectFields(doc.pdf, pdfjsLib, (n, t) => { if (t > 3) $('fillStatus').textContent = `Suche Felder … Seite ${n} von ${t}`; });
      if (again) {
        // Eigene Felder und schon Ausgefülltes behalten
        const keepManual = F.fields.filter(f => f.source === 'manual');
        const old = new Map(F.fields.filter(f => f.source !== 'manual').map(f => [key(f), f]));
        F.fields = [...found.map(f => (old.has(key(f)) ? { ...f, value: old.get(key(f)).value, id: old.get(key(f)).id } : f)), ...keepManual];
      } else F.fields = found;
      F.detected = true;
      sortFields(F);
    } catch (e) {
      console.error(e);
      toast('Die Felder konnten nicht automatisch erkannt werden. Du kannst sie selbst setzen.');
    }
    renderBar();
    refreshAll();
  }
  const key = (f) => `${f.page}:${Math.round(f.rect.x)}:${Math.round(f.rect.y)}:${f.kind}`;
  const sortFields = (F) => F.fields.sort((a, b) => a.page - b.page || (Math.abs(a.rect.y - b.rect.y) > 6 ? a.rect.y - b.rect.y : a.rect.x - b.rect.x));

  /* ---------- Leiste ---------- */
  function renderBar() {
    const doc = getDoc();
    const F = doc?.fill;
    const bar = $('fillBar');
    bar.hidden = !F?.active;
    if (!F?.active) return;
    const total = F.fields.length, done = F.fields.filter(isFilled).length;
    const auto = F.fields.filter(f => f.source !== 'manual').length;
    $('fillStatus').textContent = !F.detected ? 'Suche Felder …'
      : total ? `${auto ? `${auto} ${auto === 1 ? 'Feld' : 'Felder'} erkannt` : 'Keine Felder erkannt'}${total - auto ? `, ${total - auto} eigene` : ''} · ${done} ausgefüllt`
        : 'Keine Felder erkannt. Setze sie mit den Werkzeugen selbst.';
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', F.tool === b.dataset.tool));
    $('fillHint').hidden = !F.tool;
    $('fillHint').textContent = F.tool ? TOOL_HINT[F.tool] + ' Esc bricht ab.' : '';
    document.body.classList.toggle('placing', !!F.tool);
  }

  function setTool(tool) {
    const F = fillOf(getDoc());
    F.tool = F.tool === tool ? null : tool;
    if (F.tool !== 'sig') F.pendingSig = null;
    renderBar();
  }

  /* ---------- Felder auf der Seite ---------- */
  function refreshAll() {
    const doc = getDoc();
    if (!doc?.fill?.active) return;
    for (const n of renderedPages()) renderPage(n);
  }

  function renderPage(n) {
    const doc = getDoc();
    const F = doc?.fill;
    const pageEl = getPageEl(n);
    if (!pageEl) return;
    pageEl.querySelector('.formLayer')?.remove();
    if (!F?.active) return;
    const layer = document.createElement('div');
    layer.className = 'formLayer';
    layer.dataset.page = n;
    for (const f of F.fields.filter(f => f.page === n)) layer.append(fieldEl(f));
    pageEl.append(layer);
  }

  function place(el, f) {
    const s = getScale();
    Object.assign(el.style, { left: `${f.rect.x * s}px`, top: `${f.rect.y * s}px`, width: `${f.rect.w * s}px`, height: `${f.rect.h * s}px` });
  }

  function fieldEl(f) {
    const s = getScale();
    const el = document.createElement('div');
    el.className = `ff ff-${f.kind} src-${f.source}` + (isFilled(f) ? ' filled' : '');
    el.dataset.id = f.id;
    place(el, f);
    const label = f.label || ({ text: 'Textfeld', check: 'Ankreuzen', radio: 'Auswahl', choice: 'Auswahl', sig: 'Unterschrift' }[f.kind]);
    if (f.kind === 'text') {
      const multi = f.multiLine;
      const inp = document.createElement(multi ? 'textarea' : 'input');
      inp.className = 'ff-input';
      inp.value = f.value || '';
      inp.setAttribute('aria-label', label);
      inp.title = label;
      inp.placeholder = f.hint === 'date' ? today() : '';
      if (f.maxLen) inp.maxLength = f.maxLen;
      if (f.readOnly) inp.readOnly = true;
      inp.style.fontSize = `${autoFontSize(f) * s}px`;
      inp.addEventListener('input', () => { f.value = inp.value; changed(f, el); });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !multi) { e.preventDefault(); focusNext(f); }
        if (e.key === 'Tab' && f.hint === 'date' && !inp.value) { inp.value = today(); f.value = inp.value; changed(f, el); }
      });
      el.append(inp);
    } else if (f.kind === 'check' || f.kind === 'radio') {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ff-box';
      b.setAttribute('role', 'checkbox');
      b.setAttribute('aria-checked', !!f.value);
      b.setAttribute('aria-label', label);
      b.title = label;
      b.textContent = f.value ? '✕' : '';
      b.style.fontSize = `${Math.min(f.rect.w, f.rect.h) * s * 0.9}px`;
      b.addEventListener('click', () => {
        if (f.readOnly) return;
        if (f.kind === 'radio' && !f.value) {
          // in derselben Gruppe nur eins wählen
          for (const o of fillOf(getDoc()).fields) if (o !== f && o.kind === 'radio' && o.acro?.name === f.acro?.name && o.value) { o.value = false; refreshField(o); }
        }
        f.value = !f.value;
        b.textContent = f.value ? '✕' : '';
        b.setAttribute('aria-checked', f.value);
        changed(f, el);
      });
      el.append(b);
    } else if (f.kind === 'choice') {
      const sel = document.createElement('select');
      sel.className = 'ff-input';
      sel.setAttribute('aria-label', label);
      sel.title = label;
      sel.style.fontSize = `${autoFontSize(f) * s}px`;
      sel.append(new Option('', ''), ...(f.options || []).map(o => new Option(o.label, o.value)));
      sel.value = f.value || '';
      sel.addEventListener('change', () => { f.value = sel.value; changed(f, el); });
      el.append(sel);
    } else if (f.kind === 'sig') {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ff-sigbtn';
      b.setAttribute('aria-label', f.value?.data ? 'Unterschrift ändern' : 'Hier unterschreiben');
      if (f.value?.data) {
        const img = document.createElement('img');
        img.src = f.value.data;
        img.alt = 'Unterschrift';
        b.append(img);
      } else b.textContent = 'Hier unterschreiben';
      b.addEventListener('click', async () => {
        const data = await askSignature();
        if (!data) return;
        f.value = data;
        refreshField(f);
        changed(f);
      });
      el.append(b);
    }
    // Verschieben, Größe ändern, Entfernen: bei erkannten und eigenen Feldern
    if (f.source !== 'acro') {
      const grip = document.createElement('button');
      grip.type = 'button';
      grip.className = 'ff-grip';
      grip.title = 'Feld verschieben';
      grip.setAttribute('aria-label', 'Feld verschieben');
      grip.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><circle cx="3" cy="2" r="1"/><circle cx="7" cy="2" r="1"/><circle cx="3" cy="5" r="1"/><circle cx="7" cy="5" r="1"/><circle cx="3" cy="8" r="1"/><circle cx="7" cy="8" r="1"/></svg>';
      grip.addEventListener('pointerdown', (e) => startDrag(e, f, el, 'move'));
      const size = document.createElement('span');
      size.className = 'ff-size';
      size.title = 'Größe ändern';
      size.addEventListener('pointerdown', (e) => startDrag(e, f, el, 'size'));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ff-del';
      del.title = 'Feld entfernen';
      del.setAttribute('aria-label', 'Feld entfernen');
      del.textContent = '×';
      del.addEventListener('click', () => removeField(f));
      el.append(grip, size, del);
    }
    return el;
  }

  function refreshField(f) {
    const old = document.querySelector(`.ff[data-id="${f.id}"]`);
    if (old) old.replaceWith(fieldEl(f));
  }
  function changed(f, el) {
    const F = fillOf(getDoc());
    F.dirty = true;
    el?.classList.toggle('filled', isFilled(f));
    renderBar();
    onChange?.();
  }
  function removeField(f) {
    const F = fillOf(getDoc());
    F.fields = F.fields.filter(x => x !== f);
    document.querySelector(`.ff[data-id="${f.id}"]`)?.remove();
    F.dirty = true;
    renderBar();
  }
  function focusNext(f) {
    const F = fillOf(getDoc());
    const i = F.fields.indexOf(f);
    const next = F.fields.slice(i + 1).find(x => !x.readOnly) || null;
    if (next) focusField(next);
  }
  function focusField(f) {
    const el = document.querySelector(`.ff[data-id="${f.id}"]`);
    const ctl = el?.querySelector('input, textarea, select, button.ff-box, button.ff-sigbtn');
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); ctl?.focus({ preventScroll: true }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 900); }
    else getPageEl(f.page)?.scrollIntoView({ block: 'center' }); // Seite wird gerade gezeichnet
  }
  function nextEmpty() {
    const F = fillOf(getDoc());
    const f = F.fields.find(x => !x.readOnly && !isFilled(x));
    if (f) focusField(f);
    else toast(F.fields.length ? 'Alle Felder sind ausgefüllt.' : 'Es gibt noch keine Felder.');
  }

  /* ---------- Ziehen ---------- */
  function startDrag(e, f, el, mode) {
    e.preventDefault();
    e.stopPropagation();
    const s = getScale();
    const sx = e.clientX, sy = e.clientY;
    const r0 = { ...f.rect };
    const min = f.kind === 'check' ? 6 : 12;
    const move = (ev) => {
      const dx = (ev.clientX - sx) / s, dy = (ev.clientY - sy) / s;
      if (mode === 'move') f.rect = { ...r0, x: r0.x + dx, y: r0.y + dy };
      else f.rect = { ...r0, w: Math.max(min, r0.w + dx), h: Math.max(min, r0.h + dy) };
      if (f.kind === 'text') f.multiLine = f.rect.h > 34;
      place(el, f);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (mode === 'size') refreshField(f);
      fillOf(getDoc()).dirty = true;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // Neues Feld setzen: auf die Seite klicken oder ein Rechteck aufziehen
  document.getElementById('pages').addEventListener('pointerdown', (e) => {
    const doc = getDoc();
    const F = doc?.fill;
    if (!F?.active || !F.tool || e.button !== 0) return;
    if (e.target.closest('.ff')) return;
    const pageEl = e.target.closest('.page');
    if (!pageEl) return;
    e.preventDefault();
    const n = Number(pageEl.dataset.n);
    const s = getScale();
    const box = pageEl.getBoundingClientRect();
    const x0 = (e.clientX - box.left) / s, y0 = (e.clientY - box.top) / s;
    const ghost = document.createElement('div');
    ghost.className = 'ff-ghost';
    pageEl.append(ghost);
    let x1 = x0, y1 = y0;
    const move = (ev) => {
      x1 = (ev.clientX - box.left) / s; y1 = (ev.clientY - box.top) / s;
      Object.assign(ghost.style, { left: `${Math.min(x0, x1) * s}px`, top: `${Math.min(y0, y1) * s}px`, width: `${Math.abs(x1 - x0) * s}px`, height: `${Math.abs(y1 - y0) * s}px` });
    };
    const up = async () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      ghost.remove();
      const tool = F.tool;
      const d = DEFAULT_SIZE[tool];
      const dragged = Math.abs(x1 - x0) > 6 && Math.abs(y1 - y0) > 6;
      let rect;
      if (dragged) rect = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      else if (tool === 'check' || tool === 'sig') rect = { x: x0 - d.w / 2, y: y0 - d.h / 2, w: d.w, h: d.h };
      else rect = { x: x0, y: y0 - d.h / 2, w: d.w, h: d.h };
      const field = { id: newId(), page: n, rect, source: 'manual', label: '' };
      if (tool === 'text') Object.assign(field, { kind: 'text', value: '', multiLine: rect.h > 34 });
      if (tool === 'date') Object.assign(field, { kind: 'text', value: today(), hint: 'date' });
      if (tool === 'check') Object.assign(field, { kind: 'check', value: true });
      if (tool === 'sig') {
        const data = F.pendingSig || await askSignature();
        if (!data) return;
        if (!dragged) { const ar = data.w / data.h; rect.h = Math.min(60, rect.w / ar); rect.w = rect.h * ar; rect.x = x0 - rect.w / 2; rect.y = y0 - rect.h / 2; }
        Object.assign(field, { kind: 'sig', value: data });
        F.pendingSig = null;
      }
      F.fields.push(field);
      sortFields(F);
      F.dirty = true;
      F.tool = null;
      renderBar();
      renderPage(n);
      if (field.kind === 'text') setTimeout(() => focusField(field), 30);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  /* ---------- Unterschrift ---------- */
  async function askSignature() {
    const dlg = $('sigDlg');
    clearPad();
    $('sigRemember').checked = true;
    $('sigError').hidden = true;
    await renderSaved();
    dlg.showModal();
    return new Promise((res) => { sigResolve = res; });
  }
  function finishSig(data) {
    $('sigDlg').close();
    const r = sigResolve; sigResolve = null;
    r?.(data);
  }
  $('sigDlg').addEventListener('close', () => { if (sigResolve) finishSig(null); });

  async function renderSaved() {
    const box = $('sigSaved');
    let list = [];
    try { list = await api.signatures.list(); } catch { /* keine gespeicherten */ }
    box.replaceChildren(...list.map(s => {
      const wrap = document.createElement('div');
      wrap.className = 'sig-item';
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'sig-use';
      use.title = 'Diese Unterschrift verwenden';
      const img = document.createElement('img');
      img.src = s.data; img.alt = 'Gespeicherte Unterschrift';
      use.append(img);
      use.addEventListener('click', () => finishSig({ data: s.data, w: s.w, h: s.h }));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'sig-del';
      del.title = 'Gespeicherte Unterschrift löschen';
      del.setAttribute('aria-label', 'Gespeicherte Unterschrift löschen');
      del.textContent = '×';
      del.addEventListener('click', async () => { await api.signatures.remove(s.id); renderSaved(); });
      wrap.append(use, del);
      return wrap;
    }));
    $('sigSavedWrap').hidden = !list.length;
  }

  // Zeichenfläche
  const pad = $('sigPad');
  const pctx = pad.getContext('2d');
  let strokes = [];
  function setupPad() {
    const dpr = window.devicePixelRatio || 1;
    const w = pad.clientWidth || 520, h = pad.clientHeight || 190;
    pad.width = Math.round(w * dpr); pad.height = Math.round(h * dpr);
    pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }
  function clearPad() { strokes = []; requestAnimationFrame(setupPad); $('sigEmpty').hidden = false; }
  function redraw() {
    pctx.clearRect(0, 0, pad.width, pad.height);
    pctx.lineCap = 'round'; pctx.lineJoin = 'round'; pctx.strokeStyle = '#14204A';
    for (const st of strokes) {
      if (!st.length) continue;
      pctx.beginPath();
      pctx.moveTo(st[0].x, st[0].y);
      for (let i = 1; i < st.length; i++) {
        const p = st[i - 1], q = st[i];
        pctx.lineWidth = 1.4 + 2.2 * (q.p ?? 0.5);
        pctx.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
        pctx.stroke();
        pctx.beginPath();
        pctx.moveTo((p.x + q.x) / 2, (p.y + q.y) / 2);
      }
      if (st.length === 1) { pctx.arc(st[0].x, st[0].y, 1.6, 0, Math.PI * 2); pctx.fillStyle = '#14204A'; pctx.fill(); }
    }
  }
  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId);
    const r = pad.getBoundingClientRect();
    drawing = [{ x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure || 0.5 }];
    strokes.push(drawing);
    $('sigEmpty').hidden = true;
    redraw();
  });
  pad.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const r = pad.getBoundingClientRect();
    drawing.push({ x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure || 0.5 });
    redraw();
  });
  const endStroke = () => { drawing = null; };
  pad.addEventListener('pointerup', endStroke);
  pad.addEventListener('pointercancel', endStroke);

  // Bild der Unterschrift auf den Inhalt zuschneiden (transparenter Hintergrund)
  function cropCanvas(src) {
    const ctx = src.getContext('2d', { willReadFrequently: true });
    const { width: w, height: h } = src;
    const img = ctx.getImageData(0, 0, w, h);
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (img.data[(y * w + x) * 4 + 3] > 20) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (maxX < 0) return null;
    const padPx = 6;
    minX = Math.max(0, minX - padPx); minY = Math.max(0, minY - padPx); maxX = Math.min(w - 1, maxX + padPx); maxY = Math.min(h - 1, maxY + padPx);
    const out = document.createElement('canvas');
    out.width = maxX - minX + 1; out.height = maxY - minY + 1;
    out.getContext('2d').drawImage(src, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    return { data: out.toDataURL('image/png'), w: out.width, h: out.height };
  }

  $('sigClear').onclick = clearPad;
  $('sigCancel').onclick = () => finishSig(null);
  $('sigOk').onclick = async () => {
    const res = strokes.length ? cropCanvas(pad) : null;
    if (!res) { $('sigError').textContent = 'Zeichne zuerst deine Unterschrift oder lade ein Bild.'; $('sigError').hidden = false; return; }
    if ($('sigRemember').checked) { try { await api.signatures.save(res); } catch { /* nicht gespeichert */ } }
    finishSig(res);
  };
  // Foto oder Scan einer Unterschrift: weißen Hintergrund entfernen
  $('sigFile').addEventListener('change', async () => {
    const file = $('sigFile').files?.[0];
    $('sigFile').value = '';
    if (!file) return;
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 1200 / bmp.width);
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        // hell = durchsichtig, dunkel = Tinte, dazwischen weicher Übergang
        const a = lum >= 215 ? 0 : lum <= 150 ? 255 : Math.round(255 * (215 - lum) / 65);
        d[i + 3] = Math.min(d[i + 3], a);
      }
      ctx.putImageData(img, 0, 0);
      const res = cropCanvas(c);
      if (!res) throw new Error('leer');
      if ($('sigRemember').checked) { try { await api.signatures.save(res); } catch { /* nicht gespeichert */ } }
      finishSig(res);
    } catch {
      $('sigError').textContent = 'Auf dem Bild wurde keine Unterschrift erkannt. Nimm ein Foto mit dunkler Schrift auf hellem Papier.';
      $('sigError').hidden = false;
    }
  });

  /* ---------- Speichern ---------- */
  async function save() {
    const doc = getDoc();
    const F = fillOf(doc);
    if (!F.fields.some(isFilled)) return toast('Es ist noch nichts ausgefüllt.');
    const btn = $('fillSave');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Speichere …';
    try {
      const { bytes, problems } = await buildFilledPdf({ pdf: doc.pdf, fields: F.fields, flatten: $('fillFlatten').checked });
      const base = doc.name.replace(/\.pdf$/i, '');
      const r = await api.saveAs(bytes, `${base} (ausgefüllt).pdf`, 'PDF-Dokument', 'pdf');
      if (r.canceled) return;
      if (!r.ok) throw new Error(r.message);
      F.dirty = false;
      toast(problems.length ? `Gespeichert: ${r.name}. Nicht übernommen: ${problems.join(', ')}` : `Gespeichert: ${r.name}`);
      api.showInFolder(r.path);
    } catch (e) {
      console.error(e);
      toast(`Speichern fehlgeschlagen: ${e.message || e}`);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // Meine Daten in leere Textfelder eintragen (Zuordnung über die Beschriftung, ohne KI)
  async function fillMine() {
    const doc = getDoc();
    if (!doc?.fill?.active) return;
    const F = fillOf(doc);
    const profile = await api.profile?.get().catch(() => ({})) || {};
    if (!Object.keys(profile).length) { toast('Hinterlege zuerst „Meine Daten“ in den Einstellungen.'); openProfile?.(); return; }
    let n = 0;
    for (const f of F.fields) {
      if (f.kind !== 'text' || f.readOnly || isFilled(f)) continue;
      const v = valueFor(f.label, profile);
      if (!v) continue;
      f.value = f.maxLen ? v.slice(0, f.maxLen) : v;
      n++;
      refreshField(f);
    }
    if (n) { F.dirty = true; renderBar(); onChange?.(); }
    toast(n ? `${n} ${n === 1 ? 'Feld' : 'Felder'} mit deinen Daten ausgefüllt. Bitte kurz prüfen.` : 'Keine passenden leeren Felder gefunden.');
  }

  /* ---------- Ereignisse ---------- */
  $('fillMine').onclick = fillMine;
  $('btnFill').onclick = () => (getDoc()?.fill?.active ? leave() : enter());
  $('fillDone').onclick = leave;
  $('fillSave').onclick = save;
  $('fillNext').onclick = nextEmpty;
  $('fillRedetect').onclick = () => detect(true);
  document.querySelectorAll('[data-tool]').forEach(b => { b.onclick = () => setTool(b.dataset.tool); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && getDoc()?.fill?.tool && !document.querySelector('dialog[open]')) { getDoc().fill.tool = null; renderBar(); }
  });

  return {
    enter, leave, syncDoc, renderPage, refreshAll, save,
    isActive: () => !!getDoc()?.fill?.active,
    hasUnsaved: (doc) => !!doc?.fill?.dirty && doc.fill.fields.some(isFilled)
  };
}
