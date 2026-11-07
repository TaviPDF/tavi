import * as pdfjsLib from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import { initMerge } from './merge.js';
import { initExport } from './export.js';
import { initFill } from './fill.js';
import { initAnnotate } from './annotate.js';
import { initPages } from './pages.js';
import { initProfileDialog } from './profile.js';
import { localRect, localPoint } from './geom.js';
import { initFeatures } from './features.js';
import { captureImage, addImageButtons } from './vision.js';
import { isEncrypted, removePassword, setPassword } from './pdfcrypt.js';

const PDFJS = (p) => new URL(`../node_modules/pdfjs-dist/${p}`, import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS('legacy/build/pdf.worker.mjs');
const PDF_OPTIONS = {
  isEvalSupported: false,
  cMapUrl: PDFJS('cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: PDFJS('standard_fonts/'),
  wasmUrl: PDFJS('wasm/'),
  iccUrl: PDFJS('iccs/')
};

const $ = (id) => document.getElementById(id);
const api = window.api;

const state = {
  doc: null, pages: [], renderToken: 0, busy: false, quote: null, settings: null, observer: null
};
// Alles, was zu einem geöffneten PDF gehört, liegt in seinem Tab (state.doc).
// state.pdf, state.chat usw. zeigen immer auf den aktiven Tab.
const NO_DOC = { pdf: null, task: null, name: '', scale: 1.2, baseWidth: 600, sizes: [], texts: [], current: 1, chat: [] };
for (const k of Object.keys(NO_DOC)) {
  Object.defineProperty(state, k, {
    get: () => (state.doc ? state.doc[k] : NO_DOC[k]),
    set: (v) => { if (state.doc) state.doc[k] = v; else NO_DOC[k] = v; }
  });
}
const tabs = [];
let tabSeq = 1;

// Wie viel Text auf einmal an die KI geht (Zeichen)
const CONTEXT_LIMIT = { gemini: 200000, groq: 9000 };
const LEVELS = {
  einfach: 'Erkläre so einfach, dass es jemand ohne Vorwissen sofort versteht: kurze Sätze, kein Fachjargon, ein Alltagsbeispiel, wo es hilft.',
  normal: 'Erkläre klar und verständlich für Erwachsene ohne Spezialwissen. Fachbegriffe kurz erläutern.',
  fachlich: 'Erkläre präzise und fachlich. Fachbegriffe sind erlaubt, gehe in die Tiefe.'
};

/* ================= PDF ================= */
async function openPdf(data, name, opts = {}) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const size = bytes.byteLength;
  const dup = !opts.replace && tabs.find(t => (opts.path && t.path === opts.path) || (t.name === name && t.size === size));
  if (dup) { activateTab(dup); if (!opts.quiet) toast(`„${name}“ ist schon offen.`); return; }
  let task, pdf, cancelled = false, usedPw = opts.password ?? null;
  try {
    task = pdfjsLib.getDocument({ ...PDF_OPTIONS, data: bytes, ...(opts.password ? { password: opts.password } : {}) });
    task.onPassword = (update, reason) => {
      askPassword(name, reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD).then(pw => {
        if (pw == null) { cancelled = true; task.destroy(); } else { usedPw = pw; update(pw); }
      });
    };
    pdf = await task.promise;
  } catch (e) {
    task?.destroy().catch(() => {});
    if (cancelled) return;
    console.error('PDF öffnen', e);
    toast(`Die Datei konnte nicht geöffnet werden (${e?.message || e}).`);
    return;
  }
  const sizes = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const v = (await pdf.getPage(i)).getViewport({ scale: 1 });
    sizes.push({ w: v.width, h: v.height });
  }
  // Bearbeitetes PDF ersetzt den Inhalt des bestehenden Tabs (Chat und Position bleiben)
  if (opts.replace && tabs.includes(opts.replace)) {
    const tab = opts.replace;
    const old = tab.task;
    const keepTop = state.doc === tab ? $('viewer').scrollTop : tab.scrollTop;
    Object.assign(tab, { name, size, task, pdf, sizes, path: opts.path ?? tab.path, baseWidth: Math.max(...sizes.map(s => s.w)),
      texts: new Array(pdf.numPages).fill(null), current: Math.min(tab.current, pdf.numPages), edited: !!opts.edited, fill: undefined, scrollTop: keepTop, password: usedPw });
    annotator.clearDoc(tab);
    annotator.resetCache(tab);
    if (state.doc === tab) state.doc = null;
    activateTab(tab, true);
    $('viewer').scrollTop = keepTop;
    old?.destroy().catch(() => {});
    saveSession();
    return tab;
  }
  const tab = {
    id: tabSeq++, name, size, task, pdf, sizes, path: opts.path || null,
    baseWidth: Math.max(...sizes.map(s => s.w)),
    texts: new Array(pdf.numPages).fill(null),
    chat: [], current: 1, scale: opts.scale || null, scrollTop: 0, edited: !!opts.edited, password: usedPw
  };
  tabs.push(tab);
  activateTab(tab);
  if (opts.page > 1) { const el = state.pages[opts.page - 1]?.el; if (el) $('viewer').scrollTop = el.offsetTop - 16; }
  saveSession();
  if (opts.path) refreshRecent();
}

// Stand des aktiven Tabs merken (Position), bevor gewechselt wird
function rememberTab() {
  if (state.doc) state.doc.scrollTop = $('viewer').scrollTop;
}

function activateTab(tab, force = false) {
  if (tab === state.doc && !force) return;
  rememberTab();
  hideSelBar();
  setQuote(null);
  state.doc = tab;
  if (!tab) {
    state.observer?.disconnect();
    state.renderToken++;
    $('pages').replaceChildren();
    state.pages = [];
    $('welcome').hidden = false;
    $('docName').textContent = 'Kein Dokument';
    $('docName').title = '';
    document.title = 'Tavi';
    $('pageCount').textContent = '/ –';
    $('pageInput').value = 1;
    $('zoomLabel').textContent = '100 %';
    renderTabs();
    renderMessages();
    filler.syncDoc();
    annotator.syncDoc();
    updateSaveBtn();
    document.dispatchEvent(new Event('tavi:tab'));
    document.dispatchEvent(new Event('tavi:mode'));
    renderSide();
    resetFind();
    updateConf();
    saveSession();
    refreshRecent();
    return;
  }
  if (tab.scale == null) fitWidth(false);
  $('welcome').hidden = true;
  $('docName').textContent = tab.name;
  $('docName').title = tab.name;
  document.title = `${tab.name} – Tavi`;
  $('pageCount').textContent = `/ ${tab.pdf.numPages}`;
  $('pageInput').max = tab.pdf.numPages;
  $('pageInput').value = tab.current;
  buildPages();
  $('viewer').scrollTop = tab.scrollTop;
  renderTabs();
  renderMessages();
  filler.syncDoc();
  annotator.syncDoc();
  updateSaveBtn();
  document.dispatchEvent(new Event('tavi:tab'));
  document.dispatchEvent(new Event('tavi:mode'));
  renderSide();
  resetFind();
  updateConf();
  saveSession();
}

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  if (state.busy && state.busyDoc === tab) { toast('Warte kurz, bis die KI mit diesem Dokument fertig ist.'); return; }
  // Ausgefülltes, aber noch nicht gespeichert: erst beim zweiten Versuch schließen
  if ((filler.hasUnsaved(tab) || isDirty(tab)) && !tab.closeWarned) {
    tab.closeWarned = true;
    if (state.doc !== tab) activateTab(tab);
    toast(isDirty(tab) ? 'Es gibt ungespeicherte Änderungen. Speichern mit Strg+S, oder zum Verwerfen noch einmal schließen.' : 'Das ausgefüllte Formular ist noch nicht gespeichert. Zum Schließen ohne Speichern noch einmal schließen.');
    setTimeout(() => { tab.closeWarned = false; }, 6000);
    return;
  }
  tabs.splice(i, 1);
  if (state.doc === tab) {
    state.doc = null; // nicht merken, der Tab ist weg
    activateTab(tabs[Math.min(i, tabs.length - 1)] || null, true);
  } else renderTabs();
  tab.task.destroy().catch(() => {});
  saveSession();
}

function switchTab(dir) {
  if (tabs.length < 2) return;
  const i = tabs.indexOf(state.doc);
  activateTab(tabs[(i + dir + tabs.length) % tabs.length]);
}

function renderTabs() {
  const bar = $('tabs');
  bar.hidden = tabs.length === 0;
  document.body.classList.toggle('has-tabs', tabs.length > 0);
  const list = $('tabList');
  list.replaceChildren(...tabs.map(t => {
    const el = document.createElement('div');
    el.className = 'tab' + (t === state.doc ? ' active' : '') + (isDirty(t) ? ' unsaved' : '');
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', t === state.doc);
    el.tabIndex = t === state.doc ? 0 : -1;
    el.dataset.id = t.id;
    el.title = `${t.name} · ${t.pdf.numPages} ${t.pdf.numPages === 1 ? 'Seite' : 'Seiten'}`;
    el.innerHTML = '<span class="tab-icon" aria-hidden="true"></span><span class="tab-name"></span><button type="button" class="tab-close" aria-label="Tab schließen" title="Schließen (Strg+W)">×</button>';
    el.querySelector('.tab-name').textContent = t.name.replace(/\.pdf$/i, '');
    return el;
  }));
  list.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function buildPages() {
  const wrap = $('pages');
  state.renderToken++;
  state.observer?.disconnect();
  wrap.replaceChildren();
  state.pages = [];
  state.observer = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) renderPage(Number(en.target.dataset.n));
  }, { root: $('viewer'), rootMargin: '800px 0px' });

  const rot = state.doc?.viewRot || 0;
  wrap.dataset.layout = state.doc?.layout || 'single';
  state.sizes.forEach((s, i) => {
    const W = Math.floor(s.w * state.scale), H = Math.floor(s.h * state.scale);
    const slot = document.createElement('div');
    slot.className = 'page-slot';
    slot.dataset.n = i + 1;
    slot.style.width = `${rot % 180 ? H : W}px`;
    slot.style.height = `${rot % 180 ? W : H}px`;
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.n = i + 1;
    el.dataset.rot = rot;
    el.style.width = `${W}px`;
    el.style.height = `${H}px`;
    if (rot) el.style.transform = { 90: `translateX(${H}px) rotate(90deg)`, 180: `translate(${W}px, ${H}px) rotate(180deg)`, 270: `translateY(${W}px) rotate(270deg)` }[rot];
    el.style.setProperty('--scale-factor', state.scale);
    el.style.setProperty('--total-scale-factor', state.scale);
    const ph = document.createElement('div');
    ph.className = 'ph';
    ph.textContent = `Seite ${i + 1}`;
    el.append(ph);
    slot.append(el);
    wrap.append(slot);
    state.pages.push({ el, slot, token: -1 });
    state.observer.observe(slot);
  });
  $('zoomLabel').textContent = `${Math.round(state.scale * 100)} %`;
}

function renderPage(n) {
  const entry = state.pages[n - 1];
  if (!entry) return Promise.resolve();
  if (entry.token === state.renderToken && entry.ready) return entry.ready;
  entry.token = state.renderToken;
  entry.ready = drawPage(n, entry, state.renderToken);
  return entry.ready;
}

