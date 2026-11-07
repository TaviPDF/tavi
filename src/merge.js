/* PDFs zusammenführen: Dateien wählen, Seiten per Bereich oder Klick auswählen, als neues PDF speichern. */

/* ---------- Seitenbereiche ---------- */
// "1-5, 8, 10-" → Set {1..5, 8, 10..total}. Wirft einen Fehler mit verständlichem Text.
export function parseRanges(text, total) {
  const set = new Set();
  const src = text.replace(/[–—−]/g, '-').replace(/\bbis\b/gi, '-').trim();
  if (!src) return set;
  for (const raw of src.split(/[,;]+/)) {
    const part = raw.replace(/\s+/g, '');
    if (!part) continue;
    let m;
    if ((m = part.match(/^(\d+)$/))) {
      const n = Number(m[1]);
      check(n, total);
      set.add(n);
    } else if ((m = part.match(/^(\d*)-(\d*)$/)) && (m[1] || m[2])) {
      const a = m[1] ? Number(m[1]) : 1;
      const b = m[2] ? Number(m[2]) : total;
      check(a, total); check(b, total);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) set.add(i);
    } else {
      throw new Error(`„${raw.trim()}“ verstehe ich nicht. Schreibe z. B. 1-5, 8, 10-12.`);
    }
  }
  return set;
}
function check(n, total) {
  if (n < 1) throw new Error('Seitenzahlen beginnen bei 1.');
  if (n > total) throw new Error(`Seite ${n} gibt es nicht, diese Datei hat ${total} ${total === 1 ? 'Seite' : 'Seiten'}.`);
}
// Set {1,2,3,5,7,8} → "1-3, 5, 7-8"
export function formatRanges(set) {
  const nums = [...set].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i ? `${nums[i]}-${nums[j]}` : `${nums[i]}`);
    i = j;
  }
  return out.join(', ');
}

