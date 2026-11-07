// PDF-Passwortschutz setzen (AES-256, R6) und entfernen (RC4 40/128, AES-128, AES-256).
// Arbeitet mit pdf-lib (window.PDFLib). Nur Standard-Sicherheit nach ISO 32000.

const L = () => window.PDFLib;
const te = new TextEncoder();

/* ================= Kryptografie-Grundlagen ================= */
// AES (synchron, Tabellen werden einmal berechnet)
const SBOX = new Uint8Array(256), INV = new Uint8Array(256);
(() => {
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV[SBOX[i]] = i;
})();
const xt = (a) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
const mul = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xt(a); b >>= 1; } return r; };
function expandKey(key) {
  const nk = key.length / 4, nr = nk + 6, w = new Uint8Array(16 * (nr + 1));
  w.set(key);
  let rcon = 1;
  for (let i = nk; i < 4 * (nr + 1); i++) {
    let t = w.slice((i - 1) * 4, i * 4);
    if (i % nk === 0) { t = new Uint8Array([SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]); rcon = xt(rcon); }
    else if (nk > 6 && i % nk === 4) t = t.map(b => SBOX[b]);
    for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - nk) * 4 + j] ^ t[j];
  }
  return { w, nr };
}
function encBlock(ks, inp) {
  const s = inp.slice(), { w, nr } = ks;
  for (let i = 0; i < 16; i++) s[i] ^= w[i];
  for (let r = 1; r <= nr; r++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    const t = s.slice();
    for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) s[c * 4 + rr] = t[((c + rr) % 4) * 4 + rr];
    if (r !== nr) for (let c = 0; c < 4; c++) {
      const a = s.slice(c * 4, c * 4 + 4);
      s[c * 4] = xt(a[0]) ^ xt(a[1]) ^ a[1] ^ a[2] ^ a[3];
      s[c * 4 + 1] = a[0] ^ xt(a[1]) ^ xt(a[2]) ^ a[2] ^ a[3];
      s[c * 4 + 2] = a[0] ^ a[1] ^ xt(a[2]) ^ xt(a[3]) ^ a[3];
      s[c * 4 + 3] = xt(a[0]) ^ a[0] ^ a[1] ^ a[2] ^ xt(a[3]);
    }
    for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i];
  }
  return s;
}
function decBlock(ks, inp) {
  const s = inp.slice(), { w, nr } = ks;
  for (let i = 0; i < 16; i++) s[i] ^= w[nr * 16 + i];
  for (let r = nr - 1; r >= 0; r--) {
    const t = s.slice();
    for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) s[((c + rr) % 4) * 4 + rr] = t[c * 4 + rr];
    for (let i = 0; i < 16; i++) s[i] = INV[s[i]];
    for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i];
    if (r !== 0) for (let c = 0; c < 4; c++) {
      const a = s.slice(c * 4, c * 4 + 4);
      s[c * 4] = mul(a[0], 14) ^ mul(a[1], 11) ^ mul(a[2], 13) ^ mul(a[3], 9);
      s[c * 4 + 1] = mul(a[0], 9) ^ mul(a[1], 14) ^ mul(a[2], 11) ^ mul(a[3], 13);
      s[c * 4 + 2] = mul(a[0], 13) ^ mul(a[1], 9) ^ mul(a[2], 14) ^ mul(a[3], 11);
      s[c * 4 + 3] = mul(a[0], 11) ^ mul(a[1], 13) ^ mul(a[2], 9) ^ mul(a[3], 14);
    }
  }
  return s;
}
// CBC; pad=true für PKCS#7
export function aesCbcEncrypt(key, iv, data, pad = true) {
  const ks = expandKey(key);
  const n = pad ? 16 - (data.length % 16) : 0;
  const src = new Uint8Array(data.length + n); src.set(data); src.fill(n, data.length);
  const out = new Uint8Array(src.length);
  let prev = iv;
  for (let i = 0; i < src.length; i += 16) {
    const b = src.slice(i, i + 16);
    for (let j = 0; j < 16; j++) b[j] ^= prev[j];
    prev = encBlock(ks, b);
    out.set(prev, i);
  }
  return out;
}
export function aesCbcDecrypt(key, iv, data, pad = true) {
  const ks = expandKey(key);
  const len = data.length - (data.length % 16);
  const out = new Uint8Array(len);
  let prev = iv;
  for (let i = 0; i < len; i += 16) {
    const c = data.slice(i, i + 16), p = decBlock(ks, c);
    for (let j = 0; j < 16; j++) out[i + j] = p[j] ^ prev[j];
    prev = c;
  }
  if (!pad || !len) return out;
  const n = out[len - 1];
  return n >= 1 && n <= 16 ? out.slice(0, len - n) : out;
}
// RC4
function rc4(key, data) {
  const s = new Uint8Array(256); for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}