async function drawPage(n, entry, token) {
  try {
    const page = await state.pdf.getPage(n);
    if (token !== state.renderToken) return;
    const vp = page.getViewport({ scale: state.scale });
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${Math.floor(vp.width)}px`;
    canvas.style.height = `${Math.floor(vp.height)}px`;
    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
    }).promise;
    if (token !== state.renderToken) return;
    const tl = document.createElement('div');
    tl.className = 'textLayer';
    entry.el.replaceChildren(canvas, tl);
    const textContent = await page.getTextContent();
    const layer = new pdfjsLib.TextLayer({ textContentSource: textContent, container: tl, viewport: vp });
    await layer.render();
    bindTextLayer(tl);
    if (token === state.renderToken && state.doc?.fill?.active) filler.renderPage(n);
    if (token === state.renderToken) annotator.renderPage(n);
    if (token === state.renderToken) addLinks(page, vp, entry.el);
    if (token === state.renderToken) addImageButtons(pdfjsLib, page, vp, entry.el, (r) => explainImage(n, r));
  } catch (e) {
    console.error('Seite', n, e);
    if (token === state.renderToken) {
      entry.token = -1;
      entry.ready = null;
      const ph = entry.el.querySelector('.ph');
      if (ph) ph.textContent = `Seite ${n} konnte nicht angezeigt werden: ${e?.message || e}`;
    }
  }
}

function setScale(s) {
  if (!state.pdf) return;
  const viewer = $('viewer');
  const ratio = viewer.scrollHeight ? viewer.scrollTop / viewer.scrollHeight : 0;
  state.scale = Math.min(4, Math.max(0.4, Math.round(s * 100) / 100));
  buildPages();
  viewer.scrollTop = ratio * viewer.scrollHeight;
}
function fitWidth(rebuild = true) {
  const doc = state.doc;
  const two = doc && doc.layout && doc.layout !== 'single';
  const base = doc && doc.viewRot % 180 ? Math.max(...state.sizes.map(s => s.h)) : state.baseWidth;
  const avail = $('viewer').clientWidth - 56 - (two ? 16 : 0);
  const s = Math.max(0.3, Math.min(2.2, avail / (base * (two ? 2 : 1))));
  if (rebuild) setScale(s); else state.scale = Math.round(s * 100) / 100;
}

function goToPage(n) {
  if (!state.pdf) return;
  n = Math.min(state.pdf.numPages, Math.max(1, n | 0));
  const el = state.pages[n - 1]?.el;
  if (el) $('viewer').scrollTo({ top: el.offsetTop - 16, behavior: 'smooth' });
}

function trackCurrentPage() {
  if (!state.pdf) return;
  const viewer = $('viewer');
  const mid = viewer.scrollTop + viewer.clientHeight * 0.35;
  let cur = 1;
  for (const p of state.pages) { if (p.el.offsetTop <= mid) cur = Number(p.el.dataset.n); else if (p.el.offsetTop > mid + 4) break; }
  if (cur !== state.current) {
    state.current = cur;
    if (document.activeElement !== $('pageInput')) $('pageInput').value = cur;
    markThumb();
    saveSession();
  }
}

/* ================= Text ================= */
async function pageText(n, doc = state.doc) {
  if (doc.texts[n - 1] != null) return doc.texts[n - 1];
  const page = await doc.pdf.getPage(n);
  const c = await page.getTextContent();
  let s = '';
  for (const it of c.items) {
    if (!('str' in it)) continue;
    s += it.str;
    if (it.hasEOL) s += '\n';
    else if (it.str && !/\s$/.test(it.str)) s += ' ';
  }
  s = s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/(\w)-\n(\w)/g, '$1$2').trim();
  doc.texts[n - 1] = s;
  return s;
}
async function allPages(doc = state.doc) {
  const out = [];
  for (let i = 1; i <= doc.pdf.numPages; i++) out.push({ n: i, text: await pageText(i, doc) });
  return out;
}
const pageBlock = (n, t) => `[Seite ${n}]\n${t || '(kein Text auf dieser Seite)'}`;

function limit() { return CONTEXT_LIMIT[state.settings?.provider || 'gemini']; }

async function buildContext(doc = state.doc) {
  const cur = doc.current;
  const max = limit();
  const pages = await allPages(doc);
  const full = pages.map(p => pageBlock(p.n, p.text)).join('\n\n');
  if (full.length <= max) return { text: full, scope: 'ganzes Dokument' };
  // Zu lang: Fenster um die aktuelle Seite
  const parts = [];
  let used = 0, lo = cur, hi = cur;
  const add = (n) => { const b = pageBlock(n, pages[n - 1].text); if (used + b.length > max) return false; parts[n] = b; used += b.length; return true; };
  add(cur);
  let grew = true;
  while (grew) {
    grew = false;
    if (hi < pages.length && add(hi + 1)) { hi++; grew = true; }
    if (lo > 1 && add(lo - 1)) { lo--; grew = true; }
  }
  if (!parts[cur]) parts[cur] = pageBlock(cur, pages[cur - 1].text.slice(0, max));
  return { text: parts.filter(Boolean).join('\n\n'), scope: `Seiten ${lo}–${hi} von ${pages.length}` };
}

const CITE_RULE = 'Belege jede Aussage, die aus dem Dokument stammt, direkt dahinter mit einer Quelle in genau diesem Format: [S. 4: „wörtliches Zitat“]. '
  + 'Die Seitenzahl steht im Text jeweils als [Seite n]. Das Zitat ist ein zusammenhängender Ausschnitt von 4 bis 15 Wörtern, buchstabengetreu aus dem Dokumenttext kopiert: '
  + 'nicht umformulieren, nichts auslassen, keine Auslassungspunkte, nicht über Seitengrenzen hinweg. Die App markiert damit die Stelle im PDF. '
  + 'Nutze für jede Quelle eigene Klammern. Für Allgemeinwissen gibt es keine Quelle.';

function systemPrompt(ctx, doc = state.doc) {
  const level = LEVELS[$('level').value] || LEVELS.normal;
  let s = `Du bist der Lese-Assistent in der PDF-App „Tavi“. Antworte immer auf Deutsch, außer der Nutzer bittet ausdrücklich um eine andere Sprache. `
    + `Stütze dich auf den Dokumenttext. Wenn etwas nicht im Dokument steht, sag das klar und kennzeichne eigenes Allgemeinwissen als solches. `
    + CITE_RULE + ` Nutze Markdown sparsam: kurze Absätze, Listen, **fett** für Schlüsselbegriffe. ${level}\n\n`
    + `Dokument: „${doc.name}“, ${doc.pdf.numPages} Seiten. Der Nutzer ist gerade auf Seite ${doc.current}.`;
  if (ctx) s += `\nDir liegt folgender Text vor (${ctx.scope}):\n\n"""\n${ctx.text}\n"""`;
  return s;
}

// Fragen über alle offenen PDFs (vertrauliche bleiben außen vor)
async function buildMultiContext() {
  const docs = tabs.filter(t => !t.confidential);
  const per = Math.floor(limit() / Math.max(1, docs.length));
  const parts = [];
  for (const [i, d] of docs.entries()) {
    const pages = await allPages(d);
    let txt = '';
    for (const p of pages) {
      const b = `[D${i + 1} Seite ${p.n}]\n${p.text || '(kein Text)'}\n\n`;
      if (txt.length + b.length > per) { txt += '(… gekürzt, weitere Seiten fehlen)\n'; break; }
      txt += b;
    }
    parts.push(`### D${i + 1}: „${d.name}“ (${d.pdf.numPages} Seiten)\n${txt}`);
  }
  return { text: parts.join('\n'), scope: `${docs.length} Dokumente`, docs: docs.map(d => d.id), names: docs.map(d => d.name) };
}
function multiPrompt(ctx) {
  const level = LEVELS[$('level').value] || LEVELS.normal;
  return `Du bist der Lese-Assistent in der PDF-App „Tavi“. Antworte immer auf Deutsch, außer der Nutzer bittet ausdrücklich um eine andere Sprache. `
    + `Dir liegen mehrere Dokumente vor, gekennzeichnet als D1, D2 usw. Beziehe dich auf alle, die für die Frage wichtig sind, und vergleiche sie, wenn die Frage das verlangt. `
    + `Belege jede Aussage aus einem Dokument direkt dahinter mit einer Quelle in genau diesem Format: [D2 S. 4: „wörtliches Zitat“]. Die Seitenangaben stehen im Text als [D2 Seite 4]. `
    + `Das Zitat ist ein zusammenhängender Ausschnitt von 4 bis 15 Wörtern, buchstabengetreu kopiert. Nenne Dokumente im Text mit ihrem Namen, nicht nur als D1. `
    + `Nutze Markdown sparsam. ${level}\n\nDokumente:\n${ctx.names.map((n, i) => `D${i + 1}: „${n}“`).join('\n')}\n\n"""\n${ctx.text}\n"""`;
}

/* ================= KI ================= */
const ERRORS = {
  nokey: 'Es ist noch kein API-Schlüssel hinterlegt. Öffne die Einstellungen (⚙) und füge einen kostenlosen Schlüssel ein.',
  key: 'Der API-Schlüssel wurde abgelehnt. Prüfe ihn in den Einstellungen.',
  rate: 'Das kostenlose Kontingent ist gerade ausgeschöpft. Warte eine Minute und versuche es erneut.',
  network: 'Keine Verbindung zum KI-Dienst. Bist du online?',
  model: 'Gerade ist kein passendes KI-Modell erreichbar.',
  server: 'Der KI-Dienst hat gerade Probleme. Versuche es gleich noch einmal.',
  blocked: 'Die KI hat diese Anfrage abgelehnt. Formuliere sie anders.',
  empty: 'Die KI hat keine Antwort geliefert. Versuche es noch einmal.'
};
const friendly = (r) => {
  const base = ERRORS[r.code];
  if (!base) return `Fehler vom KI-Dienst: ${r.message}`;
  return ['model', 'server', 'key'].includes(r.code) && r.message ? `${base} (Meldung: ${r.message})` : base;
};

async function callAI(system, messages, onWait) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await api.ask(system, messages);
    if (r.ok) {
      if (r.modelChanged) { toast(`Tavi nutzt jetzt ${r.modelChanged}`); state.settings = await api.getSettings(); }
      return r.text;
    }
    if (r.code === 'rate' && onWait && attempt < 2) {
      for (let s = 30; s > 0; s--) { onWait(`Kostenloses Limit erreicht, warte ${s} s …`); await sleep(1000); }
      continue;
    }
    throw r;
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function historyForApi(doc = state.doc) {
  const all = doc.chat.filter(m => !m.pending && !m.failed);
  // Bilder nur bei der letzten Bildfrage mitschicken (Rückfragen dazu funktionieren, alte Bilder kosten nichts)
  const lastImg = [...all].reverse().find(m => m.images?.length);
  const msgs = all.slice(-12).map(m => (m === lastImg ? { role: m.role, content: m.content, images: m.images } : { role: m.role, content: m.content }));
  while (msgs[0]?.role === 'assistant') msgs.shift();
  return msgs;
}

