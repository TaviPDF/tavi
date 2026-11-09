# Tavi – Arbeitsanleitung für neue Chats

Tavi ist ein PDF-Reader mit KI für Windows und Mac (Electron). Das Repo `TaviPDF/tavi` ist die einzige Quelle: Alles, was nicht hier liegt, gibt es nicht mehr.
Der Inhaber spricht Deutsch, ist kein Programmierer und möchte fertige Ergebnisse, kurz erklärt. Oberfläche, Texte, Commits und Patch-Notes auf Deutsch.

## Grundsätze (vom Inhaber festgelegt)

- **Datenschutz zuerst:** Dokumente der Nutzer bleiben vertraulich. Außer der KI läuft alles lokal. Der Schalter „Vertraulich“ sperrt die KI pro Dokument; neue KI-Funktionen müssen ihn beachten. API-Schlüssel nur lokal, verschlüsselt per `safeStorage`.
- **Lizenz:** PolyForm Noncommercial 1.0.0 – nie kommerziell nutzbar machen, Lizenz nicht ändern.
- **Viel Leseplatz:** Die Menüleiste (Ribbon) ist standardmäßig zugeklappt, schlanke Werkzeugleiste.
- **Logo/Farben:** Navy `#1E2A5A`, weißes „t“, Mint `#6EE7C8`.
- **Keine Inhalte Dritter:** Für Screenshots oder Store-Bilder nur selbst erzeugte Beispiel-PDFs verwenden (nie Material aus Vorlesungen – urheberrechtlich geschützt).
- Jede Version bekommt Patch-Notes.

## Aufbau

| Datei | Inhalt |
|---|---|
| `main.js` | Hauptprozess: Fenster (mehrere möglich), Dateien, Einstellungen, KI-Anfragen (Gemini, Groq), Menü, Drucken, Tabs zwischen Fenstern |
| `preload.js` | `window.api` – einzige Brücke zur Oberfläche (contextIsolation, sandbox) |
| `updater.js` | Auto-Update über GitHub-Releases (`latest.json`), Store-Modus ohne Selbst-Update, Mac: Hinweis zum manuellen Laden |
| `src/app.js` | Kern der Oberfläche: Tabs, Öffnen/Speichern, Anzeige (pdf.js), KI-Chat mit Quellenangaben, Bilder für die KI |
| `src/features.js` | Ribbon-Reiter, Ansichten, Präsentation, Seiten-Werkzeuge, OCR, Verkleinern, Schwärzen, Passwort, Vergleichen, Vorlesen |
| `src/annotate.js` | Markieren, Unterstreichen, Notizen, Stift, Formen, Stempel, Schwärzen-Auswahl → echte PDF-Anmerkungen |
| `src/fill.js`, `forms.js`, `profile.js` | Formulare ausfüllen, Unterschrift, „Meine Daten“ |
| `src/tools.js` | OCR (Tesseract im Worker `ocr-worker.js`), Schwärzen, Verkleinern, Seitenoperationen, Textvergleich |
| `src/pdfcrypt.js` | PDF-Passwörter setzen (AES-256) und entfernen (R2–R6) |
| `src/vision.js`, `geom.js` | Seiten/Ausschnitte als Bild für die KI, Koordinaten bei gedrehten Seiten |
| `src/export.js`, `merge.js`, `pages.js` | Umwandeln (Word, PowerPoint, Excel, JPEG), Zusammenführen, Seiten |
| `src/vendor/` | mitgelieferte Bibliotheken (pdf-lib, docx, PptxGenJS, JSZip, Tesseract) |
| `build/` | `release.py` (Windows + Update-Dateien), `mac.py`, `store.py` + `store.json` (Store-Identität), `tavi.nsi` (Installer), Icons |
| `notes/VERSION.md` | Patch-Notes je Version → Text des Releases und des Update-Fensters |

Technik: Electron 38.0.0, pdfjs-dist 6.2.108 (Legacy-Build), eigenes Protokoll `app://tavi`. Fenster ab dem zweiten laden `index.html?fenster=2` (stellen keine Sitzung wieder her).

## Neue Version veröffentlichen

