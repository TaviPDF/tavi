// Neue Funktionen ab 1.3: Reiter-Leiste, Ansichten, Präsentation, Seitenbefehle, Werkzeuge,
// Listen in der Seitenleiste, Vorlesen, Übersetzen, Vergleichen.
import { ocrPdf, pageHasText, redactPdf, compressPdf, extractGroups, pageOp, diffWords, docWords } from './tools.js';
import { setPassword, removePassword, isEncrypted } from './pdfcrypt.js';
import { EXISTING_TYPES, ANNOT_COLORS } from './annotate.js';

export function initFeatures(c) {
  const { $, state, tabs, api, toast } = c;
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const needDoc = () => { if (!state.doc) { toast('Öffne zuerst ein PDF.'); return false; } return true; };
  const mb = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`);
  const baseName = (doc) => doc.name.replace(/\.pdf$/i, '');
  const dirOf = (p) => (p ? p.replace(/[\\/][^\\/]*$/, '') : '');
  async function replaceDoc(bytes, extra = {}) {
    const doc = state.doc;
    await c.openPdf(bytes, doc.name, { replace: doc, path: doc.path, edited: true, password: doc.password, ...extra });
  }
  const errMsg = (e) => (/encrypt/i.test(`${e?.name} ${e?.message}`) ? 'Dieses PDF ist geschützt. Entferne zuerst das Passwort (Werkzeuge → Passwort).' : (e?.message || String(e)));

  /* ================= Reiter ================= */
  // null = Leiste zugeklappt (Standard, damit mehr Platz zum Lesen bleibt)
  let rtab = null;
  function showRibbon() {
    const annot = c.annotator.isActive(), fill = c.filler.isActive();
    const redact = annot && !!state.doc?.annot?.redact;
    const tab = annot ? (redact ? 'tools' : 'annot') : fill ? 'fill' : (rtab === 'annot' || rtab === 'fill' ? null : rtab);
    rtab = tab;
    $('ribbon').classList.toggle('collapsed', !tab);
    $('rbClose').hidden = !tab;
    document.querySelectorAll('.rb-tab').forEach(b => { const on = b.dataset.rtab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    const panelShown = annot ? 'annot' : fill ? 'fill' : tab;
    document.querySelectorAll('.rb-panel').forEach(p => {
      if (p.id === 'annotBar' || p.id === 'fillBar') return; // die Module steuern ihre Leisten selbst
      p.hidden = p.dataset.rpanel !== panelShown;
    });
    document.querySelectorAll('[data-layout]').forEach(b => b.setAttribute('aria-pressed', (state.doc?.layout || 'single') === b.dataset.layout));
  }
  function setRibbon(tab) {
    rtab = tab;
    if (tab === 'annot') { if (c.filler.isActive()) c.filler.leave(); if (!c.annotator.isActive() || state.doc?.annot?.redact) c.annotator.enter(false); }
    else if (tab === 'fill') { if (c.annotator.isActive()) c.annotator.leave(); if (!c.filler.isActive()) { if (state.doc?.viewRot) { state.doc.viewRot = 0; c.rebuild(); } c.filler.enter(); } }
    else { if (c.annotator.isActive()) c.annotator.leave(); if (c.filler.isActive()) c.filler.leave(); }
    showRibbon();
  }
  // Klick auf den offenen Reiter klappt die Leiste wieder zu
  document.querySelectorAll('.rb-tab').forEach(b => { b.onclick = () => setRibbon(rtab === b.dataset.rtab ? null : b.dataset.rtab); });
  $('rbClose').onclick = () => setRibbon(null);
  document.addEventListener('tavi:mode', showRibbon);
  $('btnFill').addEventListener('click', () => setTimeout(showRibbon, 0));
  $('btnAnnot').addEventListener('click', () => setTimeout(showRibbon, 0));

  /* ================= Ansicht ================= */
  document.querySelectorAll('[data-layout]').forEach(b => {
    b.onclick = () => { if (!needDoc()) return; state.doc.layout = b.dataset.layout; c.rebuild(true); showRibbon(); };
  });
  const rotateView = (d) => {
    if (!needDoc()) return;
    if (c.filler.isActive()) return toast('Beim Ausfüllen lässt sich die Ansicht nicht drehen.');
    state.doc.viewRot = ((state.doc.viewRot || 0) + d + 360) % 360;
    c.rebuild(true);
  };
  $('btnViewRotL').onclick = () => rotateView(-90);
  $('btnViewRotR').onclick = () => rotateView(90);
  $('btnSide2').onclick = () => $('btnSide').click();
  $('btnFullscreen').onclick = () => api.fullscreen?.();

  // Präsentation: eine Seite bildschirmfüllend, Pfeiltasten blättern
  let pres = null;
  async function presentPage() {
    const doc = state.doc;
    if (!pres || !doc) return;
    const n = pres.n;
    const page = await doc.pdf.getPage(n);
    const v1 = page.getViewport({ scale: 1, rotation: (page.rotate + (doc.viewRot || 0)) % 360 });
    const dpr = window.devicePixelRatio || 1;
    const sc = Math.min(window.innerWidth / v1.width, window.innerHeight / v1.height);
    const vp = page.getViewport({ scale: sc * dpr, rotation: (page.rotate + (doc.viewRot || 0)) % 360 });
    const cv = document.createElement('canvas');
    cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
    cv.style.width = `${Math.floor(vp.width / dpr)}px`; cv.style.height = `${Math.floor(vp.height / dpr)}px`;
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    if (!pres || pres.n !== n) return;
    pres.el.querySelector('canvas')?.remove();
    pres.el.prepend(cv);
    pres.el.querySelector('.pr-info').textContent = `${n} / ${doc.pdf.numPages}`;
  }
  async function startPresent() {
    if (!needDoc() || pres) return;
    const el = document.createElement('div');
    el.className = 'present';
    el.innerHTML = '<div class="pr-info"></div>';
    document.body.append(el);
    const wasFull = await api.fullscreen?.(true);
    pres = { el, n: state.doc.current, wasFull };
    let hideT;
    el.addEventListener('mousemove', () => { el.classList.add('cursor'); clearTimeout(hideT); hideT = setTimeout(() => el.classList.remove('cursor'), 1500); });
    el.addEventListener('click', (e) => go(e.clientX < window.innerWidth / 3 ? -1 : 1));
    window.addEventListener('resize', presentPage);
    presentPage();
  }
  function stopPresent() {
    if (!pres) return;
    pres.el.remove();
    window.removeEventListener('resize', presentPage);
    const n = pres.n;
    pres = null;
    api.fullscreen?.(false);
    c.goToPage(n);
  }
  function go(d) {
    if (!pres) return;
    const n = Math.min(state.doc.pdf.numPages, Math.max(1, pres.n + d));
    if (n !== pres.n) { pres.n = n; presentPage(); }
  }
  document.addEventListener('keydown', (e) => {
    if (pres) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') stopPresent();
      else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) go(1);
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) go(-1);
      else if (e.key === 'Home') go(-1e6);
      else if (e.key === 'End') go(1e6);
      return;
    }
    if (e.key === 'F5' && !e.ctrlKey) { e.preventDefault(); startPresent(); }
  }, true);
  $('btnPresent').onclick = startPresent;

  /* ================= Seiten ================= */
  async function quickPageOp(op) {
    if (!needDoc()) return;
    const doc = state.doc, n = doc.current;
    try {
      const bytes = await pageOp(await c.currentBytes(doc), op, n);
      await replaceDoc(bytes);
      if (op === 'blank') c.goToPage(n + 1); else c.goToPage(Math.min(n, doc.pdf.numPages));
      toast({ blank: `Leere Seite nach Seite ${n} eingefügt.`, rotate: `Seite ${n} gedreht.`, delete: `Seite ${n} gelöscht.` }[op] + ' Speichern mit Strg+S.');
    } catch (e) { toast(errMsg(e)); }
  }
  $('btnBlankPage').onclick = () => quickPageOp('blank');
  $('btnRotatePage').onclick = () => quickPageOp('rotate');
  $('btnDeletePage').onclick = () => quickPageOp('delete');
  $('btnImages').onclick = () => c.imagesDialog();

  // Aufteilen
  $('btnSplit').onclick = () => {
    if (!needDoc()) return;
    $('splitInfo').textContent = `„${state.doc.name}“ hat ${state.doc.pdf.numPages} Seiten.`;
    $('splitError').hidden = true; $('splitStatus').textContent = '';
    $('splitDlg').showModal();
  };
  $('splitCancel').onclick = () => $('splitDlg').close();
  $('splitRanges').addEventListener('focus', () => { document.querySelector('input[name="splitMode"][value="ranges"]').checked = true; });
  $('splitEvery').addEventListener('focus', () => { document.querySelector('input[name="splitMode"][value="every"]').checked = true; });
  $('splitGo').onclick = async () => {
    const doc = state.doc, total = doc.pdf.numPages;
    const mode = document.querySelector('input[name="splitMode"]:checked').value;
    let groups = [];
    try {
      if (mode === 'each') groups = Array.from({ length: total }, (_, i) => [i + 1]);
      else if (mode === 'every') {
        const k = Math.max(1, Number($('splitEvery').value) || 1);
        for (let i = 1; i <= total; i += k) groups.push(Array.from({ length: Math.min(k, total - i + 1) }, (_, j) => i + j));
      } else {
        const { parseRanges } = await import('./merge.js');
        groups = $('splitRanges').value.split(/[;|]|,(?=\s*\d+\s*-)/).map(s => s.trim()).filter(Boolean).map(s => [...parseRanges(s, total)].sort((a, b) => a - b)).filter(g => g.length);
        if (!groups.length) throw new Error('Gib die Teile an, z. B. 1-3; 4-6; 7-10');
      }
    } catch (e) { $('splitError').textContent = e.message; $('splitError').hidden = false; return; }
    const dir = await api.pickFolder();
    if (!dir) return;
    $('splitGo').disabled = true;
    try {
      $('splitStatus').textContent = `Erstelle ${groups.length} Dateien …`;
      const outs = await extractGroups(await c.currentBytes(doc), groups);
      let last = null;
      for (let i = 0; i < outs.length; i++) {
        const g = groups[i];
        const label = g.length === 1 ? `Seite ${g[0]}` : `Seiten ${g[0]}-${g[g.length - 1]}`;
        last = await api.writeInto(dir, `${baseName(doc)} (${label}).pdf`, outs[i]);
      }
      $('splitDlg').close();
      toast(`${outs.length} Dateien gespeichert.`);
      if (last?.path) api.showInFolder(last.path);
    } catch (e) { $('splitError').textContent = errMsg(e); $('splitError').hidden = false; }
    finally { $('splitGo').disabled = false; }
  };

  /* ================= Werkzeuge ================= */
  // Texterkennung
  let ocrAbort = null;
  $('btnOcr').onclick = async () => {
    if (!needDoc()) return;
    $('ocrStatus').textContent = 'Prüfe, welche Seiten schon Text haben …';
    $('ocrProgress').hidden = true; $('ocrError').hidden = true; $('ocrGo').disabled = false;
    $('ocrDlg').showModal();
    const doc = state.doc;
    let empty = 0;
    for (let n = 1; n <= doc.pdf.numPages; n++) if (!(await pageHasText(await doc.pdf.getPage(n)))) empty++;
    if (state.doc !== doc) return;
    $('ocrStatus').textContent = empty ? `${empty} von ${doc.pdf.numPages} Seiten haben noch keinen Text.` : 'Alle Seiten haben bereits Text. Du kannst trotzdem alle Seiten erkennen lassen.';
    document.querySelector(`input[name="ocrPages"][value="${empty ? 'empty' : 'all'}"]`).checked = true;
  };
  $('ocrCancel').onclick = () => { ocrAbort?.abort(); $('ocrDlg').close(); };
  $('ocrGo').onclick = async () => {
    const doc = state.doc;
    const lang = $('ocrLang').value;
    const onlyEmpty = document.querySelector('input[name="ocrPages"]:checked').value === 'empty';
    $('ocrGo').disabled = true; $('ocrError').hidden = true;
    ocrAbort = new AbortController();
    try {
      const bytes = await c.currentBytes(doc);
      const task = c.pdfjsLib.getDocument({ ...c.PDF_OPTIONS, data: bytes.slice() });
      const js = await task.promise;
      const pages = [];
      for (let n = 1; n <= js.numPages; n++) if (!onlyEmpty || !(await pageHasText(await js.getPage(n)))) pages.push(n);
      if (!pages.length) { task.destroy(); $('ocrError').textContent = 'Es gibt keine Seiten ohne Text.'; $('ocrError').hidden = false; $('ocrGo').disabled = false; return; }
      $('ocrProgress').hidden = false; $('ocrProgress').max = pages.length; $('ocrProgress').value = 0;
      const t0 = Date.now();
      const res = await ocrPdf({
        bytes, pdfjsDoc: js, lang, pages, signal: ocrAbort.signal,
        onProgress: (d, total, n) => {
          $('ocrProgress').value = d;
          const left = d ? Math.round((Date.now() - t0) / d * (total - d) / 1000) : null;
          $('ocrStatus').textContent = n ? `Erkenne Seite ${n} (${d + 1} von ${total})${left != null ? `, noch etwa ${left} s` : ''} …` : 'Fertig.';
        }
      });
      task.destroy();
      if (state.doc !== doc) return;
      $('ocrDlg').close();
      await replaceDoc(res.bytes);
      toast(`${res.words} Wörter auf ${pages.length} ${pages.length === 1 ? 'Seite' : 'Seiten'} erkannt. Speichern mit Strg+S.`);
    } catch (e) {
      if (e.message !== 'abgebrochen') { $('ocrError').textContent = `Texterkennung fehlgeschlagen: ${errMsg(e)}`; $('ocrError').hidden = false; }
    } finally { $('ocrGo').disabled = false; ocrAbort = null; }
  };

  // Verkleinern
  $('btnCompress').onclick = () => {
    if (!needDoc()) return;
    $('compressStatus').textContent = ''; $('compressGo').disabled = false;
    $('compressDlg').showModal();
  };
  $('compressCancel').onclick = () => $('compressDlg').close();
  $('compressGo').onclick = async () => {
    const doc = state.doc;
    const level = document.querySelector('input[name="compressLevel"]:checked').value;
    $('compressGo').disabled = true;
    try {
      const before = await c.currentBytes(doc);
      const r = await compressPdf(before, level, (i, n) => { $('compressStatus').textContent = `Bild ${i} von ${n} …`; });
      if (r.bytes.length >= before.length * 0.97) {
        $('compressStatus').textContent = r.images ? 'Die Datei lässt sich kaum weiter verkleinern.' : 'Die Datei enthält keine Bilder, die sich verkleinern lassen.';
        return;
      }
      const [b0, b1] = [before.length, r.bytes.length];
      $('compressDlg').close();
      await replaceDoc(r.bytes);
      toast(`Von ${mb(b0)} auf ${mb(b1)} verkleinert. Speichern mit Strg+Umschalt+S als neue Datei.`);
    } catch (e) { $('compressStatus').textContent = errMsg(e); }
    finally { $('compressGo').disabled = false; }
  };

  // Schwärzen
  $('btnRedact').onclick = () => {
    if (!needDoc()) return;
    if (c.filler.isActive()) c.filler.leave();
    c.annotator.enter(true);
    rtab = 'tools';
    showRibbon();
    toast('Markiere Text oder ziehe Rechtecke über Stellen, die entfernt werden sollen. Dann „Schwärzen anwenden“.');
  };
  async function applyRedactions() {
    const doc = state.doc;
    const red = (doc.annot?.items || []).filter(i => i.type === 'redact');
    if (!red.length) { toast('Es ist noch nichts zum Schwärzen markiert.'); return; }
    const choice = await confirmDlg({
      title: 'Endgültig schwärzen?',
      text: `${red.length} ${red.length === 1 ? 'Stelle wird' : 'Stellen werden'} dauerhaft aus dem PDF entfernt, nicht nur überdeckt. Betroffene Seiten werden dafür neu aufgebaut, Formularfelder und Links auf diesen Seiten gehen dabei verloren. Das lässt sich nicht rückgängig machen.`,
      buttons: [['cancel', 'Abbrechen', 'ghost'], ...(doc.path ? [['overwrite', 'Original überschreiben', 'ghost']] : []), ['new', 'Als neue Datei speichern', 'primary']]
    });
    if (choice === 'cancel' || !choice) return;
    try {
      toast('Schwärze …');
      const bytes = await c.currentBytes(doc, { skipRedact: true });
      let out = await redactPdf({ bytes, pdfjsLib: c.pdfjsLib, pdfOptions: c.PDF_OPTIONS, redactions: red.map(r => ({ page: r.page, rect: r.rect })) });
      if (doc.password) out = await setPassword(out, doc.password);
      const r = choice === 'overwrite' ? await api.writeBack(doc.path, out) : await api.savePdfAs(out, `${baseName(doc)} (geschwärzt).pdf`, dirOf(doc.path));
      if (r.canceled) return;
      if (!r.ok) return toast(`Speichern fehlgeschlagen: ${r.message}`);
      c.annotator.leave();
      await c.openPdf(out.slice(), r.name, { replace: doc, path: r.path, password: doc.password });
      showRibbon();
      toast(`Geschwärzt und gespeichert: ${r.name}`);
    } catch (e) { console.error(e); toast(`Schwärzen fehlgeschlagen: ${errMsg(e)}`); }
  }

  // Passwort
  $('btnPassword').onclick = async () => {
    if (!needDoc()) return;
    const doc = state.doc;
    const enc = doc.password != null || await isEncrypted(await doc.pdf.getData());
    $('protSet').hidden = enc; $('protRemove').hidden = !enc;
    $('protError').hidden = true;
    $('protPw1').value = ''; $('protPw2').value = ''; $('protPwOld').value = doc.password || '';
    $('protGo').textContent = enc ? 'Passwort entfernen' : 'Passwort setzen';
    $('protDlg').showModal();
    setTimeout(() => (enc ? $('protPwOld') : $('protPw1')).focus(), 30);
  };
  $('protCancel').onclick = () => $('protDlg').close();
  $('protGo').onclick = async () => {
    const doc = state.doc;
    const remove = !$('protRemove').hidden;
    const err = (m) => { $('protError').textContent = m; $('protError').hidden = false; };
    try {
      if (remove) {
        const pw = $('protPwOld').value;
        let bytes;
        try { bytes = await removePassword(await doc.pdf.getData(), pw); } catch (e) { if (e.message === 'wrong-password') return err('Das Passwort stimmt nicht.'); throw e; }
        doc.password = null;
        $('protDlg').close();
        await c.openPdf(bytes, doc.name, { replace: doc, path: doc.path, edited: true });
        toast('Passwort entfernt. Speichern mit Strg+S (oder als neue Datei mit Strg+Umschalt+S).');
      } else {
        const a = $('protPw1').value, b = $('protPw2').value;
        if (a.length < 4) return err('Bitte mindestens 4 Zeichen verwenden.');
        if (a !== b) return err('Die beiden Passwörter stimmen nicht überein.');
        $('protDlg').close();
        const bytes = await setPassword(await c.currentBytes(doc), a);
        doc.password = a;
        await c.openPdf(bytes, doc.name, { replace: doc, path: doc.path, edited: true, password: a });
        toast('Passwort gesetzt. Speichern mit Strg+S, dann fragt jedes Programm beim Öffnen danach.');
      }
    } catch (e) { console.error(e); err(errMsg(e)); }
  };

  /* ================= Vergleichen ================= */
  $('btnCompare').onclick = () => {
    if (!needDoc()) return;
    const sel = $('cmpOther');
    sel.replaceChildren(...tabs.filter(t => t !== state.doc).map(t => new Option(t.name, t.id)), new Option('Andere Datei wählen …', 'file'));
    $('cmpResult').replaceChildren(); $('cmpStats').textContent = ''; $('cmpAi').hidden = true;
    $('cmpTitle').textContent = `„${state.doc.name}“ vergleichen mit:`;
    $('cmpDlg').showModal();
  };
  $('cmpClose').onclick = () => $('cmpDlg').close();
  let lastDiff = null;
  $('cmpGo').onclick = async () => {
    const a = state.doc;
    let bPdf = null, bName = '', task = null, bDoc = null;
    const v = $('cmpOther').value;
    if (v === 'file') {
      const files = await api.openPdfs();
      if (!files?.[0]) return;
      task = c.pdfjsLib.getDocument({ ...c.PDF_OPTIONS, data: new Uint8Array(files[0].data) });
      bPdf = await task.promise; bName = files[0].name;
    } else { bDoc = tabs.find(t => String(t.id) === v); bPdf = bDoc?.pdf; bName = bDoc?.name; }
    if (!bPdf) return;
    $('cmpStats').textContent = 'Vergleiche …';
    try {
      const [wa, wb] = [await docWords(a.pdf), await docWords(bPdf)];
      const ops = diffWords(wa, wb);
      if (!ops) { $('cmpStats').textContent = 'Die Dokumente sind zu unterschiedlich für einen Wort-Vergleich.'; return; }
      renderDiff(ops, wa, wb, a.name, bName);
      lastDiff = { ops, wa, wb, a, bName, bDoc };
    } catch (e) { $('cmpStats').textContent = `Vergleich fehlgeschlagen: ${errMsg(e)}`; }
    finally { task?.destroy(); }
  };
  function renderDiff(ops, wa, wb, an, bn) {
    let add = 0, del = 0;
    ops.forEach(o => { if (o[0] === '+') add++; else if (o[0] === '-') del++; });
    $('cmpStats').innerHTML = add + del === 0 ? 'Keine Unterschiede im Text gefunden.'
      : `<span class="cmp-del">${del} Wörter nur in „${esc(an)}“</span> · <span class="cmp-add">${add} Wörter nur in „${esc(bn)}“</span>`;
    // Nur Änderungen mit etwas Umgebung zeigen
    const CTX = 8, out = [];
    const isCh = ops.map(o => o[0] !== '=');
    const near = (i) => { for (let k = Math.max(0, i - CTX); k <= Math.min(ops.length - 1, i + CTX); k++) if (isCh[k]) return true; return false; };
    let gap = false, lastPage = null;
    ops.forEach((o, i) => {
      if (!near(i)) { if (!gap) { out.push('<span class="cmp-gap"> … </span>'); gap = true; } return; }
      gap = false;
      const w = o[0] === '-' ? wa[o[1]] : wb[o[2]];
      const pg = o[0] === '-' ? `S. ${w.page} links` : `S. ${w.page}`;
      if (o[0] !== '=' && w.page !== lastPage) { out.push(`<span class="cmp-page">${pg}</span>`); lastPage = w.page; }
      out.push(o[0] === '=' ? esc(w.t) : o[0] === '-' ? `<del class="cmp-del">${esc(w.t)}</del>` : `<ins class="cmp-add">${esc(w.t)}</ins>`);
    });
    $('cmpResult').innerHTML = add + del ? out.join(' ') : '';
    $('cmpAi').hidden = !(add + del);
  }
  $('cmpAi').onclick = () => {
    if (!lastDiff) return;
    if (lastDiff.a.confidential || lastDiff.bDoc?.confidential) return toast('Eines der Dokumente ist vertraulich. Die KI ist dafür ausgeschaltet.');
    const { ops, wa, wb, a, bName } = lastDiff;
    // Änderungen als kompakte Liste an die KI
    const lines = [];
    let cur = null;
    const flush = () => { if (cur) lines.push(`${cur.kind === '-' ? 'ENTFERNT' : 'NEU'} (S. ${cur.page}): ${cur.words.join(' ')}`); cur = null; };
    ops.forEach(o => {
      if (o[0] === '=') return flush();
      const w = o[0] === '-' ? wa[o[1]] : wb[o[2]];
      if (!cur || cur.kind !== o[0]) { flush(); cur = { kind: o[0], page: w.page, words: [] }; }
      cur.words.push(w.t);
    });
    flush();
    const text = lines.join('\n').slice(0, 20000);
    $('cmpDlg').close();
    c.showPanel(true);
    c.ask(`Vergleiche zwei Versionen eines Dokuments. Alte Version: „${a.name}“, neue Version: „${bName}“. Hier sind die Wortänderungen (ENTFERNT = nur in der alten, NEU = nur in der neuen Version):\n\n${text}\n\nFasse zusammen, was sich inhaltlich geändert hat. Ordne nach Wichtigkeit, nenne Seitenzahlen und weise auf rechtlich oder finanziell relevante Änderungen (Fristen, Beträge, Pflichten) besonders hin. Ignoriere reine Formatierungs- und Tippfehler-Änderungen oder fasse sie kurz zusammen.`,
      `Unterschiede zu „${bName}“ zusammenfassen`, null, { none: true });
  };

  /* ================= Vorlesen ================= */
  let tts = null;
  const voice = () => {
    const vs = speechSynthesis.getVoices();
    return vs.find(v => /^de/i.test(v.lang) && /natural|online/i.test(v.name)) || vs.find(v => /^de/i.test(v.lang)) || null;
  };
  const chunks = (t) => (t.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+["“”»]?\s*|[^.!?]+$/g) || []).reduce((acc, s) => {
    if (acc.length && (acc[acc.length - 1] + s).length < 220) acc[acc.length - 1] += s; else acc.push(s);
    return acc;
  }, []);
  async function speakFrom(n, firstText) {
    const doc = state.doc;
    if (!tts || tts.doc !== doc) return;
    if (n > doc.pdf.numPages) { stopTts(); toast('Ende des Dokuments.'); return; }
    tts.page = n;
    c.goToPage(n);
    const text = firstText ?? await c.pageText(n, doc);
    const parts = chunks(text);
    if (!parts.length) return speakFrom(n + 1);
    let i = 0;
    const next = () => {
      if (!tts || tts.doc !== doc) return;
      if (i >= parts.length) return firstText != null ? stopTts() : speakFrom(n + 1);
      const u = new SpeechSynthesisUtterance(parts[i++]);
      const v = voice(); if (v) u.voice = v;
      u.lang = v?.lang || 'de-DE';
      u.rate = Number($('ttsRate').value) || 1;
      u.onend = next;
      u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') toast('Vorlesen nicht möglich: ' + e.error); };
      speechSynthesis.speak(u);
    };
    next();
  }
  function stopTts() { tts = null; speechSynthesis.cancel(); $('ttsPlay').classList.remove('on'); }
  $('ttsPlay').onclick = async () => {
    if (!needDoc()) return;
    if (speechSynthesis.paused && tts) { speechSynthesis.resume(); return; }
    stopTts();
    if (!('speechSynthesis' in window)) return toast('Vorlesen wird hier nicht unterstützt.');
    if (!speechSynthesis.getVoices().length) await new Promise(r => { speechSynthesis.onvoiceschanged = r; setTimeout(r, 800); });
    tts = { doc: state.doc };
    $('ttsPlay').classList.add('on');
    const sel = window.getSelection()?.toString().trim();
    speakFrom(state.doc.current, sel && sel.length > 2 ? sel : undefined);
  };
  $('ttsPause').onclick = () => { if (speechSynthesis.speaking) speechSynthesis.paused ? speechSynthesis.resume() : speechSynthesis.pause(); };
  $('ttsStop').onclick = stopTts;
  document.addEventListener('tavi:tab', () => { if (tts && tts.doc !== state.doc) stopTts(); });

  /* ================= Übersetzen ================= */
  $('btnTranslate').onclick = async () => {
    if (!needDoc()) return;
    const n = state.doc.current, lang = $('translateTo').value;
    const sel = window.getSelection()?.toString().trim();
    c.showPanel(true);
    if (sel && sel.length > 2) return c.ask(`Übersetze diese Textstelle von Seite ${n} vollständig und sinngetreu ins ${langDat(lang)}. Gib nur die Übersetzung aus, ohne Quellenangaben.\n\n"""\n${sel.slice(0, 6000)}\n"""`, `Markierte Stelle ins ${langDat(lang)} übersetzen`, sel, { none: true });
    const text = await c.pageText(n);
    if (!text.trim()) return toast('Auf dieser Seite gibt es keinen Text. Bei Scans hilft zuerst die Texterkennung (Werkzeuge).');
    c.ask(`Übersetze Seite ${n} vollständig und sinngetreu ins ${langDat(lang)}. Behalte Absätze, Überschriften und Aufzählungen bei. Gib nur die Übersetzung aus, ohne Quellenangaben.\n\n"""\n${text.slice(0, 12000)}\n"""`, `Seite ${n} ins ${langDat(lang)} übersetzen`, null, { none: true });
  };
  const langDat = (l) => ({ Deutsch: 'Deutsche', Englisch: 'Englische', Französisch: 'Französische', Spanisch: 'Spanische', Italienisch: 'Italienische', Türkisch: 'Türkische', Polnisch: 'Polnische', Ukrainisch: 'Ukrainische', Russisch: 'Russische', Arabisch: 'Arabische' }[l] || l);

  /* ================= Seitenleiste: Treffer und Kommentare ================= */
  function renderHits() {
    const box = $('hits');
    const f = c.getFind();
    const doc = state.doc;
    if (!doc || !f.needle || !f.hits.length) { box.innerHTML = `<p class="empty">${f.needle ? 'Keine Treffer.' : 'Suche mit Strg+F, dann erscheinen hier alle Fundstellen.'}</p>`; return; }
    box.replaceChildren(Object.assign(document.createElement('div'), { className: 'sl-head', textContent: `${f.hits.length} Treffer für „${$('findInput').value}“` }));
    const q = $('findInput').value.trim().toLowerCase();
    const perPage = new Map();
    f.hits.forEach((h, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sl-item' + (i === f.i ? ' on' : '');
      b.innerHTML = `<span class="sl-meta">Seite ${h.page}</span><span class="sl-text">…</span>`;
      b.onclick = () => c.showHit(i);
      box.append(b);
      const k = perPage.get(h.page) || 0; perPage.set(h.page, k + 1);
      c.pageText(h.page, doc).then(t => {
        const low = t.toLowerCase();
        let at = -1;
        for (let j = 0; j <= k; j++) { at = low.indexOf(q, at + 1); if (at < 0) break; }
        const span = b.querySelector('.sl-text');
        if (at < 0) { span.textContent = t.slice(0, 90); return; }
        const s = Math.max(0, at - 40), e = Math.min(t.length, at + q.length + 50);
        span.innerHTML = (s ? '…' : '') + esc(t.slice(s, at)) + '<mark>' + esc(t.slice(at, at + q.length)) + '</mark>' + esc(t.slice(at + q.length, e)) + (e < t.length ? '…' : '');
      });
    });
  }
  const NAMES = { Highlight: 'Markierung', Underline: 'Unterstrichen', StrikeOut: 'Durchgestrichen', Squiggly: 'Wellenlinie', Text: 'Notiz', Ink: 'Zeichnung', FreeText: 'Textfeld', Square: 'Rechteck', Circle: 'Kreis', Line: 'Linie', Polygon: 'Vieleck', PolyLine: 'Linienzug', Stamp: 'Stempel', Caret: 'Einfügung' };
  const LOCAL = { highlight: 'Highlight', underline: 'Underline', strike: 'StrikeOut', note: 'Text', ink: 'Ink', rect: 'Square', arrow: 'Line', stamp: 'Stamp', redact: 'Schwärzung' };
  const commentCache = new WeakMap();
  async function renderComments() {
    const box = $('comments');
    const doc = state.doc;
    if (!doc) { box.innerHTML = '<p class="empty">Kein Dokument offen.</p>'; return; }
    let list = commentCache.get(doc.pdf);
    if (!list) {
      list = [];
      for (let n = 1; n <= doc.pdf.numPages; n++) {
        try {
          for (const a of await (await doc.pdf.getPage(n)).getAnnotations({ intent: 'display' })) {
            if (!EXISTING_TYPES.has(a.subtype)) continue;
            const col = a.color ? `rgb(${a.color[0]},${a.color[1]},${a.color[2]})` : '#999';
            list.push({ page: n, type: NAMES[a.subtype] || a.subtype, text: a.contentsObj?.str || '', author: a.titleObj?.str || '', color: col, rect: a.rect, id: a.id });
          }
        } catch { /* Seite ohne Anmerkungen */ }
      }
      commentCache.set(doc.pdf, list);
      if (state.doc !== doc) return;
    }
    const removed = doc.annot?.removed || new Set();
    const pend = (doc.annot?.items || []).map(it => ({
      page: it.page, type: (NAMES[LOCAL[it.type]] || LOCAL[it.type]) + ' (neu)', text: it.type === 'stamp' ? it.text : (it.text || ''),
      color: it.type === 'redact' ? '#000' : (ANNOT_COLORS.find(x => x.id === it.color)?.hex || '#999'), rect: it.rect || it.rects?.[0] || (it.x != null ? [it.x, it.y - 20, it.x + 20, it.y] : null)
    }));
    const all = [...list.filter(a => !removed.has(a.id)), ...pend].sort((a, b) => a.page - b.page || (b.rect?.[3] || 0) - (a.rect?.[3] || 0));
    if (!all.length) { box.innerHTML = '<p class="empty">Dieses Dokument hat keine Kommentare oder Markierungen.</p>'; return; }
    box.replaceChildren(Object.assign(document.createElement('div'), { className: 'sl-head', textContent: `${all.length} ${all.length === 1 ? 'Eintrag' : 'Einträge'}` }));
    for (const a of all) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sl-item';
      b.innerHTML = `<span class="sl-meta"><span class="sl-swatch" style="--c:${a.color}"></span>${esc(a.type)} · Seite ${a.page}${a.author ? ` · ${esc(a.author)}` : ''}</span>${a.text ? `<span class="sl-text">${esc(a.text)}</span>` : ''}`;
      b.onclick = () => c.goToRect(a.page, a.rect);
      box.append(b);
    }
  }
  document.addEventListener('tavi:find', () => { if (!$('hits').hidden) renderHits(); });
  $('btnHitList').onclick = () => { c.openSide('hits'); if ($('findBar').hidden) $('btnFind').click(); };
  $('btnCommentList').onclick = () => c.openSide('comments');

  /* ================= Dialog-Helfer ================= */
  function confirmDlg({ title, text, buttons }) {
    return new Promise((res) => {
      const dlg = $('confirmDlg');
      $('confirmTitle').textContent = title;
      $('confirmText').textContent = text;
      const row = $('confirmButtons');
      row.replaceChildren(Object.assign(document.createElement('span'), { className: 'spacer' }), ...buttons.map(([val, label, kind]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = `btn ${kind}`; b.textContent = label;
        b.onclick = () => { dlg.close(); res(val); };
        return b;
      }));
      dlg.onclose = () => res(null);
      dlg.showModal();
    });
  }

  showRibbon();
  return { showRibbon, renderHits, renderComments, applyRedactions, stopTts, isPresenting: () => !!pres, invalidateComments: (doc) => doc?.pdf && commentCache.delete(doc.pdf) };
}