async function ask(apiText, display, quote, scope = null, images = null) {
  if (state.busy) return toast('Die KI arbeitet noch an der letzten Anfrage.');
  if (!state.pdf) return toast('Öffne zuerst ein PDF.');
  if (state.doc?.confidential) return toast('Dieses Dokument ist als vertraulich markiert. Die KI ist dafür ausgeschaltet.');
  if (!(await aiConsent())) return;
  const doc = state.doc; // bleibt beim Dokument, auch wenn der Tab gewechselt wird
  if (!state.settings?.hasKey?.[state.settings.provider]) { pushError(ERRORS.nokey); return openSettings(); }
  const user = { role: 'user', content: apiText, display, quote };
  if (images?.length) { user.images = images.map(({ mime, data }) => ({ mime, data })); user.thumbs = images.map(i => i.thumb); }
  const reply = { role: 'assistant', content: '', pending: true, status: 'Liest und denkt nach …' };
  doc.chat.push(user, reply);
  setBusy(true);
  renderMessages();
  try {
    // Nur das Nötige senden: bei markierten Stellen nur deren Seite, bei Seitenaktionen steht der Text schon in der Frage
    const multi = state.multi && !scope && tabs.length > 1;
    const ctx = scope?.page ? { text: pageBlock(scope.page, await pageText(scope.page, doc)), scope: `Seite ${scope.page}` }
      : scope?.none ? { text: apiText, scope: 'nur die Frage' } : multi ? await buildMultiContext() : await buildContext(doc);
    if (multi) reply.docs = ctx.docs;
    if (!user.images && ctx.text.replace(/\[Seite \d+\]|\(kein Text auf dieser Seite\)|\s/g, '').length < 40) {
      // Gescannt: die Seite als Bild mitschicken, dann kann die KI sie trotzdem lesen
      const n = scope?.page || doc.current;
      reply.status = 'Seite ist ein Scan, schicke sie als Bild …'; renderMessages();
      const img = await captureImage(doc.pdf, n, null, 2000, doc.viewRot || 0);
      user.images = [{ mime: img.mime, data: img.data }]; user.thumbs = [img.thumb];
      user.content += `\n\n(Hinweis: Das Dokument ist eingescannt und hat keinen auswählbaren Text. Dir liegt Seite ${n} als Bild bei. Lies den Text aus dem Bild. Gib statt wörtlicher Zitate einfach (S. ${n}) als Quelle an.)`;
      renderMessages();
    }
    reply.content = await callAI(multi ? multiPrompt(ctx) : systemPrompt(scope?.none ? null : ctx, doc), historyForApi(doc), (s) => { reply.status = s; renderMessages(); });
    reply.pending = false;
  } catch (r) {
    doc.chat.splice(doc.chat.indexOf(reply), 1);
    user.failed = true;
    pushError(r.code === 'scan' ? 'Dieses PDF enthält keinen auswählbaren Text (vermutlich eingescannt). Die KI kann es deshalb nicht lesen.' : friendly(r), false, doc);
  }
  setBusy(false);
  renderMessages();
}

async function summarizeDoc() {
  if (state.busy) return toast('Die KI arbeitet noch an der letzten Anfrage.');
  if (!state.pdf) return toast('Öffne zuerst ein PDF.');
  if (state.doc?.confidential) return toast('Dieses Dokument ist als vertraulich markiert. Die KI ist dafür ausgeschaltet.');
  if (!(await aiConsent())) return;
  const doc = state.doc; // bleibt beim Dokument, auch wenn der Tab gewechselt wird
  if (!state.settings?.hasKey?.[state.settings.provider]) { pushError(ERRORS.nokey); return openSettings(); }
  const user = { role: 'user', content: 'Fasse das gesamte Dokument zusammen.', display: 'Ganzes Dokument zusammenfassen' };
  const reply = { role: 'assistant', content: '', pending: true, status: 'Lese das Dokument …' };
  doc.chat.push(user, reply);
  setBusy(true);
  renderMessages();
  const status = (s) => { reply.status = s; renderMessages(); };
  const finalAsk = 'Erstelle eine Zusammenfassung mit: 1) einer Kurzfassung in 3–4 Sätzen, 2) den wichtigsten Punkten als Liste mit Quellen, 3) einem kurzen Fazit. Liegen dir Stichpunkte mit Quellen vor, übernimm deren Quellen unverändert.';
  try {
    const pages = await allPages(doc);
    const total = pages.reduce((a, p) => a + p.text.length, 0);
    if (total < 40) throw { code: 'scan' };
    const max = limit();
    const chunks = [];
    let cur = [], len = 0;
    for (const p of pages) {
      const b = pageBlock(p.n, p.text.slice(0, max));
      if (len + b.length > max && cur.length) { chunks.push(cur); cur = []; len = 0; }
      cur.push({ n: p.n, b }); len += b.length;
    }
    if (cur.length) chunks.push(cur);

    if (chunks.length === 1) {
      const ctx = { text: chunks[0].map(c => c.b).join('\n\n'), scope: 'ganzes Dokument' };
      reply.content = await callAI(systemPrompt(ctx, doc), [{ role: 'user', content: finalAsk }], status);
    } else {
      const notes = [];
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const range = `Seiten ${c[0].n}–${c[c.length - 1].n}`;
        status(`Lese Teil ${i + 1} von ${chunks.length} (${range}) …`);
        const t = await callAI(
          'Du fasst Abschnitte eines längeren PDF-Dokuments zusammen. Antworte auf Deutsch in höchstens 8 knappen Stichpunkten. ' + CITE_RULE,
          [{ role: 'user', content: `Abschnitt (${range}):\n\n${c.map(x => x.b).join('\n\n')}` }], status);
        notes.push(`### ${range}\n${t}`);
        if (state.settings.provider === 'groq' && i < chunks.length - 1) await sleep(2500);
      }
      status('Fasse alles zusammen …');
      const ctx = { text: notes.join('\n\n'), scope: 'Stichpunkte aller Abschnitte' };
      reply.content = await callAI(systemPrompt(ctx, doc), [{ role: 'user', content: finalAsk }], status);
    }
    reply.pending = false;
  } catch (r) {
    doc.chat.splice(doc.chat.indexOf(reply), 1);
    user.failed = true;
    pushError(r.code === 'scan' ? 'Dieses PDF enthält keinen auswählbaren Text (vermutlich eingescannt).' : friendly(r), false, doc);
  }
  setBusy(false);
  renderMessages();
}

function pushError(text, render = true, doc = state.doc) {
  if (!doc) return toast(text);
  doc.chat.push({ role: 'assistant', content: text, error: true, failed: true });
  if (render) renderMessages();
}

function setBusy(b) {
  state.busy = b;
  state.busyDoc = b ? state.doc : null;
  $('askBtn').disabled = b;
  document.querySelectorAll('.chip').forEach(c => { c.disabled = b; });
}

/* ================= Nachrichten ================= */
function esc(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\b(S\.|Seite|Seiten)\s?(\d{1,4})/g, '<a class="pref" data-page="$2">$1 $2</a>');
}
const QUOTE_CHARS = /^[\s„“”"»«‚‘’'›‹]+|[\s„“”"»«‚‘’'›‹.,;]+$/g;
// [S. 4: „Zitat“]  oder  (S. 4: „Zitat“)
const CITE_BRACKET = /\[\s*(?:D(\d{1,2})\s*[,·:]?\s*)?(?:S\.|Seite)\s*(\d{1,4})\s*[:,]\s*([^\]]{3,500}?)\s*\]/g;
const CITE_PAREN = /\(\s*(?:S\.|Seite)\s*(\d{1,4})\s*:\s*([„“"»‚][^)]{3,500}?[“”"«‘’])\s*\)/g;

