// Seiten verwalten: löschen, drehen, umsortieren, Seiten aus anderen PDFs einfügen, Auswahl als eigene PDF speichern.

export function initPages({ pdfjsLib, pdfOptions, getDoc, getBytes, onApply, toast, api }) {
  const $ = (id) => document.getElementById(id);
  const dlg = $('pagesDlg');
  let st = null; // { sources: [{name, pdf, task}], items: [{key, src, index, rot, sel}], token }
  let keySeq = 1;

  async function open() {
    const doc = getDoc();
    if (!doc) return toast('Öffne zuerst ein PDF.');
    st = {
      sources: [{ name: doc.name, pdf: doc.pdf, own: true }],
      items: Array.from({ length: doc.pdf.numPages }, (_, i) => ({ key: keySeq++, src: 0, index: i, rot: 0, sel: false })),
      token: Symbol('pages'), lastSel: null
    };
    $('pagesTitle').textContent = `Seiten verwalten · ${doc.name}`;
    render();
    dlg.showModal();
  }

  function close() {
    if (!st) return;
    for (const s of st.sources) if (!s.own) s.task?.destroy().catch(() => {});
    st = null;
    thumbObs?.disconnect();
    $('pagesGrid').replaceChildren();
    if (dlg.open) dlg.close();
  }

  let thumbObs = null;
  function render() {
    const grid = $('pagesGrid');
    thumbObs?.disconnect();
    thumbObs = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { drawThumb(e.target); thumbObs.unobserve(e.target); }
    }, { root: grid, rootMargin: '200px' });
    grid.replaceChildren(...st.items.map((it, i) => card(it, i)));
    grid.querySelectorAll('.pg-card').forEach(c => thumbObs.observe(c));
    const sel = st.items.filter(i => i.sel).length;
    $('pagesInfo').textContent = `${st.items.length} ${st.items.length === 1 ? 'Seite' : 'Seiten'}` + (sel ? ` · ${sel} ausgewählt` : '');
    for (const id of ['pagesRotL', 'pagesRotR', 'pagesDel', 'pagesExtract']) $(id).disabled = !sel;
    $('pagesAll').textContent = sel === st.items.length ? 'Auswahl aufheben' : 'Alle auswählen';
    $('pagesApply').disabled = !st.items.length;
  }

  function card(it, i) {
    const c = document.createElement('div');
    c.className = 'pg-card' + (it.sel ? ' sel' : '') + (it.src ? ' foreign' : '');
    c.draggable = true;
    c.dataset.key = it.key;
    const src = st.sources[it.src];
    c.innerHTML = `<button type="button" class="pg-thumb" aria-pressed="${it.sel}" title="Klicken zum Auswählen, Strg/Umschalt für mehrere"><span class="pg-img" style="--rot:${it.rot}deg"></span></button>
      <div class="pg-meta"><span class="pg-num">${i + 1}</span><span class="pg-src" title="${esc(src.name)}">${it.src ? `aus ${esc(src.name)}, S. ${it.index + 1}` : (it.index !== i ? `vorher S. ${it.index + 1}` : '')}</span></div>
      <div class="pg-actions">
        <button type="button" class="icon small" data-act="l" title="Nach links drehen" aria-label="Seite ${i + 1} nach links drehen">↺</button>
        <button type="button" class="icon small" data-act="r" title="Nach rechts drehen" aria-label="Seite ${i + 1} nach rechts drehen">↻</button>
        <button type="button" class="icon small danger" data-act="x" title="Seite löschen" aria-label="Seite ${i + 1} löschen">✕</button>
      </div>`;
    c.querySelector('.pg-thumb').onclick = (e) => select(it, e);
    c.querySelector('[data-act="l"]').onclick = () => { it.rot = (it.rot + 270) % 360; render(); };
    c.querySelector('[data-act="r"]').onclick = () => { it.rot = (it.rot + 90) % 360; render(); };
    c.querySelector('[data-act="x"]').onclick = () => { st.items.splice(st.items.indexOf(it), 1); render(); };
    // Ziehen zum Umsortieren
    c.addEventListener('dragstart', (e) => { dragKey = it.key; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(it.key)); });
    c.addEventListener('dragend', () => { dragKey = null; c.classList.remove('dragging'); document.querySelectorAll('.pg-card.drop-before, .pg-card.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after')); });
    c.addEventListener('dragover', (e) => {
      if (dragKey == null) return;
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      c.classList.toggle('drop-after', after); c.classList.toggle('drop-before', !after);
    });
    c.addEventListener('dragleave', () => c.classList.remove('drop-before', 'drop-after'));
    c.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragKey == null) return;
      const after = c.classList.contains('drop-after');
      move(dragKey, it.key, after);
    });
    return c;
  }
  let dragKey = null;
  function move(fromKey, toKey, after) {
    if (fromKey === toKey) return render();
    const from = st.items.find(x => x.key === fromKey);
    // ausgewählte Seiten wandern gemeinsam, wenn die gezogene dazugehört
    const moving = from.sel ? st.items.filter(x => x.sel) : [from];
    if (moving.some(m => m.key === toKey)) return render();
    st.items = st.items.filter(x => !moving.includes(x));
    let at = st.items.findIndex(x => x.key === toKey);
    if (after) at++;
    st.items.splice(at, 0, ...moving);
    render();
  }
  function select(it, e) {
    const idx = st.items.indexOf(it);
    if (e.shiftKey && st.lastSel != null) {
      const a = Math.min(st.lastSel, idx), b = Math.max(st.lastSel, idx);
      st.items.forEach((x, i) => { if (i >= a && i <= b) x.sel = true; });
    } else if (e.ctrlKey || e.metaKey) it.sel = !it.sel;
    else { const only = it.sel && st.items.filter(x => x.sel).length === 1; st.items.forEach(x => { x.sel = false; }); it.sel = !only; }
    st.lastSel = idx;
    render();
  }

  async function drawThumb(cardEl) {
    if (!st) return;
    const it = st.items.find(x => x.key === Number(cardEl.dataset.key));
    if (!it) return;
    const token = st.token;
    try {
      const page = await st.sources[it.src].pdf.getPage(it.index + 1);
      const v1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (150 * (window.devicePixelRatio || 1)) / Math.max(v1.width, v1.height) });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      if (!st || st.token !== token) return;
      cardEl.querySelector('.pg-img')?.replaceChildren(c);
    } catch { /* Vorschau optional */ }
  }

  async function insertPdf() {
    const files = await api.openPdfs();
    if (!files?.length) return;
    for (const f of files) {
      try {
        const task = pdfjsLib.getDocument({ ...pdfOptions, data: new Uint8Array(f.data) });
        const pdf = await task.promise;
        const src = st.sources.push({ name: f.name, pdf, task, bytes: new Uint8Array(f.data) }) - 1;
        // nach der letzten ausgewählten Seite einfügen, sonst ans Ende
        const lastSel = st.items.map(x => x.sel).lastIndexOf(true);
        const at = lastSel >= 0 ? lastSel + 1 : st.items.length;
        const add = Array.from({ length: pdf.numPages }, (_, i) => ({ key: keySeq++, src, index: i, rot: 0, sel: false }));
        st.items.splice(at, 0, ...add);
      } catch (e) {
        toast(`„${f.name}“ konnte nicht gelesen werden (${e.message || e}).`);
      }
    }
    render();
  }

  async function build(items) {
    const { PDFDocument, degrees } = window.PDFLib;
    const loaded = new Map();
    const srcDoc = async (i) => {
      if (!loaded.has(i)) {
        const bytes = i === 0 ? await getBytes() : st.sources[i].bytes;
        loaded.set(i, await PDFDocument.load(bytes, { updateMetadata: false }));
      }
      return loaded.get(i);
    };
    const out = await PDFDocument.create();
    for (const it of items) {
      const src = await srcDoc(it.src);
      const [p] = await out.copyPages(src, [it.index]);
      if (it.rot) p.setRotation(degrees((p.getRotation().angle + it.rot) % 360));
      out.addPage(p);
    }
    const first = await srcDoc(0);
    try { const t = first.getTitle(); if (t) out.setTitle(t); } catch { /* egal */ }
    return out.save({ useObjectStreams: false });
  }

  async function apply() {
    const btn = $('pagesApply');
    btn.disabled = true;
    try {
      const unchanged = st.items.length === st.sources[0].pdf.numPages && st.items.every((x, i) => x.src === 0 && x.index === i && !x.rot);
      if (unchanged) { close(); return; }
      const bytes = await build(st.items);
      close();
      await onApply(bytes);
    } catch (e) {
      console.error(e);
      toast(errText(e));
      btn.disabled = false;
    }
  }

  async function extract() {
    const sel = st.items.filter(x => x.sel);
    if (!sel.length) return;
    try {
      const bytes = await build(sel);
      const doc = getDoc();
      const nums = sel.map(x => st.items.indexOf(x) + 1);
      const base = doc.name.replace(/\.pdf$/i, '');
      const r = await api.savePdfAs(bytes, `${base} (Seite${nums.length > 1 ? 'n' : ''} ${compact(nums)}).pdf`, doc.path ? doc.path.replace(/[\\/][^\\/]*$/, '') : '');
      if (r.ok) { toast(`Gespeichert: ${r.name}`); api.showInFolder(r.path); }
      else if (!r.canceled) toast(`Speichern fehlgeschlagen: ${r.message}`);
    } catch (e) { toast(errText(e)); }
  }

  function bulk(fn) { st.items.filter(x => x.sel).forEach(fn); render(); }
  $('pagesRotL').onclick = () => bulk(x => { x.rot = (x.rot + 270) % 360; });
  $('pagesRotR').onclick = () => bulk(x => { x.rot = (x.rot + 90) % 360; });
  $('pagesDel').onclick = () => { st.items = st.items.filter(x => !x.sel); render(); };
  $('pagesAll').onclick = () => { const all = st.items.every(x => x.sel); st.items.forEach(x => { x.sel = !all; }); render(); };
  $('pagesExtract').onclick = extract;
  $('pagesInsert').onclick = insertPdf;
  $('pagesApply').onclick = apply;
  $('pagesCancel').onclick = close;
  $('pagesClose').onclick = close;
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('keydown', (e) => {
    if (!st || e.target.closest('input')) return;
    if (e.key === 'Delete' && st.items.some(x => x.sel)) { e.preventDefault(); $('pagesDel').click(); }
    if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); st.items.forEach(x => { x.sel = true; }); render(); }
  });

  return { open, close, isOpen: () => dlg.open };
}

function errText(e) {
  if (/encrypt/i.test(e?.message || e?.name || '')) return 'Dieses PDF ist geschützt. Tavi kann es anzeigen, aber noch nicht bearbeiten.';
  return `Das hat nicht geklappt: ${e?.message || e}`;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function compact(nums) {
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i ? `${nums[i]}-${nums[j]}` : `${nums[i]}`);
    i = j;
  }
  return out.join(', ');
}