// MD5
function md5(data) {
  const K = new Uint32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  const len = data.length, nb = ((len + 8) >> 6) + 1;
  const m = new Uint8Array(nb * 64); m.set(data); m[len] = 0x80;
  const bits = len * 8; m[nb * 64 - 8] = bits & 255; m[nb * 64 - 7] = (bits >>> 8) & 255; m[nb * 64 - 6] = (bits >>> 16) & 255; m[nb * 64 - 5] = (bits >>> 24) & 255;
  m[nb * 64 - 4] = Math.floor(bits / 2 ** 32) & 255;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const dv = new DataView(m.buffer);
  for (let blk = 0; blk < nb; blk++) {
    const M = (i) => dv.getUint32(blk * 64 + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const tmp = d; d = c; c = b;
      const x = (a + f + K[i] + M(g)) >>> 0, sh = S[(i >> 4) * 4 + (i % 4)];
      b = (b + ((x << sh) | (x >>> (32 - sh)))) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16), ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
  return out;
}
const sha = async (alg, data) => new Uint8Array(await crypto.subtle.digest(alg, data));
const cat = (...arrs) => { const n = arrs.reduce((s, a) => s + a.length, 0), o = new Uint8Array(n); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
const PAD = new Uint8Array([0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A]);
const padPw = (pw) => cat(latin1(pw).slice(0, 32), PAD).slice(0, 32);
const latin1 = (s) => Uint8Array.from([...s].map(c => c.charCodeAt(0) & 0xff));
const utf8pw = (s) => te.encode(s.normalize('NFKC')).slice(0, 127);

// ISO 32000-2, Algorithmus 2.B (R6)
async function hash2B(pw, salt, udata) {
  let K = await sha('SHA-256', cat(pw, salt, udata));
  for (let i = 0; ; i++) {
    const K1 = cat(pw, K, udata);
    const rep = new Uint8Array(K1.length * 64);
    for (let j = 0; j < 64; j++) rep.set(K1, j * K1.length);
    const E = aesCbcEncrypt(K.slice(0, 16), K.slice(16, 32), rep, false);
    let sum = 0; for (let j = 0; j < 16; j++) sum += E[j];
    K = await sha(['SHA-256', 'SHA-384', 'SHA-512'][sum % 3], E);
    if (i >= 63 && E[E.length - 1] <= i - 31) break;
  }
  return K.slice(0, 32);
}

/* ================= Schlüssel aus dem Encrypt-Eintrag ================= */
function num(dict, k, d) { const v = dict.lookup(L().PDFName.of(k)); return v ? v.asNumber() : d; }
function bytesOf(v) { return v ? v.asBytes() : new Uint8Array(0); }

async function fileKey(enc, idFirst, password) {
  const { PDFName } = L();
  const V = num(enc, 'V', 0), R = num(enc, 'R', 2);
  const O = bytesOf(enc.lookup(PDFName.of('O'))), U = bytesOf(enc.lookup(PDFName.of('U')));
  let cfm = V >= 4 ? 'V2' : 'RC4';
  if (V >= 4) {
    const stmf = enc.lookup(PDFName.of('StmF'))?.asString?.() || enc.lookup(PDFName.of('StmF'))?.decodeText?.() || '/StdCF';
    const cf = enc.lookup(PDFName.of('CF'));
    const filt = cf?.lookup(PDFName.of(stmf.replace(/^\//, '')));
    const m = filt?.lookup(PDFName.of('CFM'))?.asString?.();
    cfm = m ? m.replace(/^\//, '') : 'V2';
    if (stmf.replace(/^\//, '') === 'Identity') cfm = 'None';
  }
  if (R >= 5) {
    const pw = utf8pw(password);
    const H = R === 5 ? async (p, s, u) => sha('SHA-256', cat(p, s, u)) : hash2B;
    const OE = bytesOf(enc.lookup(PDFName.of('OE'))), UE = bytesOf(enc.lookup(PDFName.of('UE')));
    const u48 = U.slice(0, 48);
    if (eq(await H(pw, U.slice(32, 40), new Uint8Array(0)), U.slice(0, 32))) {
      return { key: aesCbcDecrypt(await H(pw, U.slice(40, 48), new Uint8Array(0)), new Uint8Array(16), UE, false), aes: 256, V, R };
    }
    if (eq(await H(pw, O.slice(32, 40), u48), O.slice(0, 32))) {
      return { key: aesCbcDecrypt(await H(pw, O.slice(40, 48), u48), new Uint8Array(16), OE, false), aes: 256, V, R };
    }
    return null;
  }
  const n = R === 2 ? 5 : Math.floor(num(enc, 'Length', 40) / 8);
  const P = num(enc, 'P', 0);
  const pBytes = new Uint8Array(4); new DataView(pBytes.buffer).setInt32(0, P, true);
  const encMeta = enc.lookup(PDFName.of('EncryptMetadata'));
  const noMeta = R >= 4 && encMeta && encMeta.asBoolean && encMeta.asBoolean() === false;
  const keyFrom = (pwPadded) => {
    let h = md5(cat(pwPadded, O.slice(0, 32), pBytes, idFirst, noMeta ? new Uint8Array([255, 255, 255, 255]) : new Uint8Array(0)));
    if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h.slice(0, n));
    return h.slice(0, n);
  };
  const checkUser = (key) => {
    if (R === 2) return eq(rc4(key, PAD), U.slice(0, 32));
    let x = md5(cat(PAD, idFirst));
    for (let i = 0; i < 20; i++) x = rc4(key.map(b => b ^ i), x);
    return eq(x.slice(0, 16), U.slice(0, 16));
  };
  const aes = cfm === 'AESV2' ? 128 : 0;
  let key = keyFrom(padPw(password));
  if (checkUser(key)) return { key, aes, rc4: !aes, V, R, n, none: cfm === 'None' };
  // als Besitzer-Passwort versuchen
  let ok = md5(padPw(password));
  if (R >= 3) for (let i = 0; i < 50; i++) ok = md5(ok);
  ok = ok.slice(0, n);
  let upw = O.slice(0, 32);
  if (R === 2) upw = rc4(ok, upw);
  else for (let i = 19; i >= 0; i--) upw = rc4(ok.map(b => b ^ i), upw);
  key = keyFrom(upw);
  if (checkUser(key)) return { key, aes, rc4: !aes, V, R, n, none: cfm === 'None' };
  return null;
}
function objKey(k, num, gen) {
  if (k.aes === 256) return k.key;
  const extra = new Uint8Array([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]);
  const h = md5(cat(k.key, extra, k.aes ? te.encode('sAlT') : new Uint8Array(0)));
  return h.slice(0, Math.min(16, k.key.length + 5));
}
function decryptBytes(k, ref, data) {
  if (k.none || !data.length) return data;
  const key = objKey(k, ref.objectNumber, ref.generationNumber);
  if (k.aes) return data.length < 16 ? new Uint8Array(0) : aesCbcDecrypt(key, data.slice(0, 16), data.slice(16));
  return rc4(key, data);
}

/* ================= Durchlauf über alle Objekte ================= */
function mapStrings(obj, fn) {
  const { PDFDict, PDFArray, PDFString, PDFHexString, PDFRawStream } = L();
  if (obj instanceof PDFString || obj instanceof PDFHexString) return fn(obj);
  if (obj instanceof PDFDict) { for (const [k, v] of obj.entries()) { const n = mapStrings(v, fn); if (n !== v) obj.set(k, n); } return obj; }
  if (obj instanceof PDFArray) { for (let i = 0; i < obj.size(); i++) { const v = obj.get(i), n = mapStrings(v, fn); if (n !== v) obj.set(i, n); } return obj; }
  if (obj instanceof PDFRawStream) { mapStrings(obj.dict, fn); return obj; }
  return obj;
}
const hexOf = (b) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

// Liest Encrypt-Eintrag und ID, ohne Objektströme anzufassen
async function readHeader(bytes) {
  const { PDFDocument, PDFObjectStreamParser, PDFDict, PDFRef } = L();
  const orig = PDFObjectStreamParser.forStream;
  PDFObjectStreamParser.forStream = () => ({ parseIntoContext: async () => {} });
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    const t = doc.context.trailerInfo;
    const encRef = t.Encrypt instanceof PDFRef ? t.Encrypt : null;
    const enc = encRef ? doc.context.lookup(encRef, PDFDict) : t.Encrypt;
    const idArr = t.ID ? doc.context.lookup(t.ID) : null;
    const id0 = idArr ? bytesOf(idArr.lookup ? idArr.lookup(0) : idArr.get(0)) : new Uint8Array(0);
    return { enc, encRef, id0 };
  } finally { PDFObjectStreamParser.forStream = orig; }
}

export async function isEncrypted(bytes) {
  try { return !!(await readHeader(bytes)).enc; } catch { return false; }
}

// Entschlüsselt ein PDF; liefert ungeschützte Bytes oder wirft Error('wrong-password')
export async function removePassword(bytes, password = '') {
  const { PDFDocument, PDFObjectStreamParser, PDFParser, PDFContext, PDFName, PDFRawStream, PDFHexString } = L();
  const head = await readHeader(bytes);
  if (!head.enc) return bytes;
  const k = await fileKey(head.enc, head.id0, password);
  if (!k) throw new Error('wrong-password');
  const origFor = PDFObjectStreamParser.forStream, origHdr = PDFParser.prototype.parseIndirectObjectHeader, origAssign = PDFContext.prototype.assign;
  let cur = null, inObjStm = false;
  const fromObjStm = new Set();
  PDFParser.prototype.parseIndirectObjectHeader = function () { const r = origHdr.call(this); cur = r; return r; };
  PDFObjectStreamParser.forStream = (raw, wait) => {
    raw.contents = decryptBytes(k, cur, raw.contents);
    const p = origFor.call(PDFObjectStreamParser, raw, wait);
    return { parseIntoContext: async () => { inObjStm = true; try { await p.parseIntoContext(); } finally { inObjStm = false; } } };
  };
  PDFContext.prototype.assign = function (ref, obj) { if (inObjStm) fromObjStm.add(ref.tag); return origAssign.call(this, ref, obj); };
  let doc;
  try { doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false }); }
  finally { PDFObjectStreamParser.forStream = origFor; PDFParser.prototype.parseIndirectObjectHeader = origHdr; PDFContext.prototype.assign = origAssign; }
  const ctx = doc.context;
  const encTag = head.encRef?.tag;
  const metaPlain = head.enc.lookup(PDFName.of('EncryptMetadata'))?.asBoolean?.() === false;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (ref.tag === encTag || fromObjStm.has(ref.tag)) continue;
    mapStrings(obj, (s) => PDFHexString.of(hexOf(decryptBytes(k, ref, s.asBytes()))));
    if (obj instanceof PDFRawStream) {
      const type = obj.dict.lookup(PDFName.of('Type'));
      if (type === PDFName.of('XRef')) continue;
      if (metaPlain && type === PDFName.of('Metadata')) continue;
      obj.contents = decryptBytes(k, ref, obj.contents);
    }
  }
  if (head.encRef) ctx.delete(head.encRef);
  ctx.trailerInfo.Encrypt = undefined;
  return doc.save({ useObjectStreams: false });
}

// Schützt ein (ungeschütztes) PDF mit AES-256 (R6)
export async function setPassword(bytes, password) {
  const { PDFDocument, PDFName, PDFHexString, PDFStream, PDFNumber } = L();
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const K = rnd(32);
  const pw = utf8pw(password);
  const uvs = rnd(8), uks = rnd(8), ovs = rnd(8), oks = rnd(8);
  const U = cat(await hash2B(pw, uvs, new Uint8Array(0)), uvs, uks);
  const UE = aesCbcEncrypt(await hash2B(pw, uks, new Uint8Array(0)), new Uint8Array(16), K, false);
  const O = cat(await hash2B(pw, ovs, U), ovs, oks);
  const OE = aesCbcEncrypt(await hash2B(pw, oks, U), new Uint8Array(16), K, false);
  const P = -4; // alles erlaubt (Drucken, Kopieren, Bearbeiten)
  const perms = new Uint8Array(16);
  new DataView(perms.buffer).setInt32(0, P, true);
  perms.set([0xff, 0xff, 0xff, 0xff, 0x54, 0x61, 0x64, 0x62], 4);
  perms.set(rnd(4), 12);
  const Perms = aesCbcEncrypt(K, new Uint8Array(16), perms, false);
  const enc = (data) => { const iv = rnd(16); return cat(iv, aesCbcEncrypt(K, iv, data)); };
  // Alle Strings und Ströme verschlüsseln (vor dem Anlegen des Encrypt-Eintrags)
  for (const [ref, obj] of [...ctx.enumerateIndirectObjects()]) {
    mapStrings(obj, (s) => PDFHexString.of(hexOf(enc(s.asBytes()))));
    if (obj instanceof PDFStream) {
      if (obj.dict.lookup(PDFName.of('Type')) === PDFName.of('XRef')) continue;
      if (typeof obj.updateDict === 'function') obj.updateDict();
      mapStrings(obj.dict, (s) => PDFHexString.of(hexOf(enc(s.asBytes()))));
      ctx.assign(ref, ctx.stream(enc(obj.getContents()), obj.dict));
    }
  }
  const H = (b) => PDFHexString.of(hexOf(b));
  const encDict = ctx.obj({
    Filter: 'Standard', V: 5, R: 6, Length: 256, P: PDFNumber.of(P),
    CF: { StdCF: { AuthEvent: 'DocOpen', CFM: 'AESV3', Length: 32 } }, StmF: 'StdCF', StrF: 'StdCF',
    O: H(O), U: H(U), OE: H(OE), UE: H(UE), Perms: H(Perms), EncryptMetadata: true
  });
  ctx.trailerInfo.Encrypt = ctx.register(encDict);
  const id = H(rnd(16));
  ctx.trailerInfo.ID = ctx.obj([id, id]);
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}