function md(src, docs = null) {
  const cites = [];
  const push = (d, page, quote) => { cites.push({ d, page, quote: quote.replace(QUOTE_CHARS, '') }); return `\u0001${cites.length - 1}\u0001`; };
  src = src.replace(/\r/g, '').replace(CITE_BRACKET, (_m, d, page, quote) => push(d, page, quote)).replace(CITE_PAREN, (_m, page, quote) => push(null, page, quote));
  const lines = src.split('\n');
  let html = '', list = null, para = [];
  const flushP = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  const closeL = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const l = raw.trimEnd();
    let m;
    if (!l.trim()) { flushP(); closeL(); continue; }
    if ((m = l.match(/^(#{1,6})\s+(.*)/))) { flushP(); closeL(); const lv = Math.min(m[1].length + 2, 6); html += `<h${lv}>${inline(m[2])}</h${lv}>`; continue; }
    if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { flushP(); if (list !== 'ul') { closeL(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { flushP(); if (list !== 'ol') { closeL(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; continue; }
    closeL();
    para.push(l.trim());
  }
  flushP(); closeL();
  return html.replace(/\u0001(\d+)\u0001/g, (_m, i) => {
    const c = cites[Number(i)];
    if (!c) return '';
    const tabId = c.d && docs ? docs[Number(c.d) - 1] : null;
    const t = tabId != null ? tabs.find(x => x.id === tabId) : null;
    const label = t ? `${esc(t.name.replace(/\.pdf$/i, '').slice(0, 18))} S. ${c.page}` : `S. ${c.page}`;
    return `<button type="button" class="src" data-page="${c.page}"${t ? ` data-tab="${t.id}"` : ''} data-quote="${esc(c.quote)}" title="Zur Textstelle springen: „${esc(c.quote)}“">${label}</button>`;
  });
}

/* ================= Quellen im PDF markieren ================= */
// Vergleich nur über Buchstaben und Ziffern: unempfindlich gegen Leerzeichen,
// Zeilenumbrüche, Silbentrennung, Anführungszeichen und Ligaturen (ﬁ → fi).
function normChars(ch) {
  let out = '';
  for (const c of ch.normalize('NFKC').toLowerCase()) if (/[\p{L}\p{N}]/u.test(c)) out += c;
  return out;
}
const normText = (t) => normChars(t);

function findInLayer(layer, quote) {
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let hay = '';
  const map = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = node.nodeValue;
    for (let i = 0; i < t.length; i++) {
      const n = normChars(t[i]);
      for (const c of n) { hay += c; map.push([node, i]); }
    }
  }
  if (!hay) return null;
  const tryNeedle = (needle) => {
    if (needle.length < 8) return null;
    const idx = hay.indexOf(needle);
    return idx < 0 ? null : { start: map[idx], end: map[idx + needle.length - 1] };
  };
  const full = tryNeedle(normText(quote));
  if (full) return full;
  // Unscharf: längstes zusammenhängendes Wortstück des Zitats suchen, das im Text vorkommt
  const words = quote.split(/\s+/).filter(Boolean);
  for (let win = words.length - 1; win >= 3; win--) {
    for (let st = 0; st + win <= words.length; st++) {
      const hit = tryNeedle(normText(words.slice(st, st + win).join(' ')));
      if (hit) return hit;
    }
  }
  return null;
}

function clearSourceMarks() {
  document.querySelectorAll('.src-mark, .src-box').forEach(el => el.remove());
  document.querySelectorAll('.page.src-page').forEach(el => el.classList.remove('src-page'));
}

function drawMarks(pageEl, hit, cls) {
  const range = document.createRange();
  range.setStart(hit.start[0], hit.start[1]);
  range.setEnd(hit.end[0], hit.end[1] + 1);
  const rects = [...range.getClientRects()].filter(r => r.width > 1 && r.height > 1)
    .map(r => localRect(pageEl, r))
    .sort((a, b) => a.t - b.t || a.l - b.l);
  if (!rects.length) return null;
  // Rechtecke einer Zeile zusammenfassen
  const lines = [];
  for (const r of rects) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(r.t - last.t) < (last.b - last.t) * 0.6) {
      last.l = Math.min(last.l, r.l); last.r = Math.max(last.r, r.r);
      last.t = Math.min(last.t, r.t); last.b = Math.max(last.b, r.b);
    } else lines.push({ ...r });
  }
  const box = { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity };
  for (const ln of lines) {
    const d = document.createElement('div');
    d.className = cls || 'src-mark';
    Object.assign(d.style, { left: `${ln.l}px`, top: `${ln.t}px`, width: `${ln.r - ln.l}px`, height: `${ln.b - ln.t}px` });
    pageEl.append(d);
    box.l = Math.min(box.l, ln.l); box.t = Math.min(box.t, ln.t); box.r = Math.max(box.r, ln.r); box.b = Math.max(box.b, ln.b);
  }
  if (cls) return box;
  const pad = 5;
  const frame = document.createElement('div');
  frame.className = 'src-box';
  Object.assign(frame.style, { left: `${box.l - pad}px`, top: `${box.t - pad}px`, width: `${box.r - box.l + pad * 2}px`, height: `${box.b - box.t + pad * 2}px` });
  pageEl.append(frame);
  return box;
}

async function showSource(n, quote) {
  if (!state.pdf) return;
  n = Math.min(state.pdf.numPages, Math.max(1, n | 0));
  clearSourceMarks();
  goToPage(n);
  await renderPage(n);
  const entry = state.pages[n - 1];
  if (!entry) return;
  const layer = entry.el.querySelector('.textLayer');
  const hit = quote && layer ? findInLayer(layer, quote) : null;
  const box = hit ? drawMarks(entry.el, hit) : null;
  if (!box) {
    entry.el.classList.add('src-page');
    if (quote) toast(`Die genaue Stelle wurde auf Seite ${n} nicht gefunden. Die Seite ist markiert.`);
    return;
  }
  const viewer = $('viewer');
  viewer.scrollTo({ top: Math.max(0, entry.el.offsetTop + box.t - viewer.clientHeight / 3), behavior: 'smooth' });
}

function renderMessages() {
  const box = $('messages');
  if (!state.chat.length) {
    box.innerHTML = state.pdf
      ? `<div class="empty"><strong>Was möchtest du wissen?</strong><span>Markiere Text im Dokument und wähle „Erklären“ oder „Zusammenfassen“. Oder nutze die Schnellaktionen oben, oder stell unten eine Frage.</span></div>`
      : `<div class="empty"><strong>Noch kein Dokument offen.</strong><span>Öffne ein PDF, dann kann der Assistent es zusammenfassen und erklären.</span></div>`;
    return;
  }
  box.replaceChildren(...state.chat.map((m, i) => {
    const el = document.createElement('div');
    if (m.role === 'user') {
      el.className = 'msg user';
      const b = document.createElement('div');
      b.className = 'bubble';
      b.textContent = m.display || m.content;
      if (m.thumbs?.length) {
        const t = document.createElement('span');
        t.className = 'thumbs';
        for (const src of m.thumbs) { const im = new Image(); im.src = src; im.alt = 'Mitgeschicktes Bild'; t.append(im); }
        b.append(t);
      }
      if (m.quote) {
        const q = document.createElement('span');
        q.className = 'q';
        q.textContent = `„${m.quote.length > 220 ? m.quote.slice(0, 220) + ' …' : m.quote}“`;
        b.append(q);
      }
      el.append(b);
    } else if (m.pending) {
      el.className = 'msg ai';
      el.innerHTML = `<div class="thinking"><span class="dots"><i></i><i></i><i></i></span><span></span></div>`;
      el.querySelector('.thinking span:last-child').textContent = m.status;
    } else if (m.error) {
      el.className = 'msg ai error';
      el.innerHTML = `<div class="bubble"></div>`;
      el.firstChild.textContent = m.content;
    } else {
      el.className = 'msg ai';
      el.innerHTML = `<div class="bubble">${md(m.content, m.docs)}</div><div class="meta"><button data-copy="${i}">Kopieren</button></div>`;
    }
    return el;
  }));
  box.scrollTop = box.scrollHeight;
}

/* ================= Auswahl ================= */
let selection = null;
function showSelBar() {
  if (filler.isActive() || annotator.isActive()) return;
  const sel = window.getSelection();
  const text = sel?.toString().replace(/\s+/g, ' ').trim();
  const node = sel?.anchorNode;
  const pageEl = node && (node.nodeType === 1 ? node : node.parentElement)?.closest('.page');
  if (!text || text.length < 2 || !pageEl) { hideSelBar(); return; }
  selection = { text, page: Number(pageEl.dataset.n) };
  const r = sel.getRangeAt(0).getBoundingClientRect();
  const bar = $('selBar');
  bar.hidden = false;
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  const left = Math.min(window.innerWidth - bw - 8, Math.max(8, r.left + r.width / 2 - bw / 2));
  const top = r.top - bh - 8 > 56 ? r.top - bh - 8 : r.bottom + 8;
  bar.style.left = `${left}px`;
  bar.style.top = `${top}px`;
}
function hideSelBar() { $('selBar').hidden = true; }

function clip(t, max = 6000) { return t.length > max ? t.slice(0, max) + ' …' : t; }

function onSelAction(kind) {
  if (!selection) return;
  const { text, page } = selection;
  if (kind === 'mark') { hideSelBar(); annotator.applyToSelection('highlight', 'yellow'); return; }
  if (kind === 'translate') { hideSelBar(); $('btnTranslate').click(); return; }
  hideSelBar();
  if (kind === 'copy') { copy(text); return; }
  if (kind === 'mark') { annotator.applyToSelection('highlight', 'yellow'); return; }
  showPanel(true);
  if (kind === 'ask') { setQuote(text, page); $('askInput').focus(); return; }
  if (kind === 'explain') {
    ask(`Erkläre diese Textstelle von Seite ${page}. Was bedeutet sie, und wie passt sie in den Zusammenhang?\n\n"""\n${clip(text)}\n"""`, 'Erkläre diese Stelle', text, { page });
  } else {
    ask(`Fasse diese Textstelle von Seite ${page} kurz zusammen (höchstens 5 Stichpunkte oder ein kurzer Absatz).\n\n"""\n${clip(text)}\n"""`, 'Fasse diese Stelle zusammen', text, { page });
  }
  window.getSelection()?.removeAllRanges();
}

function setQuote(text, page) {
  state.quote = text ? { text, page } : null;
  if (state.image) { state.image = null; updateConf(); }
  $('quote').hidden = !text;
  $('quoteText').textContent = text ? `S. ${page}: „${text}“` : '';
}
function setImageAttach(att) {
  setQuote(null);
  state.image = att;
  if (!att) return;
  $('quote').hidden = false;
  const im = new Image(); im.src = att.img.thumb; im.className = 'q-thumb'; im.alt = '';
  $('quoteText').replaceChildren(im, document.createTextNode(` ${att.label}`));
  $('askInput').placeholder = 'Frage zum Bild … (leer lassen = beschreiben und erklären)';
  showPanel(true);
  $('askInput').focus();
}
const IMG_PROMPT = (n) => `Beschreibe und erkläre diese Abbildung von Seite ${n} des Dokuments. Was ist zu sehen (bei Diagrammen: Achsen, Werte, Trends; bei Tabellen: die wichtigsten Zahlen; bei Fotos und Grafiken: die wichtigen Details)? Was bedeutet das, und wie passt es zum Text der Seite? Wenn Text im Bild steht, gib ihn sinngemäß wieder.`;
async function explainImage(n, rect) {
  if (!state.pdf) return;
  const pad = 4;
  const r = [rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad];
  try {
    const img = await captureImage(state.pdf, n, r, 1600, state.doc.viewRot || 0);
    showPanel(true);
    ask(IMG_PROMPT(n), `Abbildung auf Seite ${n} erklären`, null, { page: n }, [img]);
  } catch (e) { toast(`Das Bild konnte nicht aufgenommen werden: ${e.message || e}`); }
}

/* ================= Einstellungen ================= */
let draftProvider = 'gemini';
const modelCache = {};
const AUTO_LABEL = 'Automatisch (empfohlen)';

function setModelOptions() {
  const sel = $('model');
  const cur = state.settings.models[draftProvider] || 'auto';
  const list = modelCache[draftProvider] || [];
  const opts = [new Option(AUTO_LABEL, 'auto'), ...list.map((m, i) => new Option(i === 0 ? `${m} (beste Wahl)` : m, m))];
  if (cur !== 'auto' && !list.includes(cur)) opts.push(new Option(cur, cur));
  sel.replaceChildren(...opts);
  sel.value = cur;
}
function modelStateText() {
  const s = state.settings;
  const active = s.active?.[draftProvider];
  const auto = (s.models[draftProvider] || 'auto') === 'auto';
  if (auto) return active
    ? `Zurzeit im Einsatz: ${active}. Tavi wechselt selbst, wenn ein Modell ausfällt oder sein Gratis-Kontingent aufgebraucht ist.`
    : 'Tavi wählt beim ersten Einsatz selbst das beste Modell und wechselt, wenn eines ausfällt.';
  return 'Festes Modell. Fällt es aus, schaltet Tavi automatisch zurück auf „Automatisch“.';
}
function fillSettings() {
  const s = state.settings;
  $(draftProvider === 'groq' ? 'provGroq' : 'provGemini').checked = true;
  $('apiKey').value = '';
  $('apiKey').placeholder = s.hasKey[draftProvider] ? '•••••••• gespeichert (zum Ändern neu einfügen)' : 'Schlüssel hier einfügen';
  $('keyState').textContent = s.hasKey[draftProvider] ? 'Ein Schlüssel ist sicher auf diesem Gerät gespeichert.' : 'Noch kein Schlüssel gespeichert.';
  setModelOptions();
  $('modelState').textContent = modelStateText();
  $('removeKey').hidden = !s.hasKey[draftProvider];
  $('testResult').hidden = true;
}
async function refreshModels(showResult) {
  if (!state.settings.hasKey[draftProvider]) { if (showResult) testMsg(ERRORS.nokey, false); return; }
  if (showResult) testMsg('Frage verfügbare Modelle ab …');
  const prov = draftProvider;
  const r = await api.models(prov);
  if (!r.ok) { if (showResult) testMsg(friendly(r), false); return; }
  modelCache[prov] = r.models;
  if (prov === draftProvider) setModelOptions();
  if (showResult) testMsg(`${r.models.length} Modelle verfügbar, das beste steht oben.`, true);
}
function openSettings() {
  draftProvider = state.settings.provider;
  fillSettings();
  $('settings').showModal();
  setTimeout(() => $('apiKey').focus(), 50);
  if (!modelCache[draftProvider]) refreshModels(false);
}
async function saveDraft() {
  state.settings = await api.setSettings({ provider: draftProvider, key: $('apiKey').value, model: $('model').value });
  updateSetupCard();
}
function testMsg(text, ok) {
  const t = $('testResult');
  t.hidden = false;
  t.textContent = text;
  t.className = `test ${ok === true ? 'ok' : ok === false ? 'bad' : ''}`;
}
function updateSetupCard() {
  const s = state.settings;
  $('setupCard').hidden = !!s.hasKey[s.provider];
}

/* ================= Kleinkram ================= */
let toastTimer;
function toast(t) {
  const el = $('toast');
  el.textContent = t;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}
async function copy(t) {
  try { await navigator.clipboard.writeText(t); toast('Kopiert'); } catch { toast('Kopieren nicht möglich'); }
}
function showPanel(on) {
  document.body.classList.toggle('no-panel', !on);
  $('togglePanel').classList.toggle('active', on);
}
async function openDialog() {
  const list = await (api.openDocs || api.openPdfs)();   // mehrere auf einmal möglich, jede Datei bekommt einen Tab
  for (const f of list.filter(f => !f.image)) await openPdf(f.data, f.name, { path: f.path });
  const imgs = list.filter(f => f.image);
  if (imgs.length) await imagesToPdf(imgs);
}

/* ================= Speichern ================= */
function isDirty(doc) { return !!doc && (!!doc.edited || annotator.pending(doc) > 0); }
function updateSaveBtn() {
  $('btnSave').classList.toggle('unsaved', isDirty(state.doc));
  $('btnSave').disabled = !state.doc;
}
function editErr(e) {
  if (/encrypt/i.test(`${e?.name} ${e?.message}`)) return 'Dieses PDF ist mit einem Passwort geschützt. Tavi kann es anzeigen, aber noch nicht verändern.';
  return `Das hat nicht geklappt: ${e?.message || e}`;
}
async function currentBytes(doc) {
  let base = await doc.pdf.getData();
  if (doc.password != null || await isEncrypted(base)) {
    try { base = await removePassword(base, doc.password || ''); }
    catch (e) { throw new Error(e.message === 'wrong-password' ? 'Dieses PDF ist vom Ersteller gegen Änderungen geschützt.' : e.message); }
  }
  return annotator.apply(base, doc);
}
let saving = false;
async function saveDoc(asNew = false) {
  const doc = state.doc;
  if (!doc) return toast('Öffne zuerst ein PDF.');
  if (filler.isActive()) return filler.save();
  if (!asNew && doc.path && !isDirty(doc)) return toast('Es gibt keine ungespeicherten Änderungen.');
  if (doc.annot?.items?.some(i => i.type === 'redact')) return features.applyRedactions();
  if (saving) return;
  saving = true;
  try {
    let bytes = await currentBytes(doc);
    if (doc.password) bytes = await setPassword(bytes, doc.password);
    const dir = doc.path ? doc.path.replace(/[\\/][^\\/]*$/, '') : '';
    const name = /\.pdf$/i.test(doc.name) ? doc.name : `${doc.name}.pdf`;
    const r = doc.path && !asNew ? await api.writeBack(doc.path, bytes) : await api.savePdfAs(bytes, name, dir);
    if (r.canceled) return;
    if (!r.ok) return toast(`Speichern fehlgeschlagen: ${r.message}`);
    await openPdf(bytes.slice(), r.name, { replace: doc, path: r.path, password: doc.password });
    toast(`Gespeichert: ${r.name}`);
    refreshRecent();
  } catch (e) {
    console.error(e);
    toast(editErr(e));
  } finally { saving = false; }
}
$('btnSave').onclick = (e) => saveDoc(e.shiftKey);

/* ================= Bilder zu PDF ================= */
async function imagesDialog() {
  const files = await api.openImages?.();
  if (files?.length) await imagesToPdf(files);
}
function jpegOrientation(b) {
  if (b[0] !== 0xFF || b[1] !== 0xD8) return 1;
  let i = 2;
  while (i + 4 < b.length) {
    if (b[i] !== 0xFF) return 1;
    const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xE1 && String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]) === 'Exif') {
      const t = i + 10, le = b[t] === 0x49;
      const r16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
      const r32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])) >>> 0;
      const ifd = t + r32(t + 4);
      const n = r16(ifd);
      for (let k = 0; k < n; k++) { const e = ifd + 2 + k * 12; if (r16(e) === 0x0112) return r16(e + 8); }
      return 1;
    }
    if (m === 0xDA) return 1;
    i += 2 + len;
  }
  return 1;
}
async function reencode(bytes, type) {
  const bmp = await createImageBitmap(new Blob([bytes]));   // dreht Handyfotos automatisch richtig
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d');
  if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.drawImage(bmp, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, type, 0.92));
  return new Uint8Array(await blob.arrayBuffer());
}
async function imagesToPdf(files) {
  const { PDFDocument } = window.PDFLib;
  const out = await PDFDocument.create();
  const bad = [];
  for (const f of files) {
    const bytes = new Uint8Array(f.data);
    try {
      let img;
      if (/\.jpe?g$/i.test(f.name)) img = await out.embedJpg(jpegOrientation(bytes) > 1 ? await reencode(bytes, 'image/jpeg') : bytes);
      else if (/\.png$/i.test(f.name)) img = await out.embedPng(bytes);
      else img = await out.embedPng(await reencode(bytes, 'image/png'));
      const land = img.width > img.height;
      const [W, H] = land ? [841.89, 595.28] : [595.28, 841.89];
      const m = 24, sc = Math.min((W - 2 * m) / img.width, (H - 2 * m) / img.height);
      const w = img.width * sc, h = img.height * sc;
      out.addPage([W, H]).drawImage(img, { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
    } catch (e) { console.error(e); bad.push(f.name); }
  }
  if (bad.length) toast(`Nicht lesbar: ${bad.join(', ')}`);
  if (!out.getPageCount()) return;
  const name = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') + '.pdf' : 'Bilder.pdf';
  await openPdf(await out.save(), name, { edited: true });
  toast('Das PDF ist noch nicht gespeichert. Speichern mit Strg+S.');
}

/* ================= Ereignisse ================= */
$('btnOpen').onclick = openDialog;
$('btnOpen2').onclick = openDialog;
$('btnSetup').onclick = () => openSettings();
$('btnSettings').onclick = () => openSettings();
$('prev').onclick = () => goToPage(state.current - 1);
$('next').onclick = () => goToPage(state.current + 1);
$('pageInput').onchange = (e) => goToPage(Number(e.target.value));
$('zoomIn').onclick = () => setScale(state.scale * 1.15);
$('zoomOut').onclick = () => setScale(state.scale / 1.15);
$('fitWidth').onclick = () => fitWidth(true);
$('togglePanel').onclick = () => showPanel(document.body.classList.contains('no-panel'));
$('clearChat').onclick = () => { if (!state.busy) { state.chat = []; renderMessages(); } };

$('viewer').addEventListener('scroll', () => { trackCurrentPage(); hideSelBar(); }, { passive: true });
$('viewer').addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setScale(state.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });
$('pages').addEventListener('mouseup', () => setTimeout(showSelBar, 0));
document.addEventListener('mousedown', (e) => { if (!$('selBar').contains(e.target)) hideSelBar(); });
$('selBar').addEventListener('mousedown', (e) => e.preventDefault());
$('selBar').addEventListener('click', (e) => { const b = e.target.closest('[data-sel]'); if (b) onSelAction(b.dataset.sel); });

document.querySelector('.quick').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  if (b.dataset.action === 'doc') return summarizeDoc();
  if (!state.pdf) return toast('Öffne zuerst ein PDF.');
  const n = state.current;
  if (b.dataset.action === 'images') {
    const img = await captureImage(state.pdf, n, null, 2000, state.doc.viewRot || 0);
    return ask(`Hier ist Seite ${n} als Bild. Beschreibe und erkläre alle Abbildungen darauf: Fotos, Grafiken, Diagramme, Tabellen, Skizzen. Was zeigen sie, was bedeuten sie, und wie hängen sie mit dem Text zusammen? Wenn die Seite keine Abbildungen hat, sag das kurz.`, `Bilder auf Seite ${n} erklären`, null, { page: n }, [img]);
  }
  if (b.dataset.action === 'page') {
    ask(`Fasse Seite ${n} zusammen: worum geht es, und was sind die wichtigsten Aussagen? Hier der Text der Seite:\n\n${pageBlock(n, await pageText(n))}`, `Seite ${n} zusammenfassen`, null, { none: true });
  } else {
    ask(`Suche auf Seite ${n} die 5–10 wichtigsten Fachbegriffe oder schwierigen Wörter und erkläre jeden in ein bis zwei Sätzen. Hier der Text der Seite:\n\n${pageBlock(n, await pageText(n))}`, `Fachbegriffe auf Seite ${n} erklären`, null, { none: true });
  }
});

