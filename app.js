/* VeganCheck – Barcode scannen, Ergebnis: vegan / vegetarisch / keins von beidem.
   Daten: Open Food Facts (ODbL). Läuft vollständig im Browser. */
'use strict';

const API = 'https://world.openfoodfacts.org/api/v2/product/';
const FIELDS = [
  'code', 'product_name', 'product_name_de', 'brands', 'quantity',
  'image_front_small_url', 'image_small_url',
  'labels_tags', 'ingredients_analysis_tags', 'ingredients',
  'ingredients_text_de', 'ingredients_text',
  'nutriments', 'nutrition_data_per', 'serving_size'
].join(',');
const HISTORY_KEY = 'vc.history.v1';
const CACHE_KEY = 'vc.products.v2';
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

const $ = (sel) => document.querySelector(sel);
const els = {
  video: $('#video'), camHint: $('#cam-hint'), btnScan: $('#btn-scan'),
  btnTorch: $('#btn-torch'),
  form: $('#manual-form'), input: $('#manual-code'), result: $('#result'),
  history: $('#history'), historyWrap: $('#history-wrap'),
  dialog: $('#info-dialog'), btnInfo: $('#btn-info'), btnCloseInfo: $('#btn-close-info')
};

/* ---------------------------------------------------------------- Einstufung */

const GLYPHS = {
  check: '<path d="M4.8 12.9 9.6 17.7 19.2 6.9"/>',
  bang:  '<path d="M12 5.4v8.2"/><circle cx="12" cy="18.1" r="1.35" class="fill"/>',
  cross: '<path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6"/>',
  query: '<path d="M8.7 8.9a3.4 3.4 0 1 1 4.4 3.9c-.8.3-1.2 1-1.2 1.9v.5"/>'
         + '<circle cx="12" cy="18.4" r="1.35" class="fill"/>'
};

const VERDICTS = {
  vegan: {
    key: 'vegan', cls: 'v-vegan', glyph: GLYPHS.check,
    title: 'Vegan', sub: ''
  },
  vegetarian: {
    key: 'vegetarian', cls: 'v-vegetarian', glyph: GLYPHS.bang,
    title: 'Vegetarisch', sub: 'Nicht vegan'
  },
  no: {
    key: 'no', cls: 'v-no', glyph: GLYPHS.cross,
    title: 'Nicht vegetarisch', sub: 'Auch nicht vegan'
  },
  unknown: {
    key: 'unknown', cls: 'v-unknown', glyph: GLYPHS.query,
    title: 'Unklar', sub: 'Zutaten nicht eindeutig'
  }
};

const glyphMarkup = (paths) =>
  `<div class="glyph"><svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg></div>`;

const has = (list, tag) => Array.isArray(list) && list.includes(tag);

/** Flache Liste aller (auch verschachtelten) Zutaten. */
function flatten(ingredients, out = []) {
  if (!Array.isArray(ingredients)) return out;
  for (const ing of ingredients) {
    out.push(ing);
    if (ing.ingredients) flatten(ing.ingredients, out);
  }
  return out;
}

/** Zutaten mit einem bestimmten Status ('no' | 'maybe'), ohne Dubletten. */
function ingredientsWith(product, field, status) {
  const seen = new Set();
  const names = [];
  for (const ing of flatten(product.ingredients)) {
    if (ing[field] !== status) continue;
    // Übergeordnete Zutat genügt – verschachtelte Unterzutaten nicht doppelt nennen.
    const name = (ing.text || ing.id || '').replace(/^[a-z]{2}:/, '').trim();
    if (!name) continue;
    const norm = name.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    names.push(name.charAt(0).toUpperCase() + name.slice(1));
  }
  return names.slice(0, 8);
}

/**
 * Bewertet ein Produkt.
 * Reihenfolge: zertifizierte Siegel schlagen die automatische Zutatenanalyse.
 */
