#!/usr/bin/env python3
"""Baut das Microsoft-Store-Paket (MSIX) aus dem Windows-Programmordner von release.py.
Aufruf: store.py   (Werte aus build/store.json, die Partner Center vorgibt)"""
import json, os, shutil, subprocess, sys
from xml.sax.saxutils import escape
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)
B = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('TAVI_BAU', '')
MAKEMSIX = os.environ.get('MAKEMSIX', '/home/claude/microsoft/msix-packaging/.vs/bin/makemsix')

pkg = json.load(open(f'{SRC}/package.json'))
cfg = json.load(open(f'{HERE}/store.json'))
ver = pkg['version'] + '.0'          # Store verlangt vier Stellen, die letzte muss 0 sein

win = f'{B}/win'
assert os.path.exists(f'{win}/Tavi.exe'), 'Erst release.py laufen lassen.'
stage = f'{B}/msix'
shutil.rmtree(stage, ignore_errors=True)
shutil.copytree(win, stage)
# aktuelle App-Dateien übernehmen
app = f'{stage}/resources/app'
for f in ['main.js', 'preload.js', 'updater.js', 'package.json']: shutil.copy(f'{SRC}/{f}', app)
shutil.rmtree(f'{app}/src'); shutil.copytree(f'{SRC}/src', f'{app}/src')

# Kacheln und Logos
os.makedirs(f'{stage}/assets')
icon = Image.open(f'{SRC}/build/icon-1024.png').convert('RGBA')
NAVY = (30, 42, 90, 255)
def square(name, size, pad=0.0):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    inner = round(size * (1 - 2 * pad))
    img.alpha_composite(icon.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2,) * 2)
    img.save(f'{stage}/assets/{name}')
def wide(name, w, h):
    img = Image.new('RGBA', (w, h), NAVY)
    s = round(h * 0.7)
    img.alpha_composite(icon.resize((s, s), Image.LANCZOS), ((w - s) // 2, (h - s) // 2))
    img.save(f'{stage}/assets/{name}')
# Ohne resources.pri findet der Store nur die einfachen Dateinamen, daher genau diese
square('StoreLogo.png', 50)
square('Square44x44Logo.png', 44)
square('Square150x150Logo.png', 150, 0.15)
square('Square71x71Logo.png', 71, 0.1)
wide('Wide310x150Logo.png', 310, 150)

e = lambda k: escape(cfg[k], {'"': '&quot;'})
manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity Name="{e('identityName')}" Publisher="{e('publisher')}" Version="{ver}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>{e('displayName')}</DisplayName>
    <PublisherDisplayName>{e('publisherDisplayName')}</PublisherDisplayName>
    <Logo>assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="de-DE" />
  </Resources>
  <Applications>
    <Application Id="Tavi" Executable="Tavi.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="{e('displayName')}" Description="PDF-Reader mit KI-Assistent"
        BackgroundColor="transparent" Square150x150Logo="assets\\Square150x150Logo.png" Square44x44Logo="assets\\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="assets\\Wide310x150Logo.png" Square71x71Logo="assets\\Square71x71Logo.png" ShortName="Tavi">
          <uap:ShowNameOnTiles><uap:ShowOn Tile="square150x150Logo" /><uap:ShowOn Tile="wide310x150Logo" /></uap:ShowNameOnTiles>
        </uap:DefaultTile>
      </uap:VisualElements>
      <Extensions>
        <uap:Extension Category="windows.fileTypeAssociation">
          <uap:FileTypeAssociation Name="pdf">
            <uap:DisplayName>PDF-Dokument</uap:DisplayName>
            <uap:Logo>assets\\Square44x44Logo.png</uap:Logo>
            <uap:SupportedFileTypes><uap:FileType ContentType="application/pdf">.pdf</uap:FileType></uap:SupportedFileTypes>
          </uap:FileTypeAssociation>
        </uap:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Capabilities>
    <Capability Name="internetClient" />
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
'''
open(f'{stage}/AppxManifest.xml', 'w', encoding='utf-8').write(manifest)

out = f'{B}/store-{pkg["version"]}'
os.makedirs(out, exist_ok=True)
target = f'{out}/Tavi-{pkg["version"]}.msix'
if os.path.exists(target): os.remove(target)
env = dict(os.environ, LD_LIBRARY_PATH=os.path.join(os.path.dirname(os.path.dirname(MAKEMSIX)), 'lib'))
subprocess.run([MAKEMSIX, 'pack', '-d', stage, '-p', target], check=True, env=env)
print(target, os.path.getsize(target))