1. Änderungen machen und testen (siehe unten).
2. `version` in `package.json` erhöhen (z. B. 1.4.6).
3. `notes/1.4.6.md` schreiben (Vorlage: vorige Datei; Überschriften `##`, Aufzählungen `-`).
4. Commit auf `main` pushen (Commit-Autor: `Claude <noreply@anthropic.com>`).
5. GitHub Actions (`.github/workflows/release.yml`) baut dann automatisch in ~6 Minuten:
   Windows-Installer, Update-Paket, `latest.json`, Mac-ZIPs (Apple Silicon, Intel, ad-hoc signiert) und das Store-Paket `Tavi-VERSION.msix`, und veröffentlicht das Release `vVERSION`.
   Tags kann diese Sitzungsart nicht pushen – der Workflow legt den Tag selbst an. Manuell starten: `gh api -X POST repos/TaviPDF/tavi/actions/workflows/release.yml/dispatches -f ref=main`.
   Status: `gh api repos/TaviPDF/tavi/actions/runs --jq '.workflow_runs[0]|{status,conclusion,id}'`.
6. Der Inhaber lädt nur noch die `.msix` aus dem Release im Microsoft Partner Center hoch (App „Tavi PDF“, Herausgeber „Tavi Software“).

Releases selbst anlegen oder Dateien hochladen geht aus Claude-Sitzungen nicht (403) – immer über den Workflow.

## Testen

- Syntax: `node --check main.js preload.js updater.js`.
- Oberfläche im Browser: `src/` über einen lokalen Server ausliefern, `node_modules/pdfjs-dist` bereitstellen, `window.api` per Playwright mocken.
- Echt mit Electron (auch mehrere Fenster): Electron 38.0.0 für Linux von den GitHub-Releases laden, mit `xvfb-run` und Playwright `_electron.launch({ executablePath, args: [repo, '--no-sandbox', '--user-data-dir=…'] })` starten. Umgebungsvariable `NODE_OPTIONS` vorher entfernen. PDFs per `webContents.send('open-file', {data, name, path})` öffnen.
- GitHub-Downloads sind manchmal kurz gestört (502/504) – einfach wiederholen.

## Stolperfallen (schon einmal passiert)

- **Callbacks über die Brücke:** Funktionen, die an `window.api.on…` übergeben werden, dürfen nichts zurückgeben (`(x) => { tuWas(x); }`). Sonst kopiert Electron den Rückgabewert (z. B. ein PDF-Objekt) über die Brücke und die Oberfläche hängt.
- **pdf.js-Textebene:** `.page` braucht `--scale-round-x/y: 1px` und `--total-scale-factor`, sonst sitzt markierbarer Text bei gedrehten Seiten (/Rotate 90) daneben.
- **Annotationen mit pdf-lib:** `lookupMaybe` statt `lookup` verwenden; Auswahl beim `mouseup` sofort festhalten.
- **OCR:** geladene Sprachen selbst merken (kein `FS.analyzePath`).
- **Puffer an Worker übergeben** (transfer) macht sie leer – Größen vorher merken.
- **Store (MSIX):** Bilder ohne Skalierungs-Suffix benennen; `runFullTrust`-Begründung im Partner Center unter ~500 Zeichen.
- **rcodesign** liest alle Umgebungsvariablen `RCODESIGN_*` als eigene Einstellungen – keine solchen Variablen anlegen.
- **Dateien nicht mit `open(A,'w').write(open(A).read())`** bearbeiten – leert die Datei. Edit-Werkzeug verwenden.
- Mac ohne Apple-Entwicklerkonto: Gatekeeper meldet „beschädigt“ → `xattr -cr /Applications/Tavi.app`. Abhilfe wäre das Apple Developer Program (99 €/Jahr).

## Offene Ideen (noch nicht beauftragt)

- Podcast aus einem Dokument: KI schreibt Dialog, Gemini-TTS mit zwei Sprechern, Abspielen und als MP3 speichern.
- Ollama als dritter KI-Anbieter (lokal, ideal für vertrauliche Dokumente).
- Mac-Signierskript für ein späteres Apple-Entwicklerkonto.
- Englische Store-Beschreibung.
