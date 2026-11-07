// „Meine Daten“: Felder, Zuordnung zu Formular-Beschriftungen (ohne KI, nur Regeln) und der Dialog dazu.

export const PROFILE_FIELDS = [
  { key: 'anrede', label: 'Anrede', ph: 'Frau / Herr' },
  { key: 'titel', label: 'Titel', ph: 'z. B. Dr.' },
  { key: 'vorname', label: 'Vorname' },
  { key: 'nachname', label: 'Nachname' },
  { key: 'geburtsdatum', label: 'Geburtsdatum', ph: 'TT.MM.JJJJ' },
  { key: 'geburtsort', label: 'Geburtsort' },
  { key: 'strasse', label: 'Straße und Hausnummer', wide: true },
  { key: 'plz', label: 'PLZ' },
  { key: 'ort', label: 'Ort' },
  { key: 'land', label: 'Land' },
  { key: 'telefon', label: 'Telefon' },
  { key: 'mobil', label: 'Mobil' },
  { key: 'email', label: 'E-Mail', wide: true },
  { key: 'beruf', label: 'Beruf' },
  { key: 'staatsangehoerigkeit', label: 'Staatsangehörigkeit' },
  { key: 'kontoinhaber', label: 'Kontoinhaber', wide: true },
  { key: 'iban', label: 'IBAN', wide: true },
  { key: 'bic', label: 'BIC' },
  { key: 'bank', label: 'Bank' }
];

const today = () => new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const join = (...parts) => parts.filter(Boolean).join(' ').trim();

// Reihenfolge ist wichtig: Spezielle Beschriftungen zuerst
const RULES = [
  [/unterschrift|signatur/, () => ''],
  [/ort\s*[,/und&]+\s*datum|datum\s*[,/und&]+\s*ort/, (p) => (p.ort ? `${p.ort}, ${today()}` : '')],
  [/e-?mail|mail/, (p) => p.email],
  [/iban/, (p) => p.iban],
  [/bic|swift/, (p) => p.bic],
  [/kontoinhaber|account holder/, (p) => p.kontoinhaber || join(p.vorname, p.nachname)],
  [/kreditinstitut|geldinstitut|\bbank\b|bankname/, (p) => p.bank],
  [/geburtsdatum|geb\.?\s*-?datum|geboren am|date of birth|geburtstag/, (p) => p.geburtsdatum],
  [/geburtsort|geboren in|place of birth/, (p) => p.geburtsort],
  [/staatsangeh|nationalit/, (p) => p.staatsangehoerigkeit],
  [/beruf|t[äa]tigkeit|occupation/, (p) => p.beruf],
  [/anrede|salutation/, (p) => p.anrede],
  [/^titel$|akad.*grad/, (p) => p.titel],
  [/mobil|handy|cell/, (p) => p.mobil || p.telefon],
  [/telefon|^tel\b|phone|rufnummer/, (p) => p.telefon || p.mobil],
  [/plz\s*[,/]?\s*(wohn)?ort|postleitzahl\s*[,/und]+\s*ort/, (p) => join(p.plz, p.ort)],
  [/postleitzahl|^plz$/, (p) => p.plz],
  [/stra(ß|ss)e|hausnummer|anschrift|adresse|address/, (p) => p.strasse],
  [/^(wohn)?ort$|^stadt$|^city$|^wohnort/, (p) => p.ort],
  [/^land$|^country$|staat$/, (p) => p.land],
  [/^name\s*,\s*vorname|nachname\s*,\s*vorname/, (p) => (p.nachname && p.vorname ? `${p.nachname}, ${p.vorname}` : '')],
  [/vorname|rufname|first name|given name/, (p) => p.vorname],
  [/vor-?\s*und\s*(nach|zu)name|^name$|vollst[äa]ndiger name|full name|^ihr name/, (p) => join(p.titel, p.vorname, p.nachname)],
  [/nachname|familienname|zuname|last name|surname/, (p) => p.nachname]
];

export function valueFor(label, profile) {
  const l = String(label || '').toLowerCase().replace(/[:*_.]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!l) return '';
  for (const [re, fn] of RULES) if (re.test(l)) return fn(profile) || '';
  return '';
}

// Dialog zum Bearbeiten
export function initProfileDialog({ api, toast }) {
  const $ = (id) => document.getElementById(id);
  const dlg = $('profileDlg');
  const grid = $('profileGrid');
  grid.replaceChildren(...PROFILE_FIELDS.map(f => {
    const l = document.createElement('label');
    l.className = 'pf' + (f.wide ? ' wide' : '');
    l.innerHTML = '<span></span><input type="text" autocomplete="off" spellcheck="false">';
    l.querySelector('span').textContent = f.label;
    const i = l.querySelector('input');
    i.name = f.key;
    if (f.ph) i.placeholder = f.ph;
    return l;
  }));
  async function open() {
    const p = await api.profile.get().catch(() => ({}));
    grid.querySelectorAll('input').forEach(i => { i.value = p[i.name] || ''; });
    dlg.showModal();
  }
  $('profileSave').onclick = async () => {
    const data = {};
    grid.querySelectorAll('input').forEach(i => { if (i.value.trim()) data[i.name] = i.value.trim(); });
    if (data.iban) data.iban = data.iban.toUpperCase().replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
    await api.profile.set(data);
    dlg.close();
    toast(Object.keys(data).length ? 'Meine Daten gespeichert. Beim Ausfüllen trägst du sie mit einem Klick ein.' : 'Meine Daten gelöscht.');
  };
  $('profileClear').onclick = () => { grid.querySelectorAll('input').forEach(i => { i.value = ''; }); };
  $('profileCancel').onclick = () => dlg.close();
  return { open };
}
