#!/usr/bin/env python3
"""Baut Tavi für macOS (Apple Silicon und Intel) aus dem Programmordner von release.py.
Aufruf: mac.py BAU_ORDNER   (release.py muss für dieselbe Version vorher gelaufen sein)
Ergebnis: BAU/mac-VERSION/Tavi-VERSION-mac-AppleSilicon.zip und ...-mac-Intel.zip"""
import json, os, plistlib, shutil, subprocess, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)
B = sys.argv[1]
RCODESIGN = os.environ.get('RCODESIGN', '/home/claude/ext/rcs/apple-codesign-0.29.0-x86_64-unknown-linux-musl/rcodesign')
ver = json.load(open(f'{SRC}/package.json'))['version']
app_src = f'{B}/win/resources/app'
assert json.load(open(f'{app_src}/package.json'))['version'] == ver, 'Erst release.py für diese Version laufen lassen.'
out = f'{B}/mac-{ver}'
shutil.rmtree(out, ignore_errors=True); os.makedirs(out)

# Symbol (.icns) aus dem großen Logo
icns = f'{out}/tavi.icns'
Image.open(f'{SRC}/build/icon-1024.png').convert('RGBA').save(icns, sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])

for arch, label in (('arm64', 'AppleSilicon'), ('x64', 'Intel')):
    stage = f'{out}/{arch}'
    os.makedirs(stage)
    # unzip erhält die Symlinks in den Frameworks
    subprocess.run(['unzip', '-q', f'{B}/dl/electron-darwin-{arch}.zip', '-d', stage], check=True)
    appdir = f'{stage}/Tavi.app'
    os.rename(f'{stage}/Electron.app', appdir)
    res = f'{appdir}/Contents/Resources'
    if os.path.exists(f'{res}/default_app.asar'): os.remove(f'{res}/default_app.asar')
    shutil.copytree(app_src, f'{res}/app', symlinks=False)
    shutil.copy(icns, f'{res}/tavi.icns')
    if os.path.exists(f'{res}/electron.icns'): os.remove(f'{res}/electron.icns')
    # Info.plist anpassen
    pl = f'{appdir}/Contents/Info.plist'
    with open(pl, 'rb') as f: info = plistlib.load(f)
    info.pop('ElectronAsarIntegrity', None)
    info.update({
        'CFBundleName': 'Tavi', 'CFBundleDisplayName': 'Tavi', 'CFBundleIdentifier': 'de.tavi.app',
        'CFBundleIconFile': 'tavi.icns', 'CFBundleShortVersionString': ver, 'CFBundleVersion': ver,
        'NSHumanReadableCopyright': 'Tavi', 'LSApplicationCategoryType': 'public.app-category.productivity',
        'NSHighResolutionCapable': True, 'LSMinimumSystemVersion': info.get('LSMinimumSystemVersion', '12.0'),
        'CFBundleDocumentTypes': [{
            'CFBundleTypeName': 'PDF-Dokument', 'CFBundleTypeRole': 'Viewer', 'LSHandlerRank': 'Alternate',
            'LSItemContentTypes': ['com.adobe.pdf'], 'CFBundleTypeExtensions': ['pdf']
        }],
        'NSMicrophoneUsageDescription': 'Tavi benötigt das Mikrofon nicht.',
        'NSCameraUsageDescription': 'Tavi benötigt die Kamera nicht.'
    })
    with open(pl, 'wb') as f: plistlib.dump(info, f)
    # Ad-hoc signieren (ohne Apple-Entwicklerkonto), damit macOS die App auf Apple Silicon startet
    r = subprocess.run([RCODESIGN, 'sign', appdir], capture_output=True, text=True)
    if r.returncode: print(r.stdout[-2000:], r.stderr[-2000:]); raise SystemExit('Signieren fehlgeschlagen')
    z = f'{out}/Tavi-{ver}-mac-{label}.zip'
    subprocess.run(['zip', '-qry', '-X', z, 'Tavi.app'], cwd=stage, check=True)
    print(z, os.path.getsize(z))