function assess(product) {
  const labels = product.labels_tags || [];
  const tags = product.ingredients_analysis_tags || [];

  const veganLabel = has(labels, 'en:vegan');
  const vegetarianLabel = has(labels, 'en:vegetarian') || has(labels, 'en:european-vegetarian-union');

  const veganTag = has(tags, 'en:vegan') ? 'yes'
    : has(tags, 'en:non-vegan') ? 'no'
    : has(tags, 'en:maybe-vegan') ? 'maybe' : 'unknown';
  const vegetarianTag = has(tags, 'en:vegetarian') ? 'yes'
    : has(tags, 'en:non-vegetarian') ? 'no'
    : has(tags, 'en:maybe-vegetarian') ? 'maybe' : 'unknown';

  const reasons = [];
  let verdict;

  if (veganLabel) {
    verdict = VERDICTS.vegan;
    reasons.push('Als vegan gekennzeichnet.');
  } else if (veganTag === 'yes') {
    verdict = VERDICTS.vegan;
    reasons.push('Alle Zutaten sind pflanzlich.');
  } else if (veganTag === 'no') {
    const bad = ingredientsWith(product, 'vegan', 'no');
    if (vegetarianTag === 'no') {
      verdict = VERDICTS.no;
      const meat = ingredientsWith(product, 'vegetarian', 'no');
      if (meat.length) reasons.push('Nicht vegetarisch wegen: ' + meat.join(', ') + '.');
    } else if (vegetarianTag === 'yes' || vegetarianLabel) {
      verdict = VERDICTS.vegetarian;
      if (bad.length) reasons.push('Nicht vegan wegen: ' + bad.join(', ') + '.');
    } else {
      verdict = Object.assign({}, VERDICTS.vegetarian, {
        title: 'Nicht vegan', sub: 'Vegetarisch unklar'
      });
      if (bad.length) reasons.push('Nicht vegan wegen: ' + bad.join(', ') + '.');
      const named = new Set(bad.map((n) => n.toLowerCase()));
      const maybeMeat = ingredientsWith(product, 'vegetarian', 'maybe')
        .filter((n) => !named.has(n.toLowerCase()));
      if (maybeMeat.length) reasons.push('Unklar: ' + maybeMeat.join(', ') + '.');
    }
  } else {
    // vegan 'maybe' oder gar keine Analyse
    const maybe = ingredientsWith(product, 'vegan', 'maybe');
    if (vegetarianTag === 'no') {
      verdict = VERDICTS.no;
      const meat = ingredientsWith(product, 'vegetarian', 'no');
      if (meat.length) reasons.push('Nicht vegetarisch wegen: ' + meat.join(', ') + '.');
    } else {
      verdict = Object.assign({}, VERDICTS.unknown, {
        sub: vegetarianTag === 'yes' || vegetarianLabel ? 'Vegetarisch, vegan unklar' : VERDICTS.unknown.sub
      });
      if (maybe.length) {
        reasons.push('Nicht eindeutig: ' + maybe.join(', ') + ' – kann tierisch oder pflanzlich sein.');
      } else if (!(product.ingredients || []).length) {
        reasons.push('Keine Zutatenliste hinterlegt.');
      } else {
        reasons.push('Zutatenliste nicht vollständig auswertbar.');
      }
    }
  }

  return { verdict, reasons, veganLabel };
}

/* ------------------------------------------------------------------ Abfrage */

function cacheRead(code) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    const hit = all[code];
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.p;
  } catch (_) {}
  return null;
}

function cacheWrite(code, product) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    all[code] = { t: Date.now(), p: product };
    const keys = Object.keys(all);
    if (keys.length > 120) {
      keys.sort((a, b) => all[a].t - all[b].t).slice(0, keys.length - 120)
        .forEach((k) => delete all[k]);
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch (_) {}
}