/* ---------- Fenster ---------- */
export function initMerge({ pdfjsLib, pdfOptions, getCurrent, openPdf, toast, api }) {
  const $ = (id) => document.getElementById(id);
  const dlg = $('merge');
  const files = [];          // { id, name, bytes, doc, total, sel:Set, thumbs:Map, sizes:[] }
  let activeId = null;
  let lastClick = null;      // für Umschalt-Klick
  let nextId = 1;
  let observer = null;

  const active = () => files.find(f => f.id === activeId) || null;
  const pagesWord = (n) => (n === 1 ? 'Seite' : 'Seiten');

  async function addFile(data, name) {
    const bytes = new Uint8Array(data);            // eigene Kopie fürs Speichern
    let doc, task;
    try {
      task = pdfjsLib.getDocument({ ...pdfOptions, data: bytes.slice() });
      doc = await task.promise;
    } catch (e) {
      toast(e?.name === 'PasswordException' ? `„${name}“ ist passwortgeschützt und kann nicht zusammengeführt werden.` : `„${name}“ ist kein lesbares PDF.`);
      return;
    }
    const f = { id: nextId++, name, bytes, doc, task, total: doc.numPages, sel: new Set(), thumbs: new Map(), sizes: [] };
    for (let i = 1; i <= f.total; i++) f.sel.add(i);   // Standard: alle Seiten
    files.push(f);
    activeId = f.id;
    lastClick = null;
    renderAll();
  }

  async function addFromDialog() {
    const list = await api.openPdfs();
    for (const f of list) await addFile(f.data, f.name);
  }

  async function addCurrent() {
    const cur = getCurrent();
    if (!cur) return toast('Gerade ist kein PDF geöffnet.');
    await addFile(await cur.pdf.getData(), cur.name);
  }

  function removeFile(id) {
    const i = files.findIndex(f => f.id === id);
    if (i < 0) return;
    files[i].task.destroy().catch(() => {});
    files.splice(i, 1);
    if (activeId === id) activeId = files[Math.min(i, files.length - 1)]?.id ?? null;
    renderAll();
  }
  function moveFile(id, dir) {
    const i = files.findIndex(f => f.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= files.length) return;
    [files[i], files[j]] = [files[j], files[i]];
    renderList();
    renderSummary();
  }

  /* ---- Anzeige ---- */
  function selText(f) {
    if (!f.sel.size) return 'keine Seiten gewählt';
    if (f.sel.size === f.total) return `alle ${f.total} ${pagesWord(f.total)}`;
    return `S. ${formatRanges(f.sel)} · ${f.sel.size} von ${f.total}`;
  }

  function renderList() {
    const list = $('mergeList');
    list.replaceChildren(...files.map((f, idx) => {
      const li = document.createElement('li');
      li.className = 'file' + (f.id === activeId ? ' active' : '');
      li.innerHTML = `
        <button type="button" class="file-main" data-act="pick" title="Seiten dieser Datei anzeigen">
          <span class="fname"></span><span class="fsel"></span>
        </button>
        <div class="file-tools">
          <button type="button" data-act="up" title="Nach oben" aria-label="Nach oben">▲</button>
          <button type="button" data-act="down" title="Nach unten" aria-label="Nach unten">▼</button>
          <button type="button" data-act="rm" class="rm" title="Entfernen" aria-label="Entfernen">✕</button>
        </div>`;
      li.dataset.id = f.id;
      li.querySelector('.fname').textContent = f.name;
      li.querySelector('.fname').title = f.name;
      const fs = li.querySelector('.fsel');
      fs.textContent = selText(f);
      fs.classList.toggle('none', !f.sel.size);
      li.querySelector('[data-act="up"]').disabled = idx === 0;
      li.querySelector('[data-act="down"]').disabled = idx === files.length - 1;
      return li;
    }));
    $('mergeEmpty').hidden = files.length > 0;
  }

  function renderSummary() {
    const used = files.filter(f => f.sel.size);
    const pages = used.reduce((a, f) => a + f.sel.size, 0);
    $('mergeSummary').textContent = pages
      ? `Neues PDF: ${pages} ${pagesWord(pages)} aus ${used.length} ${used.length === 1 ? 'Datei' : 'Dateien'}`
      : (files.length ? 'Noch keine Seiten gewählt' : '');
    $('mergeGo').disabled = !pages;
  }

  function renderHead() {
    const f = active();
    $('mpHead').hidden = !f;
    $('mpEmpty').hidden = !!f;
    if (!f) return;
    $('mpName').textContent = f.name;
    $('mpCount').textContent = `${f.sel.size} von ${f.total} ${pagesWord(f.total)} gewählt`;
    if (document.activeElement !== $('mpRange')) {
      $('mpRange').value = f.sel.size === f.total ? `1-${f.total}` : formatRanges(f.sel);
      $('mpRange').classList.remove('bad');
      $('mpError').hidden = true;
    }
  }

  function renderGrid() {
    const grid = $('mpGrid');
    observer?.disconnect();
    const f = active();
    grid.hidden = !f;
    if (!f) { grid.replaceChildren(); return; }
    observer = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { drawThumb(f, Number(en.target.dataset.n)); observer.unobserve(en.target); }
    }, { root: grid, rootMargin: '300px 0px' });
    const items = [];
    for (let n = 1; n <= f.total; n++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'thumb' + (f.sel.has(n) ? ' on' : '');
      b.dataset.n = n;
      b.setAttribute('aria-pressed', f.sel.has(n));
      b.setAttribute('aria-label', `Seite ${n}`);
      b.innerHTML = `<span class="sheet-img"></span><span class="tick" aria-hidden="true">✓</span><span class="tnum">${n}</span>`;
      const cached = f.thumbs.get(n);
      if (cached) { b.querySelector('.sheet-img').append(cached); b.style.setProperty('--ar', cached.dataset.ar); }
      else observer.observe(b);
      items.push(b);
    }
    grid.replaceChildren(...items);
    grid.scrollTop = 0;
  }

  async function drawThumb(f, n) {
    if (f.thumbs.has(n)) return;
    try {
      const page = await f.doc.getPage(n);
      const v1 = page.getViewport({ scale: 1 });
      const width = 130 * (window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale: width / v1.width });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      c.dataset.ar = (v1.width / v1.height).toFixed(4);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      f.thumbs.set(n, c);
      if (activeId !== f.id) return;
      const b = $('mpGrid').querySelector(`.thumb[data-n="${n}"]`);
      if (b) { b.style.setProperty('--ar', c.dataset.ar); b.querySelector('.sheet-img').replaceChildren(c); }
    } catch { /* Vorschau ist optional */ }
  }

  function updateSelectionUI() {
    const f = active();
    if (!f) return;
    for (const b of $('mpGrid').children) {
      const on = f.sel.has(Number(b.dataset.n));
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    }
    renderHead();
    renderList();
    renderSummary();
  }

  function renderAll() {
    renderList(); renderHead(); renderGrid(); renderSummary();
  }

  /* ---- Zusammenführen ---- */
  async function doMerge() {
    const used = files.filter(f => f.sel.size);
    if (!used.length) return;
    const btn = $('mergeGo');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Führe zusammen …';
    try {
      const { PDFDocument } = window.PDFLib;
      const out = await PDFDocument.create();
      for (const f of used) {
        let src;
        try { src = await PDFDocument.load(f.bytes, { ignoreEncryption: true }); }
        catch { throw new Error(`„${f.name}“ konnte nicht gelesen werden.`); }
        const idx = [...f.sel].sort((a, b) => a - b).map(n => n - 1);
        const copied = await out.copyPages(src, idx);
        copied.forEach(p => out.addPage(p));
      }
      out.setProducer('Tavi');
      out.setCreator('Tavi');
      const bytes = await out.save();
      const base = used.length === 1 ? used[0].name.replace(/\.pdf$/i, '') + ' (Auszug)' : 'Zusammengeführt';
      const r = await api.savePdf(bytes, `${base}.pdf`);
      if (r.canceled) return;
      if (!r.ok) throw new Error(`Speichern fehlgeschlagen: ${r.message}`);
      toast(`Gespeichert: ${r.name}`);
      if ($('mergeOpenAfter').checked) {
        dlg.close();
        openPdf(bytes, r.name);
      }
    } catch (e) {
      toast(e.message || 'Zusammenführen fehlgeschlagen.');
    } finally {
      btn.textContent = label;
      renderSummary();
    }
  }

  /* ---- Ereignisse ---- */
  $('mergeAdd').onclick = addFromDialog;
  $('mergeAddCurrent').onclick = addCurrent;
  $('mergeClose').onclick = () => dlg.close();
  $('mergeGo').onclick = doMerge;

  $('mergeList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const li = e.target.closest('.file');
    if (!btn || !li) return;
    const id = Number(li.dataset.id);
    const act = btn.dataset.act;
    if (act === 'pick' && id !== activeId) { activeId = id; lastClick = null; renderList(); renderHead(); renderGrid(); }
    else if (act === 'up') moveFile(id, -1);
    else if (act === 'down') moveFile(id, 1);
    else if (act === 'rm') removeFile(id);
  });

  $('mpGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.thumb');
    const f = active();
    if (!b || !f) return;
    const n = Number(b.dataset.n);
    const turnOn = !f.sel.has(n);
    if (e.shiftKey && lastClick) {
      const [lo, hi] = lastClick.n < n ? [lastClick.n, n] : [n, lastClick.n];
      for (let i = lo; i <= hi; i++) lastClick.on ? f.sel.add(i) : f.sel.delete(i);
    } else {
      turnOn ? f.sel.add(n) : f.sel.delete(n);
      lastClick = { n, on: turnOn };
    }
    updateSelectionUI();
  });
  $('mpGrid').addEventListener('mousedown', (e) => { if (e.shiftKey) e.preventDefault(); }); // keine Textauswahl beim Umschalt-Klick

  $('mpRange').addEventListener('input', () => {
    const f = active();
    if (!f) return;
    try {
      f.sel = parseRanges($('mpRange').value, f.total);
      $('mpRange').classList.remove('bad');
      $('mpError').hidden = true;
      lastClick = null;
      updateSelectionUI();
    } catch (err) {
      $('mpRange').classList.add('bad');
      $('mpError').textContent = err.message;
      $('mpError').hidden = false;
    }
  });
  $('mpRange').addEventListener('blur', () => renderHead());
  $('mpRange').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('mpRange').blur(); } });
  $('mpAll').onclick = () => { const f = active(); if (!f) return; for (let i = 1; i <= f.total; i++) f.sel.add(i); updateSelectionUI(); };
  $('mpNone').onclick = () => { const f = active(); if (!f) return; f.sel.clear(); updateSelectionUI(); };

  // Ziehen & Ablegen ins Fenster
  dlg.addEventListener('dragover', (e) => { e.preventDefault(); $('mergeList').parentElement.classList.add('dragging'); });
  dlg.addEventListener('dragleave', (e) => { if (!dlg.contains(e.relatedTarget)) $('mergeList').parentElement.classList.remove('dragging'); });
  dlg.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    $('mergeList').parentElement.classList.remove('dragging');
    const pdfs = [...(e.dataTransfer?.files || [])].filter(x => /\.pdf$/i.test(x.name) || x.type === 'application/pdf');
    if (!pdfs.length) return toast('Bitte PDF-Dateien ablegen.');
    for (const f of pdfs) await addFile(new Uint8Array(await f.arrayBuffer()), f.name);
  });

  return {
    open: async () => {
      if (!dlg.open) dlg.showModal();
      // Beim ersten Öffnen das gerade gelesene PDF schon vorschlagen
      if (!files.length && getCurrent()) await addCurrent();
      else renderAll();
    }
  };
}