$('messages').addEventListener('click', (e) => {
  const src = e.target.closest('.src');
  if (src) {
    const t = src.dataset.tab ? tabs.find(x => String(x.id) === src.dataset.tab) : null;
    if (t && t !== state.doc) activateTab(t);
    return showSource(Number(src.dataset.page), src.dataset.quote);
  }
  const p = e.target.closest('.pref');
  if (p) return showSource(Number(p.dataset.page), null);
  const c = e.target.closest('[data-copy]');
  if (c) copy(state.chat[Number(c.dataset.copy)]?.content || '');
});

$('askForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('askInput').value.trim();
  if (state.image && !state.busy) {
    const att = state.image;
    $('askInput').value = '';
    setImageAttach(null);
    setQuote(null);
    return ask(q ? `Frage zum mitgeschickten Bildausschnitt von Seite ${att.page}: ${q}` : IMG_PROMPT(att.page), q || 'Bildausschnitt erklären', null, { page: att.page }, [att.img]);
  }
  if (!q || state.busy) return;
  const quote = state.quote;
  const apiText = quote ? `Bezug auf diese Textstelle von Seite ${quote.page}:\n"""\n${clip(quote.text)}\n"""\n\nFrage: ${q}` : q;
  $('askInput').value = '';
  setQuote(null);
  ask(apiText, q, quote?.text);
});
$('askInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('askForm').requestSubmit(); }
});
$('quoteClear').onclick = () => setQuote(null);
$('level').onchange = () => api.setSettings({ level: $('level').value });

// Einstellungen
document.querySelectorAll('input[name="provider"]').forEach(r => r.addEventListener('change', () => {
  draftProvider = r.value; fillSettings();
  if (!modelCache[draftProvider]) refreshModels(false);
}));
$('closeSettings').onclick = () => $('settings').close();
$('saveSettings').onclick = async () => { await saveDraft(); $('settings').close(); toast('Gespeichert'); };
$('removeKey').onclick = async () => {
  state.settings = await api.setSettings({ provider: draftProvider, removeKey: true });
  fillSettings(); updateSetupCard(); testMsg('Schlüssel gelöscht.');
};
$('loadModels').onclick = async () => {
  await saveDraft(); fillSettings();
  await refreshModels(true);
};
$('testBtn').onclick = async () => {
  await saveDraft(); fillSettings();
  testMsg('Teste Verbindung, das kann ein paar Sekunden dauern …');
  const r = await api.ask('Antworte nur mit dem Wort: Bereit', [{ role: 'user', content: 'Test' }]);
  state.settings = await api.getSettings();
  fillSettings();
  if (r.ok) testMsg(`Verbindung klappt. Im Einsatz: ${r.model}`, true);
  else testMsg(friendly(r), false);
};
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-link]');
  if (a) { e.preventDefault(); api.openLink(a.dataset.link); }
});

// Ziehen & Ablegen
const viewer = $('viewer');
['dragenter', 'dragover'].forEach(t => viewer.addEventListener(t, (e) => { e.preventDefault(); viewer.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(t => viewer.addEventListener(t, () => viewer.classList.remove('dragging')));
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  if ($('merge').open || $('export').open || $('sigDlg').open) return;
  const all = [...(e.dataTransfer?.files || [])];
  const pdfs = all.filter(x => /\.pdf$/i.test(x.name) || x.type === 'application/pdf');
  const imgs = all.filter(x => /\.(jpe?g|png|webp|gif|bmp)$/i.test(x.name));
  for (const f of pdfs) await openPdf(new Uint8Array(await f.arrayBuffer()), f.name, { path: api.pathForFile?.(f) || null });
  if (imgs.length) await imagesToPdf(await Promise.all(imgs.map(async f => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))));
  if (!pdfs.length && !imgs.length && all.length) toast('Bitte PDF-Dateien oder Bilder ablegen.');
});