async function lookup(code) {
  const url = `${API}${encodeURIComponent(code)}.json?lc=de&cc=de&fields=${FIELDS}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('HTTP ' + res.status);

  const data = await res.json();
  if (!data || data.status === 0 || !data.product) return null;
  return data.product;
}

async function fetchProduct(code) {
  const cached = cacheRead(code);
  if (cached) return cached;

  let product = await lookup(code);
  // US-Barcodes (UPC-A, 12 Ziffern) liegen dort oft mit führender Null als EAN-13.
  if (!product && code.length === 12) product = await lookup('0' + code);

  if (product) cacheWrite(code, product);
  return product;
}

/* ----------------------------------------------------------------- Ausgabe */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function productTitle(p) {
  return p.product_name_de || p.product_name || 'Unbekanntes Produkt';
}

function renderLoading(code) {
  els.result.hidden = false;
  els.result.innerHTML =
    `<div class="spinner-box"><div class="spinner"></div>Wird geprüft …</div>`;
  els.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderMessage(title, body) {
  els.result.hidden = false;
  els.result.innerHTML = `
    <div class="verdict v-unknown">
      ${glyphMarkup(GLYPHS.query)}
      <h2>${esc(title)}</h2>
      <p class="sub">${body}</p>
    </div>`;
  els.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderProduct(code, product) {
  const { verdict, reasons, veganLabel } = assess(product);
  const img = product.image_front_small_url || product.image_small_url || '';
  const meta = [product.brands, product.quantity].filter(Boolean).join(' · ');

  els.result.hidden = false;
  els.result.innerHTML = `
    <div class="verdict ${verdict.cls}">
      ${glyphMarkup(verdict.glyph)}
      <h2>${esc(verdict.title)}</h2>
      ${verdict.sub ? `<p class="sub">${esc(verdict.sub)}</p>` : ''}
      ${veganLabel ? '<span class="badge">Vegan gekennzeichnet</span>' : ''}
    </div>
    <div class="product">
      ${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ''}
      <div>
        <div class="name">${esc(productTitle(product))}</div>
        <div class="meta">${esc(meta || 'Barcode ' + code)}</div>
      </div>
    </div>
    ${reasons.length ? `<div class="why">
      <ul>${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    </div>` : ''}
    ${detailsMarkup(product)}`;

  els.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  addHistory(code, productTitle(product), verdict.key);
}

async function check(code) {
  renderLoading(code);
  try {
    const product = await fetchProduct(code);
    if (!product) {
      renderMessage('Nicht gefunden',
        `Kein Eintrag für ${esc(code)}.
         <a href="https://de.openfoodfacts.org/cgi/product.pl?type=add&code=${encodeURIComponent(code)}"
            target="_blank" rel="noopener">Bei Open Food Facts ergänzen</a>`);
      return;
    }
    renderProduct(code, product);
  } catch (err) {
    renderMessage('Keine Verbindung', 'Produktdaten konnten nicht geladen werden.');
  }
}

/* ------------------------------------------------------------- Alle Daten */

const NUM = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });

const NUTRIENTS = [
  ['energy-kcal', 'Energie', 'kcal'],
  ['fat', 'Fett', 'g'],
  ['saturated-fat', 'davon gesättigte Fettsäuren', 'g'],
  ['carbohydrates', 'Kohlenhydrate', 'g'],
  ['sugars', 'davon Zucker', 'g'],
  ['fiber', 'Ballaststoffe', 'g'],
  ['proteins', 'Eiweiß', 'g'],
  ['salt', 'Salz', 'g']
];

/** Nährwerte je 100 g, sonst je Portion – je nachdem, was hinterlegt ist. */
function nutritionRows(product) {
  const n = product.nutriments || {};
  for (const [suffix, label] of [['_100g', 'je 100\u00a0g'], ['_serving', 'je Portion']]) {
    const rows = NUTRIENTS
      .filter(([key]) => typeof n[key + suffix] === 'number')
      .map(([key, name, unit]) => ({
        name,
        value: NUM.format(n[key + suffix]) + '\u00a0' + unit,
        sub: name.startsWith('davon')
      }));
    if (rows.length) return { rows, label };
  }
  return { rows: [], label: '' };
}

function ingredientsText(product) {
  const text = product.ingredients_text_de || product.ingredients_text || '';
  // Open Food Facts markiert Allergene mit Unterstrichen (_Milch_).
  return text.replace(/_/g, '').replace(/\s+/g, ' ').trim();
}

function detailsMarkup(product) {
  const { rows, label } = nutritionRows(product);
  const text = ingredientsText(product);
  if (!rows.length && !text) return '';

  const nutrition = rows.length ? `
    <h4>Nährwerte <span>${esc(label)}</span></h4>
    <dl class="nutri">
      ${rows.map((r) => `<div${r.sub ? ' class="sub"' : ''}>
        <dt>${esc(r.name)}</dt><dd>${esc(r.value)}</dd></div>`).join('')}
    </dl>` : '';

  const ingredients = text ? `
    <h4>Zutaten</h4>
    <p class="ing">${esc(text)}</p>` : '';

  return `
    <details class="details">
      <summary>
        <span>Alle Daten</span>
        <span class="chev" aria-hidden="true"><svg viewBox="0 0 7 12"><path d="M1 1l5 5-5 5"/></svg></span>
      </summary>
      <div class="details-body">${nutrition}${ingredients}</div>
    </details>`;
}

/* ----------------------------------------------------------------- Verlauf */

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (_) { return []; }
}

function addHistory(code, name, verdictKey) {
  const list = loadHistory().filter((e) => e.code !== code);
  list.unshift({ code, name, v: verdictKey });
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 8))); } catch (_) {}
  renderHistory();
}

function renderHistory() {
  const list = loadHistory();
  els.historyWrap.hidden = list.length === 0;
  els.history.innerHTML = list.map((e) => `
    <li><button type="button" data-code="${esc(e.code)}">
      <span class="dot d-${esc(e.v)}"></span>
      <span class="t">${esc(e.name)}</span>
      <span class="c">${esc(e.code)}</span>
      <span class="chev" aria-hidden="true"><svg viewBox="0 0 7 12"><path d="M1 1l5 5-5 5"/></svg></span>
    </button></li>`).join('');
}

/* ----------------------------------------------------------------- Scanner */

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];
let stream = null;
let detectLoop = null;
let torchTrack = null;

/* Die Taschenlampe gibt es nur, wo der Browser sie als Fähigkeit der Kamera
   meldet – auf iOS tut er das bis heute nicht. */
function setupTorch() {
  const track = stream && stream.getVideoTracks()[0];
  const caps = track && track.getCapabilities ? track.getCapabilities() : null;
  torchTrack = caps && 'torch' in caps ? track : null;
  setTorchUi(false);
  els.btnTorch.hidden = !torchTrack;
}

function setTorchUi(on) {
  els.btnTorch.setAttribute('aria-pressed', on ? 'true' : 'false');
  els.btnTorch.setAttribute('aria-label', on ? 'Taschenlampe ausschalten' : 'Taschenlampe einschalten');
}

async function toggleTorch() {
  if (!torchTrack) return;
  const on = els.btnTorch.getAttribute('aria-pressed') !== 'true';
  try {
    await torchTrack.applyConstraints({ advanced: [{ torch: on }] });
    setTorchUi(on);
  } catch (_) {
    torchTrack = null;
    els.btnTorch.hidden = true;
  }
}

function stopScan() {
  document.body.classList.remove('scanning');
  els.btnTorch.hidden = true;
  torchTrack = null;
  els.btnScan.textContent = 'Barcode scannen';
  els.btnScan.classList.remove('secondary');
  if (detectLoop) { cancelAnimationFrame(detectLoop); detectLoop = null; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  els.video.srcObject = null;
}

function onDetected(raw) {
  const code = String(raw || '').replace(/\D/g, '');
  if (code.length < 6) return;
  stopScan();
  if (navigator.vibrate) navigator.vibrate(60);
  check(code);
}

async function openCamera() {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Script konnte nicht geladen werden: ' + src));
    document.head.appendChild(s);
  });
}

/* Strichcodes liegen im Regal mal quer, mal hochkant, mal schief. Zeilenweise
   Leser sehen nur ungefähr waagerechte Codes, deshalb bekommen sie den Frame
   reihum in vier Lagen vorgelegt: 0°, 90°, 45°, 135°. Zusammen mit der
   Toleranz von rund ±20° je Lage deckt das jede Ausrichtung ab; auf dem Kopf
   stehende Codes liest ZXing ohnehin selbst. */
const ANGLES = [0, 90, 45, 135];
const frameCanvas = document.createElement('canvas');

function grabFrame(angle) {
  const video = els.video;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;

  const scale = Math.min(1, 800 / Math.max(vw, vh));
  const w = Math.round(vw * scale), h = Math.round(vh * scale);
  const canvas = frameCanvas;
  // Nur die Vierteldrehung tauscht die Seiten; schräge Lagen behalten das
  // Format und schneiden die Ecken ab – der Code liegt im Sucherrahmen.
  canvas.width = angle === 90 ? h : w;
  canvas.height = angle === 90 ? w : h;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(-angle * Math.PI / 180);
  ctx.drawImage(video, -w / 2, -h / 2, w, h);
  ctx.restore();
  return canvas;
}

async function scanWithZXing() {
  if (!window.ZXing) await loadScript('vendor/zxing-0.21.3.min.js');
  const { MultiFormatReader, BinaryBitmap, HybridBinarizer,
          HTMLCanvasElementLuminanceSource, DecodeHintType, BarcodeFormat } = window.ZXing;

  const reader = new MultiFormatReader();
  reader.setHints(new Map([
    [DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128
    ]]
  ]));

  const read = (canvas) => {
    try {
      const source = new HTMLCanvasElementLuminanceSource(canvas);
      return reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(source)));
    } catch (_) {
      return null;               // kein Code in diesem Frame
    } finally {
      reader.reset();
    }
  };

  let turn = 0, lastRun = 0;
  const tick = (now) => {
    if (!stream) return;
    if (now - lastRun > 70) {
      lastRun = now;
      const canvas = grabFrame(ANGLES[turn]);
      const hit = canvas && read(canvas);
      if (hit) { onDetected(hit.getText()); return; }
      turn = (turn + 1) % ANGLES.length;
    }
    if (stream) detectLoop = requestAnimationFrame(tick);
  };
  detectLoop = requestAnimationFrame(tick);
}

async function scanWithNativeDetector() {
  const supported = await window.BarcodeDetector.getSupportedFormats();
  const formats = FORMATS.filter((f) => supported.includes(f));
  if (!formats.length) return scanWithZXing();

  const detector = new window.BarcodeDetector({ formats });
  let turn = 0;
  const tick = async () => {
    if (!stream) return;
    try {
      const angle = ANGLES[turn];
      const target = angle === 0 ? els.video : grabFrame(angle);
      const hits = target ? await detector.detect(target) : null;
      if (hits && hits.length) { onDetected(hits[0].rawValue); return; }
    } catch (_) { /* einzelne Frames dürfen fehlschlagen */ }
    turn = (turn + 1) % ANGLES.length;
    if (stream) detectLoop = requestAnimationFrame(tick);
  };
  detectLoop = requestAnimationFrame(tick);
}

async function startScan() {
  if (stream) { stopScan(); return; }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    els.camHint.textContent = 'Kamera nicht verfügbar – Nummer eintippen';
    return;
  }
  if (!window.isSecureContext) {
    els.camHint.textContent = 'Kamera braucht HTTPS – Nummer eintippen';
    return;
  }

  els.camHint.textContent = 'Kamera wird gestartet …';
  els.btnScan.textContent = 'Scannen beenden';
  els.btnScan.classList.add('secondary');
  try {
    stream = await openCamera();
    els.video.srcObject = stream;
    await els.video.play();
    document.body.classList.add('scanning');
    setupTorch();
    if ('BarcodeDetector' in window) await scanWithNativeDetector();
    else await scanWithZXing();
  } catch (err) {
    stopScan();
    els.camHint.textContent = (err && err.name === 'NotAllowedError')
      ? 'Kein Kamerazugriff – im Browser erlauben oder Nummer eintippen'
      : 'Kamera nicht verfügbar – Nummer eintippen';
  }
}

/* -------------------------------------------------------------------- Start */

els.btnScan.addEventListener('click', startScan);
els.btnTorch.addEventListener('click', toggleTorch);

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = els.input.value.replace(/\D/g, '');
  if (code.length < 6) {
    els.input.focus();
    renderMessage('Nummer unvollständig', 'Meist 8 oder 13 Ziffern.');
    return;
  }
  stopScan();
  els.input.blur();
  check(code);
});

els.history.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-code]');
  if (btn) check(btn.dataset.code);
});

// Trennlinie unter der Leiste erscheint erst, sobald Inhalt darunter liegt.
const topbar = document.querySelector('.topbar');
const onScroll = () => topbar.classList.toggle('stuck', window.scrollY > 2);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

els.btnInfo.addEventListener('click', () => els.dialog.showModal());
els.btnCloseInfo.addEventListener('click', () => els.dialog.close());

document.addEventListener('visibilitychange', () => { if (document.hidden) stopScan(); });

renderHistory();
els.camHint.textContent = 'Barcode ins Bild halten';

// Barcode aus der Adresse, z. B. ?code=4000417025005
const initial = new URLSearchParams(location.search).get('code');
if (initial && /^\d{6,14}$/.test(initial)) check(initial);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
