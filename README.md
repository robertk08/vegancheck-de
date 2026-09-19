# VeganCheck

Barcode scannen und sofort sehen, ob ein Produkt **vegan** ist – und wenn nicht, ob es
wenigstens **vegetarisch** ist. Mehr macht die App bewusst nicht.

**Live:** https://robertk08.github.io/vegancheck-de/

## Wie es funktioniert

1. Kamera öffnen, Strichcode ins Bild halten (oder die EAN eintippen).
2. Die Nummer wird bei [Open Food Facts](https://de.openfoodfacts.org) nachgeschlagen.
3. Ergebnis in vier Stufen:

| Ergebnis | Bedeutung |
| --- | --- |
| **Vegan** | Vegan-Siegel bzw. alle Zutaten pflanzlich |
| **Nicht vegan, aber vegetarisch** | z. B. Milch, Ei, Honig – mit Nennung der Zutat |
| **Nicht vegan und nicht vegetarisch** | Fleisch, Fisch, Gelatine, Schmalz … |
| **Unklar** | Zutaten wie „Aroma“ oder „Mono- und Diglyceride“ sind nicht eindeutig, oder es fehlt eine Zutatenliste |

Unter „Alle Daten“ stehen zusätzlich die Nährwerte je 100 g (Energie in kcal, Fett,
gesättigte Fettsäuren, Kohlenhydrate, Zucker, Ballaststoffe, Eiweiß, Salz) und die
vollständige Zutatenliste.

Siegel schlagen die automatische Zutatenanalyse: Ist ein Produkt als vegan gekennzeichnet,
gilt das als verlässlicher als die Auswertung des Zutatentexts.

## Technik

Reine statische Seite, kein Backend, kein Build-Schritt, keine Tracker.

- **Scanner:** `BarcodeDetector` des Browsers, wo vorhanden (Chrome/Android);
  sonst [ZXing](https://github.com/zxing-js/library) als Fallback, lokal eingebunden
  und erst bei Bedarf nachgeladen. Formate: EAN-13, EAN-8, UPC-A, UPC-E, Code 128.
- **Jede Ausrichtung:** zeilenweise Leser sehen nur ungefähr waagerechte Codes.
  Die Scanschleife legt den Frame deshalb reihum in vier Lagen vor – 0°, 90°, 45°,
  135° – und deckt mit der Toleranz von rund ±20° je Lage den vollen Kreis ab.
- **Daten:** Open Food Facts API v2 (`lc=de&cc=de`), direkt aus dem Browser.
  Ergebnisse werden 7 Tage lokal zwischengespeichert.
- **PWA:** installierbar, App-Hülle funktioniert offline (Produktabfragen brauchen Netz).
  Der Service Worker geht zuerst ans Netz und nutzt den Cache nur als Rückfall, damit
  Aktualisierungen sofort ankommen.
- **Privatsphäre:** keine Analyse, keine Cookies, keine Server. Verlauf und Cache liegen
  nur im `localStorage` des Geräts.

| Datei | Zweck |
| --- | --- |
| `index.html` | Seitengerüst |
| `app.js` | Scanner, Abfrage, Einstufung, Verlauf |
| `styles.css` | Gestaltung inkl. Dunkelmodus |
| `sw.js`, `manifest.webmanifest` | PWA und Offline-Hülle |
| `vendor/` | ZXing (Apache-2.0), lokal eingebunden |

## Lokal starten

```sh
python3 -m http.server 8000
# http://localhost:8000
```

Die Kamera braucht `localhost` oder HTTPS.

## Hinweise

- Angaben ohne Gewähr: Rezepturen ändern sich, Datenbankeinträge können falsch oder
  unvollständig sein. Im Zweifel die Verpackung lesen.
- Produktdaten stehen unter der [ODbL](https://opendatacommons.org/licenses/odbl/) von
  Open Food Facts; fehlende Produkte lassen sich dort direkt ergänzen.
- Vor einem kommerziellen Betrieb in Deutschland gehört noch ein Impressum
  (§ 5 DDG) und eine Datenschutzerklärung auf die Seite.