// Menü & Tastatur
api.onMenu((cmd) => {
  if (cmd === 'open') openDialog();
  else if (cmd === 'settings') openSettings();
  else if (cmd === 'zoomIn') setScale(state.scale * 1.15);
  else if (cmd === 'zoomOut') setScale(state.scale / 1.15);
  else if (cmd === 'fit') fitWidth(true);
  else if (cmd === 'panel') $('togglePanel').click();
  else if (cmd === 'merge') merger.open();
  else if (cmd === 'export') exporter.open();
  else if (cmd === 'fill') $('btnFill').click();
  else if (cmd === 'closeTab') { if (!$('merge').open && !$('export').open && !$('settings').open && state.doc) closeTab(state.doc); }
  else if (cmd === 'save') saveDoc(false);
  else if (cmd === 'saveAs') saveDoc(true);
  else if (cmd === 'annotate') { if (state.doc) $('btnAnnot').click(); }
  else if (cmd === 'pages') pager.open();
  else if (cmd === 'images') imagesDialog();
  else if (cmd === 'present') $('btnPresent').click();
  else if (cmd === 'ocr') $('btnOcr').click();
  else if (cmd === 'undo' || cmd === 'redo') {
    const el = document.activeElement;
    if (el?.matches?.('input, textarea, [contenteditable]')) document.execCommand(cmd);
    else if (cmd === 'undo') annotator.undo(); else annotator.redo();
  }
  else if (cmd === 'nextTab') switchTab(1);
  else if (cmd === 'prevTab') switchTab(-1);
});
api.onOpenFile((f) => openPdf(f.data, f.name, { path: f.path }));
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, dialog, .tabbar')) return;
  if (e.key === 'ArrowRight') goToPage(state.current + 1);
  if (e.key === 'ArrowLeft') goToPage(state.current - 1);
});
let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(hideSelBar, 100); });

/* ================= Tabs ================= */
$('tabNew').onclick = openDialog;
$('tabList').addEventListener('click', (e) => {
  const el = e.target.closest('.tab');
  if (!el) return;
  const tab = tabs.find(t => t.id === Number(el.dataset.id));
  if (!tab) return;
  if (e.target.closest('.tab-close')) closeTab(tab);
  else activateTab(tab);
});
// Mittlere Maustaste schließt, wie im Browser
$('tabList').addEventListener('auxclick', (e) => {
  if (e.button !== 1) return;
  const el = e.target.closest('.tab');
  const tab = el && tabs.find(t => t.id === Number(el.dataset.id));
  if (tab) { e.preventDefault(); closeTab(tab); }
});
$('tabList').addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
$('tabList').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault(); e.stopPropagation();
    switchTab(e.key === 'ArrowRight' ? 1 : -1);
    $('tabList').querySelector('.tab.active')?.focus();
  } else if (e.key === 'Delete') { e.preventDefault(); if (state.doc) closeTab(state.doc); }
});

/* ================= Zusammenführen ================= */
const merger = initMerge({
  pdfjsLib, pdfOptions: PDF_OPTIONS, api, toast,
  getCurrent: () => (state.pdf ? { pdf: state.pdf, name: state.name } : null),
  openPdf: (bytes, name) => openPdf(bytes, name)
});
$('btnMerge').onclick = () => merger.open();

/* ================= Umwandeln ================= */
const exporter = initExport({ api, toast, getDoc: () => state.doc });
$('btnExport').onclick = () => exporter.open();

/* ================= Diagnose ================= */
// Diagnose für Fehlerberichte: Strg+Alt+Umschalt+D kopiert Messwerte in die Zwischenablage
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey && e.altKey && e.shiftKey && e.key.toLowerCase() === 'd')) return;
  const p = document.querySelector('.page canvas')?.closest('.page');
  const tl = p?.querySelector('.textLayer');
  const pr = p?.getBoundingClientRect(), tr = tl?.getBoundingClientRect();
  const spans = tl ? [...tl.querySelectorAll('span')].filter(s => s.textContent.trim().length > 8).slice(0, 4).map(s => {
    const r = s.getBoundingClientRect(), cs = getComputedStyle(s);
    return { t: s.textContent.slice(0, 20), x: Math.round(r.left - pr.left), y: Math.round(r.top - pr.top), w: Math.round(r.width), h: Math.round(r.height), font: cs.fontFamily, size: cs.fontSize, sx: s.style.getPropertyValue('--scale-x') };
  }) : [];
  const info = { v: state.settings?.version, rot: tl?.dataset.mainRotation, ua: navigator.userAgent, dpr: devicePixelRatio, scale: state.scale, page: pr && [Math.round(pr.width), Math.round(pr.height)], layer: tr && [Math.round(tr.left - pr.left), Math.round(tr.top - pr.top), Math.round(tr.width), Math.round(tr.height)], minFont: tl && getComputedStyle(tl).getPropertyValue('--min-font-size'), spans };
  copy(JSON.stringify(info));
  toast('Diagnose kopiert. Füge sie im Chat mit Claude ein.');
});

/* ================= Textauswahl ================= */
// Wie im Firefox-PDF-Viewer: Ein unsichtbarer Block am Ende der Textebene verhindert,
// dass die Auswahl beim Ziehen neben dem Text auf die ganze Seite springt.
const textLayers = new Map();
let pointerDown = false, prevRange = null;
function bindTextLayer(tl) {
  const end = document.createElement('div');
  end.className = 'endOfContent';
  tl.append(end);
  textLayers.set(tl, end);
  tl.addEventListener('mousedown', () => tl.classList.add('selecting'));
}
function resetTextLayer(end, tl) {
  tl.append(end);
  end.style.width = ''; end.style.height = ''; end.style.userSelect = '';
  tl.classList.remove('selecting');
}
function resetAllTextLayers() {
  for (const [tl, end] of textLayers) {
    if (!tl.isConnected) { textLayers.delete(tl); continue; }
    resetTextLayer(end, tl);
  }
}
document.addEventListener('pointerdown', () => { pointerDown = true; });
document.addEventListener('pointerup', () => { pointerDown = false; resetAllTextLayers(); });
window.addEventListener('blur', () => { pointerDown = false; resetAllTextLayers(); });
document.addEventListener('keyup', () => { if (!pointerDown) resetAllTextLayers(); });
document.addEventListener('selectionchange', () => {
  const sel = document.getSelection();
  if (!sel.rangeCount) { resetAllTextLayers(); return; }
  const active = new Set();
  for (let i = 0; i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i);
    for (const tl of textLayers.keys()) if (!active.has(tl) && tl.isConnected && r.intersectsNode(tl)) active.add(tl);
  }
  for (const [tl, end] of textLayers) {
    if (!tl.isConnected) { textLayers.delete(tl); continue; }
    if (active.has(tl)) tl.classList.add('selecting'); else resetTextLayer(end, tl);
  }
  const range = sel.getRangeAt(0);
  const modifyStart = prevRange && (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0
    || range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
  let anchor = modifyStart ? range.startContainer : range.endContainer;
  if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
  if (!modifyStart && range.endOffset === 0) {
    try {
      do {
        while (!anchor.previousSibling) anchor = anchor.parentNode;
        anchor = anchor.previousSibling;
      } while (!anchor.childNodes.length);
    } catch { anchor = null; }
  }
  const tl = anchor?.parentElement?.closest('.textLayer');
  const end = tl && textLayers.get(tl);
  if (end && anchor.parentElement) {
    end.style.width = tl.style.width;
    end.style.height = tl.style.height;
    end.style.userSelect = 'text';
    anchor.parentElement.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
  }
  prevRange = range.cloneRange();
});

/* ================= Passwort ================= */
function askPassword(name, wrong) {
  return new Promise((res) => {
    const dlg = $('pwDlg');
    $('pwText').textContent = `„${name}“ ist mit einem Passwort geschützt.`;
    $('pwError').hidden = !wrong;
    $('pwInput').value = '';
    let done = false;
    const finish = (v) => { if (done) return; done = true; dlg.close(); res(v); };
    $('pwForm').onsubmit = (e) => { e.preventDefault(); finish($('pwInput').value); };
    $('pwCancel').onclick = () => finish(null);
    dlg.onclose = () => finish(null);
    dlg.showModal();
    setTimeout(() => $('pwInput').focus(), 30);
  });
}

/* ================= Datenschutz ================= */
function aiConsent() {
  if (state.settings?.aiNotice) return Promise.resolve(true);
  return new Promise((res) => {
    const dlg = $('aiDlg');
    let done = false;
    const finish = async (ok) => {
      if (done) return; done = true; dlg.close();
      if (ok) state.settings = await api.setSettings({ aiNotice: true });
      res(ok);
    };
    $('aiOk').onclick = () => finish(true);
    $('aiCancel').onclick = () => finish(false);
    dlg.onclose = () => finish(false);
    dlg.showModal();
  });
}
function updateConf() {
  const on = !!state.doc?.confidential;
  $('confBtn').setAttribute('aria-pressed', on);
  $('confBtn').textContent = on ? 'Vertraulich: an' : 'Vertraulich';
  $('panel').classList.toggle('confidential', on);
  $('askInput').placeholder = on ? 'Die KI ist für dieses Dokument ausgeschaltet.' : 'Frage zum Dokument stellen …';
  $('askInput').disabled = on;
}
$('confBtn').onclick = () => {
  if (!state.doc) return toast('Öffne zuerst ein PDF.');
  state.doc.confidential = !state.doc.confidential;
  updateConf();
  toast(state.doc.confidential ? 'Vertraulich: Für dieses Dokument wird nichts an die KI gesendet.' : 'Die KI ist für dieses Dokument wieder verfügbar.');
};

/* ================= Links im PDF ================= */
async function goToDest(dest) {
  const doc = state.doc;
  try {
    const d = typeof dest === 'string' ? await doc.pdf.getDestination(dest) : dest;
    if (!Array.isArray(d)) return;
    const idx = typeof d[0] === 'number' ? d[0] : await doc.pdf.getPageIndex(d[0]);
    goToPage(idx + 1);
  } catch { /* Ziel nicht auflösbar */ }
}
async function addLinks(page, vp, pageEl) {
  let annots = [];
  try { annots = await page.getAnnotations({ intent: 'display' }); } catch { return; }
  const links = annots.filter(a => a.subtype === 'Link' && a.rect && (a.url || a.dest));
  pageEl.querySelector('.linkLayer')?.remove();
  if (!links.length) return;
  const layer = document.createElement('div');
  layer.className = 'linkLayer';
  for (const a of links) {
    const [x1, y1] = vp.convertToViewportPoint(a.rect[0], a.rect[1]);
    const [x2, y2] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
    const el = document.createElement('a');
    el.className = 'pdf-link';
    el.href = a.url || '#';
    el.title = a.url ? `Öffnen: ${a.url}` : 'Zur Stelle im Dokument springen';
    Object.assign(el.style, { left: `${Math.min(x1, x2)}px`, top: `${Math.min(y1, y2)}px`, width: `${Math.abs(x2 - x1)}px`, height: `${Math.abs(y2 - y1)}px` });
    el.addEventListener('click', (e) => { e.preventDefault(); if (a.url) api.openLink(a.url); else goToDest(a.dest); });
    layer.append(el);
  }
  pageEl.append(layer);
}

