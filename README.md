# Tavi

**Tavi ist ein PDF-Reader mit KI für Windows und Mac.** Lesen, markieren, ausfüllen, unterschreiben, umwandeln und mit der KI Texte und Bilder erklären lassen.

## Funktionen

- **KI-Assistent:** Texte erklären, zusammenfassen, übersetzen und Fragen zum Dokument stellen. Jede Antwort zeigt die Quelle, ein Klick springt zur genauen Textstelle. Fragen auch über alle offenen PDFs gleichzeitig.
- **KI versteht Bilder:** Diagramme, Tabellen, Fotos und Grafiken erklären lassen, eingescannte Seiten werden automatisch gelesen.
- **Kommentieren:** Textmarker, Unterstreichen, Durchstreichen, Notizen, Stift, Rechteck, Pfeil, Stempel. Gespeichert als normale PDF-Anmerkungen.
- **Ausfüllen & Unterschreiben:** Formularfelder werden automatisch erkannt, „Meine Daten“ mit einem Klick eintragen.
- **Seiten:** löschen, drehen, umsortieren, einfügen, aufteilen, zusammenführen, Bilder zu PDF.
- **Werkzeuge:** Umwandeln in Word, PowerPoint, Excel, JPEG · Texterkennung (OCR) · Verkleinern · echtes Schwärzen · Passwortschutz · Versionen vergleichen.
- **Mehrere Fenster:** Einen Tab aus dem Fenster ziehen, und das PDF öffnet sich in einem eigenen Tavi-Fenster. So liegen zwei Dokumente nebeneinander. Tabs lassen sich auch zwischen Fenstern verschieben.
- **Lesen:** Suchen mit Trefferliste, Seitenleiste mit Vorschau und Inhaltsverzeichnis, Doppelseite, Präsentationsmodus, Vorlesen, Drucken mit mehreren Seiten pro Blatt.
- **Datenschutz:** Alles außer der KI läuft nur auf deinem Rechner. Mit „Vertraulich“ schaltest du die KI für einzelne Dokumente ab.
- Automatische Updates.

## Installieren

**Windows:** Am einfachsten über den Microsoft Store („Tavi PDF“). Oder unter **[Releases](../../releases/latest)** die neueste `Tavi-Setup-….exe` herunterladen und ausführen. Zeigt Windows „Der Computer wurde durch Windows geschützt“, auf **„Weitere Informationen“** und **„Trotzdem ausführen“** klicken.

**Mac:** Unter **[Releases](../../releases/latest)** die passende ZIP-Datei laden: `…-mac-AppleSilicon.zip` für M1–M4, `…-mac-Intel.zip` für ältere Macs. Entpacken und Tavi in „Programme“ ziehen. Beim ersten Start unter Systemeinstellungen → Datenschutz & Sicherheit auf „Dennoch öffnen“ klicken. Meldet macOS „beschädigt“, im Terminal einmal `xattr -cr /Applications/Tavi.app` ausführen.

**KI:** Einen kostenlosen Schlüssel von [Google AI Studio](https://aistudio.google.com/apikey) holen und in Tavi unter ⚙ Einstellungen einfügen. Dein API-Schlüssel und deine Einstellungen bleiben immer nur auf deinem Rechner.

## Entwicklung

Tavi ist eine Electron-App (Electron 38, pdf.js 6).

```
npm install
npm start
```

**Neue Version veröffentlichen:** Version in `package.json` erhöhen, Patch-Notes in `notes/VERSION.md` schreiben, auf `main` pushen. GitHub baut dann Windows- und Mac-Version und legt das Release `v1.4.6` an.

| Ordner/Datei | Inhalt |
|---|---|
| `main.js`, `preload.js` | Hauptprozess: Dateien, Einstellungen, KI-Anfragen, Menü |
| `updater.js` | automatische Updates über die GitHub-Releases |
| `src/` | Oberfläche: `app.js` (Kern), `features.js` (Reiter, Werkzeuge), `annotate.js`, `fill.js`, `forms.js`, `pages.js`, `tools.js` (OCR, Schwärzen, Verkleinern), `pdfcrypt.js` (Passwörter), `vision.js` (Bilder für die KI), `export.js`, `merge.js` |
| `src/vendor/` | mitgelieferte Bibliotheken (pdf-lib, docx, PptxGenJS, JSZip, Tesseract) |
| `build/` | Icons, NSIS-Installer, Skripte für Release (`release.py`), Mac (`mac.py`) und Microsoft Store (`store.py`) |
| `notes/` | Patch-Notes je Version (`1.4.5.md` …), werden zum Text des Releases |
| `.github/workflows/release.yml` | baut und veröffentlicht automatisch, sobald auf `main` eine neue Version in `package.json` steht |

## Lizenz

Tavi steht unter der **[PolyForm Noncommercial License 1.0.0](LICENSE.md)**. Du darfst den Code ansehen, daraus lernen, ihn privat nutzen und für nicht kommerzielle Zwecke anpassen. **Kommerzielle Nutzung ist nicht erlaubt**, also zum Beispiel Verkauf, Einbau in kostenpflichtige Produkte oder Nutzung im Rahmen eines Geschäfts. Für eine kommerzielle Lizenz bitte Kontakt aufnehmen.

Die mitgelieferten Bibliotheken behalten ihre eigenen Lizenzen: pdf.js und Tesseract (Apache 2.0), pdf-lib, docx, PptxGenJS, JSZip (jeweils MIT). Lizenztexte liegen in `src/vendor/`.
