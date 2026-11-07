#!/usr/bin/env python3
"""Baut ein komplettes Tavi-Release: Windows-Programmordner, Installer, App-Paket und latest.json.
Aufruf: release.py VERSION "Hinweise zur Version" """
import base64, gzip, hashlib, io, json, os, shutil, struct, subprocess, sys, zipfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'py', 'pefile-2024.8.26'))
import pefile
from PIL import Image

B = os.path.dirname(os.path.abspath(__file__))
SRC = '/home/claude/lesepult'
PDFJS = '/opt/npm-tools/node_modules/pdfjs-dist'
ELECTRON = '38.0.0'
ver, notes = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else '')
pkg = json.load(open(f'{SRC}/package.json'))
assert pkg['version'] == ver, f"package.json hat {pkg['version']}, erwartet {ver}"
pdfjs_ver = json.load(open(f'{PDFJS}/package.json'))['version']
out = f'{B}/release-{ver}'
shutil.rmtree(out, ignore_errors=True); os.makedirs(out)

# 1) Programmordner
win = f'{B}/win'
shutil.rmtree(win, ignore_errors=True); os.makedirs(win)
with zipfile.ZipFile(f'{B}/dl/electron-win.zip') as z: z.extractall(win)
os.rename(f'{win}/electron.exe', f'{win}/Tavi.exe')
os.remove(f'{win}/resources/default_app.asar')
for f in os.listdir(f'{win}/locales'):
    if f not in ('de.pak', 'en-US.pak'): os.remove(f'{win}/locales/{f}')
app = f'{win}/resources/app'
APP_FILES = ['main.js', 'preload.js', 'updater.js', 'package.json']
os.makedirs(app)
for f in APP_FILES: shutil.copy(f'{SRC}/{f}', app)
shutil.copytree(f'{SRC}/src', f'{app}/src')
d = f'{app}/node_modules/pdfjs-dist'
os.makedirs(f'{d}/legacy/build'); os.makedirs(f'{d}/web')
for f in ('package.json', 'LICENSE'): shutil.copy(f'{PDFJS}/{f}', d)
for f in ('pdf.mjs', 'pdf.worker.mjs'): shutil.copy(f'{PDFJS}/legacy/build/{f}', f'{d}/legacy/build')
for f in ('cmaps', 'standard_fonts', 'wasm', 'iccs'): shutil.copytree(f'{PDFJS}/{f}', f'{d}/{f}')
shutil.copy(f'{PDFJS}/web/pdf_viewer.css', f'{d}/web'); shutil.copytree(f'{PDFJS}/web/images', f'{d}/web/images')

# 2) Icon und Name in Lesepult.exe
exe = f'{win}/Tavi.exe'
raw = bytearray(open(exe, 'rb').read())
pe = pefile.PE(data=bytes(raw))
icon = Image.open(f'{SRC}/build/icon.png').convert('RGBA')
off = pe.get_offset_from_rva
icons, group, verres = {}, None, None
for t in pe.DIRECTORY_ENTRY_RESOURCE.entries:
    if t.id == 3:
        for e in t.directory.entries: icons[e.id] = e.directory.entries[0].data.struct
    if t.id == 14: group = t.directory.entries[0].directory.entries[0].data.struct
    if t.id == 16: verres = t.directory.entries[0].directory.entries[0].data.struct
def dib(img):
    w, h = img.size; px = img.load(); xor = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[x, y]; xor += bytes((b, g, r, a))
    andm = bytes(((w + 31) // 32) * 4 * h)
    return struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, len(xor) + len(andm), 0, 0, 0, 0) + bytes(xor) + andm
go = off(group.OffsetToData)
for i in range(struct.unpack_from('<H', raw, go + 4)[0]):
    eo = go + 6 + i * 14
    w, h, _, _, _, _, _, iid = struct.unpack_from('<BBBBHHIH', raw, eo)
    w, h = w or 256, h or 256
    st = icons[iid]; do = off(st.OffsetToData)
    img = icon.resize((w, h), Image.LANCZOS)
    if raw[do:do + 8] == b'\x89PNG\r\n\x1a\n':
        bio = io.BytesIO(); img.save(bio, 'PNG', optimize=True); new = bio.getvalue()
    else: new = dib(img)
    assert len(new) <= st.Size
    raw[do:do + st.Size] = new + bytes(st.Size - len(new))
    struct.pack_into('<I', raw, st.get_file_offset() + 4, len(new)); struct.pack_into('<I', raw, eo + 8, len(new))
vo = off(verres.OffsetToData); vb = raw[vo:vo + verres.Size]
def sub(a, b):
    A, Bb = a.encode('utf-16-le'), b.encode('utf-16-le'); assert len(A) == len(Bb), (a, b)
    i = vb.find(A)
    while i >= 0: vb[i:i + len(A)] = Bb; i = vb.find(A, i + len(A))
sub('Electron', 'Tavi\0\0\0\0'); sub('electron.exe', 'Tavi.exe\0\0\0\0'); sub(ELECTRON, ver.ljust(len(ELECTRON), '\0')[:len(ELECTRON)])
sub('GitHub, Inc.', 'Tavi\0\0\0\0\0\0\0\0'); sub('Copyright (C) 2015 Tavi', 'Copyright (C) 2026 Tavi')
mj, mi, pa = (list(map(int, ver.split('.'))) + [0, 0, 0])[:3]
i = vb.find(struct.pack('<I', 0xFEEF04BD)); struct.pack_into('<IIII', vb, i + 8, mj << 16 | mi, pa << 16, mj << 16 | mi, pa << 16)
raw[vo:vo + verres.Size] = vb
open(exe, 'wb').write(raw)

# 3) Installer
shutil.copy(f'{SRC}/build/icon.ico', f'{B}/icon.ico')
subprocess.run([f'{B}/nsis/linux/makensis', '-V2', f'-DVER={ver}', 'tavi.nsi'], cwd=B, check=True, env={**os.environ, 'NSISDIR': f'{B}/nsis'})
setup = f'Tavi-Setup-{ver}.exe'
shutil.move(f'{B}/{setup}', f'{out}/{setup}')

# 4) App-Paket (nur Programmcode)
files = {}
for f in APP_FILES: files[f] = base64.b64encode(open(f'{SRC}/{f}', 'rb').read()).decode()
for dp, _, fns in os.walk(f'{SRC}/src'):
    for fn in fns:
        full = os.path.join(dp, fn); rel = os.path.relpath(full, SRC).replace(os.sep, '/')
        files[rel] = base64.b64encode(open(full, 'rb').read()).decode()
apppkg = f'tavi-app-{ver}.json.gz'
open(f'{out}/{apppkg}', 'wb').write(gzip.compress(json.dumps(files).encode(), 9))

# 5) latest.json
def meta(name):
    data = open(f'{out}/{name}', 'rb').read()
    return {'file': name, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
latest = {'version': ver, 'tag': f'v{ver}', 'notes': notes, 'electron': ELECTRON, 'pdfjs': pdfjs_ver,
          'app': meta(apppkg), 'installer': meta(setup)}
json.dump(latest, open(f'{out}/latest.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print(json.dumps(latest, ensure_ascii=False, indent=2))