/* ================= Seitenleiste ================= */
let sideTab = 'thumbs', thumbObserver = null;
function renderSide() {
  const open = !$('side').hidden;
  if (!open) return;
  const doc = state.doc;
  thumbObserver?.disconnect();
  const box = $('thumbs');
  box.replaceChildren();
  $('outline').replaceChildren();
  if (!doc) { box.innerHTML = '<p class="muted empty">Kein Dokument offen.</p>'; return; }
  thumbObserver = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { drawThumb(doc, Number(en.target.dataset.n), en.target); thumbObserver.unobserve(en.target); }
  }, { root: box, rootMargin: '300px 0px' });
  doc.sizes.forEach((sz, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'thumb-btn' + (i + 1 === doc.current ? ' current' : '');
    b.dataset.n = i + 1;
    b.setAttribute('aria-label', `Seite ${i + 1}`);
    b.innerHTML = `<span class="sheet-img" style="--ar:${(sz.w / sz.h).toFixed(4)}"></span><span>${i + 1}</span>`;
    b.onclick = () => goToPage(i + 1);
    box.append(b);
    thumbObserver.observe(b);
  });
  renderOutline(doc);
  if (sideTab === 'hits') features.renderHits();
  if (sideTab === 'comments') features.renderComments();
}
async function drawThumb(doc, n, btn) {
  try {
    const page = await doc.pdf.getPage(n);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (120 * (window.devicePixelRatio || 1)) / v1.width });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    if (state.doc === doc) btn.querySelector('.sheet-img')?.replaceChildren(c);
  } catch { /* Vorschau optional */ }
}
function markThumb() {
  if ($('side').hidden) return;
  document.querySelectorAll('.thumb-btn.current').forEach(b => b.classList.remove('current'));
  const b = document.querySelector(`.thumb-btn[data-n="${state.current}"]`);
  if (b) { b.classList.add('current'); b.scrollIntoView({ block: 'nearest' }); }
}
async function renderOutline(doc) {
  const box = $('outline');
  let items = null;
  try { items = await doc.pdf.getOutline(); } catch { /* keins */ }
  if (state.doc !== doc) return;
  if (!items?.length) { box.innerHTML = '<p class="muted empty">Dieses PDF hat kein Inhaltsverzeichnis.</p>'; return; }
  const build = (list) => {
    const ul = document.createElement('ul');
    for (const it of list) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = it.title || '(ohne Titel)';
      b.onclick = () => (it.url ? api.openLink(it.url) : goToDest(it.dest));
      li.append(b);
      if (it.items?.length) li.append(build(it.items));
      ul.append(li);
    }
    return ul;
  };
  box.replaceChildren(build(items));
}
function setSideTab(t) {
  sideTab = t;
  for (const [tab, pane] of [['thumbs', 'Thumbs'], ['outline', 'Outline'], ['hits', 'Hits'], ['comments', 'Comments']]) {
    $(`side${pane}Tab`).classList.toggle('on', t === tab); $(`side${pane}Tab`).setAttribute('aria-selected', t === tab);
    $(tab).hidden = t !== tab;
  }
  if (t === 'hits') features.renderHits();
  if (t === 'comments') features.renderComments();
}
function openSide(t) {
  if ($('side').hidden) toggleSide();
  setSideTab(t);
}
$('sideHitsTab').onclick = () => setSideTab('hits');
$('sideCommentsTab').onclick = () => setSideTab('comments');
function toggleSide() {
  $('side').hidden = !$('side').hidden;
  $('btnSide').classList.toggle('active', !$('side').hidden);
  renderSide();
  if (!$('side').hidden) setTimeout(markThumb, 50);
}
$('btnSide').onclick = toggleSide;
$('sideThumbsTab').onclick = () => setSideTab('thumbs');
$('sideOutlineTab').onclick = () => setSideTab('outline');

/* ================= Suchen ================= */
const find = { hits: [], i: -1, token: 0, needle: '' };
function resetFind() {
  find.token++; find.hits = []; find.i = -1;
  document.querySelectorAll('.find-mark').forEach(e => e.remove());
  if (!$('findBar').hidden && $('findInput').value) runFind();
  else $('findCount').textContent = '';
}
function openFind() {
  if (!state.doc) return toast('Öffne zuerst ein PDF.');
  $('findBar').hidden = false;
  $('findInput').focus();
  $('findInput').select();
}
function closeFind() {
  $('findBar').hidden = true;
  find.token++;
  document.querySelectorAll('.find-mark').forEach(e => e.remove());
}
let findTimer;
async function runFind() {
  const doc = state.doc;
  const t = ++find.token;
  find.hits = []; find.i = -1;
  document.querySelectorAll('.find-mark').forEach(e => e.remove());
  find.needle = normText($('findInput').value);
  if (!doc || find.needle.length < 2) { $('findCount').textContent = ''; return; }
  $('findCount').textContent = 'Suche …';
  let shown = false;
  for (let n = 1; n <= doc.pdf.numPages; n++) {
    const hay = normText(await pageText(n, doc));
    if (t !== find.token) return;
    let k = 0, at = hay.indexOf(find.needle);
    while (at >= 0) { find.hits.push({ page: n, k: k++ }); at = hay.indexOf(find.needle, at + find.needle.length); }
    if (!shown && find.hits.length) {
      // ersten Treffer ab der aktuellen Seite zeigen
      const start = find.hits.findIndex(h => h.page >= doc.current);
      if (start >= 0) { shown = true; showHit(start); }
    }
  }
  if (!shown && find.hits.length) showHit(0);
  $('findCount').textContent = find.hits.length ? `${find.i + 1} von ${find.hits.length}` : 'Keine Treffer';
  document.dispatchEvent(new Event('tavi:find'));
}
function layerMatches(layer, needle) {
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let hay = '';
  const map = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const tx = node.nodeValue;
    for (let i = 0; i < tx.length; i++) for (const c of normChars(tx[i])) { hay += c; map.push([node, i]); }
  }
  const out = [];
  let at = hay.indexOf(needle);
  while (at >= 0) { out.push({ start: map[at], end: map[at + needle.length - 1] }); at = hay.indexOf(needle, at + needle.length); }
  return out;
}
async function showHit(i) {
  if (!find.hits.length) return;
  find.i = (i + find.hits.length) % find.hits.length;
  const h = find.hits[find.i];
  $('findCount').textContent = `${find.i + 1} von ${find.hits.length}`;
  document.dispatchEvent(new Event('tavi:find'));
  const t = find.token;
  goToPage(h.page);
  await renderPage(h.page);
  if (t !== find.token) return;
  document.querySelectorAll('.find-mark').forEach(e => e.remove());
  const entry = state.pages[h.page - 1];
  const layer = entry?.el.querySelector('.textLayer');
  const m = layer && layerMatches(layer, find.needle)[h.k];
  if (!m) return;
  const box = drawMarks(entry.el, m, 'find-mark');
  if (box) { const v = $('viewer'); v.scrollTo({ top: Math.max(0, entry.el.offsetTop + box.t - v.clientHeight / 3), behavior: 'smooth' }); }
}
$('btnFind').onclick = openFind;
$('findClose').onclick = closeFind;
$('findInput').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 250); });
$('findInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (!find.hits.length) runFind(); else showHit(find.i + (e.shiftKey ? -1 : 1)); }
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('findNext').onclick = () => showHit(find.i + 1);
$('findPrev').onclick = () => showHit(find.i - 1);

/* ================= Drucken ================= */
function openPrint() {
  const doc = state.doc;
  if (!doc) return toast('Öffne zuerst ein PDF zum Drucken.');
  $('printAllCount').textContent = `(${doc.pdf.numPages})`;
  $('printError').hidden = true;
  $('printStatus').textContent = '';
  $('printGo').disabled = false;
  $('printDlg').showModal();
}
async function doPrint() {
  const doc = state.doc;
  const which = document.querySelector('input[name="printWhich"]:checked').value;
  let pages;
  try {
    if (which === 'all') pages = Array.from({ length: doc.pdf.numPages }, (_, i) => i + 1);
    else if (which === 'current') pages = [doc.current];
    else {
      const { parseRanges } = await import('./merge.js');
      pages = [...parseRanges($('printRange').value, doc.pdf.numPages)].sort((a, b) => a - b);
      if (!pages.length) throw new Error('Gib die Seiten an, z. B. 1-3, 5.');
    }
  } catch (e) { $('printError').textContent = e.message; $('printError').hidden = false; return; }
  $('printGo').disabled = true;
  const area = $('printArea');
  const urls = [];
  const nup = Number($('printNup').value) || 1;
  const copies = Math.max(1, Math.min(99, Number($('printCopies').value) || 1));
  const render = async (n, dpi) => {
    const page = await doc.pdf.getPage(n);
    const vp = page.getViewport({ scale: dpi / 72 });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return c;
  };
  const addSheet = async (canvas) => {
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
    const url = URL.createObjectURL(blob);
    urls.push(url);
    const wrap = document.createElement('div');
    wrap.className = 'print-page';
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {});
    wrap.append(img);
    area.append(wrap);
  };
  try {
    if (nup === 1) {
      for (let i = 0; i < pages.length; i++) {
        $('printStatus').textContent = `Bereite Seite ${i + 1} von ${pages.length} vor …`;
        await addSheet(await render(pages[i], 200));
      }
    } else {
      // Mehrere Seiten auf ein Blatt (A4 bei 150 dpi): 2 nebeneinander im Querformat, 4 als Raster im Hochformat
      const [SW, SH, cols, rows] = nup === 2 ? [1754, 1240, 2, 1] : [1240, 1754, 2, 2];
      const pad = 36;
      for (let i = 0; i < pages.length; i += nup) {
        $('printStatus').textContent = `Bereite Blatt ${i / nup + 1} von ${Math.ceil(pages.length / nup)} vor …`;
        const sheet = document.createElement('canvas');
        sheet.width = SW; sheet.height = SH;
        const ctx = sheet.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, SW, SH);
        const cw = (SW - pad * (cols + 1)) / cols, ch = (SH - pad * (rows + 1)) / rows;
        for (let k = 0; k < nup && i + k < pages.length; k++) {
          const c = await render(pages[i + k], 150);
          const sc = Math.min(cw / c.width, ch / c.height);
          const w = c.width * sc, h = c.height * sc;
          const col = k % cols, row = Math.floor(k / cols);
          const x = pad + col * (cw + pad) + (cw - w) / 2, y = pad + row * (ch + pad) + (ch - h) / 2;
          ctx.drawImage(c, x, y, w, h);
          ctx.strokeStyle = '#d0d4da'; ctx.lineWidth = 1; ctx.strokeRect(x, y, w, h);
        }
        await addSheet(sheet);
      }
    }
    $('printDlg').close();
    const r = await api.print({ duplexMode: $('printDuplex').value, copies, landscape: nup === 2 });
    if (r && r.ok === false && r.reason && !/cancel/i.test(r.reason)) toast(`Drucken nicht möglich: ${r.reason}`);
  } catch (e) {
    toast(`Drucken nicht möglich: ${e.message || e}`);
  } finally {
    area.replaceChildren();
    urls.forEach(u => URL.revokeObjectURL(u));
    $('printGo').disabled = false;
  }
}
$('btnPrint').onclick = openPrint;
$('printGo').onclick = doPrint;
$('printCancel').onclick = () => $('printDlg').close();
$('printRange').addEventListener('focus', () => { document.querySelector('input[name="printWhich"][value="range"]').checked = true; });

/* ================= Zuletzt geöffnet und Sitzung ================= */
async function refreshRecent() {
  if (!api.recent) return;
  const list = await api.recent.list().catch(() => []);
  $('recentBox').hidden = !list.length;
  $('recentList').replaceChildren(...list.slice(0, 8).map(r => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'recent-item';
    b.title = r.path;
    b.innerHTML = '<strong></strong><span></span>';
    b.querySelector('strong').textContent = r.name;
    b.querySelector('span').textContent = r.dir;
    b.onclick = async () => { const f = await api.openPath(r.path); if (f) openPdf(f.data, f.name, { path: f.path }); else { toast('Die Datei wurde nicht gefunden.'); refreshRecent(); } };
    return b;
  }));
}
$('recentClear').onclick = async () => { await api.recent.clear(); refreshRecent(); };
let sessionTimer, restoring = false;
function saveSession() {
  if (restoring || !api.session) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    api.session.save(tabs.filter(t => t.path).map(t => ({ path: t.path, page: t.current, scale: t.scale, active: t === state.doc })));
  }, 600);
}
async function restoreSession() {
  if (!api.session) return;
  const list = await api.session.load().catch(() => []);
  if (!list.length) return;
  restoring = true;
  let active = null;
  for (const t of list) {
    const f = await api.openPath(t.path);
    if (!f) continue;
    await openPdf(f.data, f.name, { path: f.path, page: t.page, scale: t.scale, quiet: true });
    if (t.active) active = tabs[tabs.length - 1];
  }
  restoring = false;
  if (active) activateTab(active);
  saveSession();
}
$('defaultsBtn').onclick = () => api.openDefaultApps?.();

/* ================= Tastenkürzel ================= */
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'f') { e.preventDefault(); openFind(); }
  else if (k === 'p') { e.preventDefault(); openPrint(); }
  else if (k === 'b') { e.preventDefault(); toggleSide(); }
});

/* ================= Ausfüllen ================= */
const annotator = initAnnotate({
  toast,
  getDoc: () => state.doc,
  getScale: () => state.scale,
  getPageEl: (n) => state.pages[n - 1]?.el,
  onChange: () => { renderTabs(); updateSaveBtn(); if (sideTab === 'comments' && !$('side').hidden) features.renderComments(); },
  onSave: () => (state.doc?.annot?.redact ? features.applyRedactions() : saveDoc(false)),
  onEnter: () => { if (filler.isActive()) filler.leave(); hideSelBar(); }
});
$('btnFill').addEventListener('click', () => { if (annotator.isActive()) annotator.leave(); });
const pager = initPages({
  pdfjsLib, pdfOptions: PDF_OPTIONS, api, toast,
  getDoc: () => state.doc,
  getBytes: () => currentBytes(state.doc),
  onApply: async (bytes) => {
    const doc = state.doc;
    await openPdf(bytes, doc.name, { replace: doc, path: doc.path, edited: true });
    toast('Seiten geändert. Speichern mit Strg+S.');
  }
});
$('btnPages').onclick = () => pager.open();
const profileDlg = initProfileDialog({ api, toast });
$('profileBtn').onclick = () => { $('settings').close(); profileDlg.open(); };
const filler = initFill({
  openProfile: () => profileDlg.open(),
  pdfjsLib, api, toast,
  getDoc: () => state.doc,
  getScale: () => state.scale,
  getPageEl: (n) => state.pages[n - 1]?.el,
  renderedPages: () => state.pages.filter(p => p.el.querySelector('canvas')).map(p => Number(p.el.dataset.n))
});

/* ================= Bereich auswählen und von der KI erklären lassen ================= */
let snip = null;
function setSnip(on) {
  document.body.classList.toggle('snipping', on);
  $('btnSnip').classList.toggle('on', on);
  if (on) toast('Ziehe ein Rechteck um die Stelle, die die KI erklären soll. Esc bricht ab.');
}
$('btnSnip').onclick = () => { if (!state.pdf) return toast('Öffne zuerst ein PDF.'); setSnip(!document.body.classList.contains('snipping')); };
$('pages').addEventListener('pointerdown', (e) => {
  if (!document.body.classList.contains('snipping') || e.button !== 0) return;
  const pageEl = e.target.closest('.page');
  if (!pageEl) return;
  e.preventDefault();
  const box = document.createElement('div');
  box.className = 'snip-rect';
  pageEl.append(box);
  snip = { pageEl, box, a: localPoint(pageEl, e.clientX, e.clientY) };
  snip.b = snip.a;
}, true);
document.addEventListener('pointermove', (e) => {
  if (!snip) return;
  snip.b = localPoint(snip.pageEl, e.clientX, e.clientY);
  const [x1, y1] = snip.a, [x2, y2] = snip.b;
  Object.assign(snip.box.style, { left: `${Math.min(x1, x2)}px`, top: `${Math.min(y1, y2)}px`, width: `${Math.abs(x2 - x1)}px`, height: `${Math.abs(y2 - y1)}px` });
});
document.addEventListener('pointerup', async () => {
  if (!snip) return;
  const { pageEl, box, a, b } = snip;
  snip = null;
  box.remove();
  setSnip(false);
  if (Math.abs(b[0] - a[0]) < 12 || Math.abs(b[1] - a[1]) < 12) return;
  const n = Number(pageEl.dataset.n);
  const vp = (await state.pdf.getPage(n)).getViewport({ scale: state.scale });
  const p1 = vp.convertToPdfPoint(a[0], a[1]), p2 = vp.convertToPdfPoint(b[0], b[1]);
  const rect = [Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1]), Math.max(p1[0], p2[0]), Math.max(p1[1], p2[1])];
  try {
    const img = await captureImage(state.pdf, n, rect, 1600, state.doc.viewRot || 0);
    setImageAttach({ page: n, img, label: `Bildausschnitt von Seite ${n}` });
  } catch (e) { toast(`Der Ausschnitt konnte nicht aufgenommen werden: ${e.message || e}`); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('snipping')) { snip?.box.remove(); snip = null; setSnip(false); } });

/* ================= Neue Funktionen (Reiter, Werkzeuge, Ansicht) ================= */
const features = initFeatures({
  $, state, tabs, api, toast, pdfjsLib, PDF_OPTIONS, openPdf, currentBytes, annotator, filler, imagesDialog, pageText, ask, showPanel, goToPage, openSide,
  getFind: () => find,
  showHit: (i) => showHit(i),
  rebuild: (refit) => {
    const n = state.doc?.current;
    if (refit) fitWidth(false);
    buildPages();
    renderSide();
    const el = n && state.pages[n - 1]?.slot;
    if (el) $('viewer').scrollTop = el.offsetTop - 16;
  },
  goToRect: (n, rect) => {
    const e = state.pages[n - 1];
    if (!e) return;
    const y = rect ? Math.max(0, (state.sizes[n - 1].h - rect[3]) * state.scale - 80) : 0;
    $('viewer').scrollTo({ top: e.slot.offsetTop + y - 16, behavior: 'smooth' });
  }
});
state.multi = false;
$('multiBtn').onclick = () => {
  state.multi = !state.multi;
  $('multiBtn').setAttribute('aria-pressed', state.multi);
  toast(state.multi ? 'Freie Fragen gehen jetzt an alle offenen PDFs (vertrauliche ausgenommen).' : 'Fragen gehen wieder nur an das aktuelle PDF.');
};

/* ================= Mac ================= */
if (api.platform === 'darwin') {
  document.body.classList.add('mac');
  // Tastenkürzel in Hinweisen als ⌘ anzeigen
  document.querySelectorAll('[title]').forEach(el => { el.title = el.title.replace(/Strg\+Umschalt\+/g, '⇧⌘').replace(/Strg\s?\+\s?/g, '⌘').replace(/Strg /g, '⌘'); });
  $('defaultsBtn').hidden = true;
  $('defaultsBtn').nextElementSibling.textContent = 'Im Finder eine PDF mit Rechtsklick wählen → Informationen → „Öffnen mit“: Tavi → „Alle ändern …“.';
}

/* ================= Updates ================= */
const UPD = api.update;
let updState = null;
function fmtTime(t) {
  if (!t) return '';
  const d = new Date(t);
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}
function renderUpdate(st) {
  if (!st) return;
  updState = st;
  const pill = $('updPill');
  pill.classList.remove('ready');
  pill.hidden = true;
  pill.disabled = true;
  if (st.status === 'downloading') {
    pill.hidden = false;
    pill.textContent = `Update ${st.version} wird geladen ${st.progress || 0} %`;
    pill.title = 'Tavi lädt die neue Version im Hintergrund.';
  } else if (st.status === 'ready') {
    pill.hidden = false;
    pill.disabled = false;
    pill.classList.add('ready');
    pill.textContent = `Update ${st.version} bereit · Neu starten`;
    pill.title = (st.notes ? `Neu in ${st.version}:\n${st.notes}\n\n` : '') + 'Klicken, um Tavi neu zu starten. Offene PDFs musst du danach wieder öffnen. Ohne Klick wird das Update beim nächsten Schließen eingespielt.';
  }
  if (st.status === 'manual') {
    pill.hidden = false; pill.disabled = false; pill.classList.add('ready');
    pill.textContent = `Update ${st.version} herunterladen`;
    pill.title = (st.notes ? `Neu in ${st.version}:\n${st.notes}\n\n` : '') + 'Öffnet die Download-Seite. Danach die neue Tavi-App in den Programme-Ordner ziehen und die alte ersetzen.';
  }
  $('updVersion').textContent = `Installiert: Version ${st.current}`;
  const text = {
    off: 'Updates sind in dieser Version noch nicht eingerichtet.',
    store: 'Updates kommen automatisch über den Microsoft Store.',
    idle: st.error ? `Letzter Versuch fehlgeschlagen: ${st.error}` : (st.checkedAt ? `Zuletzt gesucht um ${fmtTime(st.checkedAt)} Uhr.` : 'Noch nicht gesucht.'),
    checking: 'Suche nach neuen Versionen …',
    current: `Tavi ist aktuell (gesucht um ${fmtTime(st.checkedAt)} Uhr).`,
    downloading: `Version ${st.version} wird geladen: ${st.progress || 0} %`,
    ready: `Version ${st.version} ist geladen. Sie wird beim Neustart eingespielt.`,
    manual: `Version ${st.version} ist verfügbar. Lade sie über den Knopf oben rechts herunter.`,
    error: st.error
  }[st.status] || '';
  $('updStatus').textContent = text;
  $('updCheck').disabled = st.status === 'off' || st.status === 'store' || st.status === 'checking' || st.status === 'downloading' || st.status === 'ready';
  $('updAuto').disabled = st.status === 'off' || st.status === 'store';
  if (typeof st.auto === 'boolean') $('updAuto').checked = st.auto;
}
if (UPD) {
  UPD.onState(renderUpdate);
  UPD.get().then(renderUpdate);
  $('updCheck').onclick = async () => renderUpdate(await UPD.check());
  $('updAuto').onchange = async () => { const on = await UPD.setAuto($('updAuto').checked); renderUpdate({ ...updState, auto: on }); };
  $('updPill').onclick = () => { if (updState?.status === 'ready') UPD.apply(); else if (updState?.status === 'manual' && updState.url) api.openLink(updState.url); };
}

/* ================= Start ================= */
(async () => {
  state.settings = await api.getSettings();
  $('level').value = state.settings.level;
  showPanel(true);
  updateSetupCard();
  renderMessages();
  refreshRecent();
  restoreSession();
})();
