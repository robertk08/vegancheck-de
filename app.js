/* VeganCheck – Barcode scannen, Ergebnis: vegan / vegetarisch / keins von beidem.
   Daten: Open Food Facts (ODbL). Läuft vollständig im Browser. */
'use strict';

// Lebensmittel zuerst; Kosmetik, Tierfutter und sonstige Produkte als Rückfall.
const SOURCES = [
  { hosts: ['https://world.openfoodfacts.org', 'https://de.openfoodfacts.org'], name: 'Open Food Facts', site: 'https://de.openfoodfacts.org' },
  { hosts: ['https://world.openbeautyfacts.org'], name: 'Open Beauty Facts', site: 'https://de.openbeautyfacts.org' },
  { hosts: ['https://world.openpetfoodfacts.org'], name: 'Open Pet Food Facts', site: 'https://de.openpetfoodfacts.org' },
  { hosts: ['https://world.openproductsfacts.org'], name: 'Open Products Facts', site: 'https://de.openproductsfacts.org' }
];
const FIELDS = [
  'code', 'product_name', 'product_name_de', 'brands', 'quantity',
  'image_front_small_url', 'image_small_url',
  'labels_tags', 'ingredients_analysis_tags', 'ingredients',
  'ingredients_text_de', 'ingredients_text',
  'nutriments', 'nutrition_data_per', 'serving_size',
  'allergens_tags', 'traces_tags', 'nutriscore_grade', 'nova_group', 'ecoscore_grade',
  'categories_tags', 'categories_hierarchy'
].join(',');
const SEARCH = 'https://de.openfoodfacts.org/cgi/search.pl';
const LIST_FIELDS = 'code,product_name,product_name_de,brands,quantity,image_front_small_url,labels_tags,ingredients_analysis_tags';
const HISTORY_KEY = 'vc.history.v2';
const OLD_HISTORY_KEY = 'vc.history.v1';
const SETTINGS_KEY = 'vc.settings.v1';
const HISTORY_MAX = 300;
const CACHE_KEY = 'vc.products.v3';
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

const $ = (sel) => document.querySelector(sel);
const els = {
  video: $('#video'), camHint: $('#cam-hint'), btnScan: $('#btn-scan'),
  btnTorch: $('#btn-torch'),
  form: $('#manual-form'), input: $('#manual-code'), result: $('#result'),
  recent: $('#recent'), recentWrap: $('#recent-wrap'),
  history: $('#history'), historyEmpty: $('#history-empty'), stats: $('#stats'),
  continuous: $('#opt-continuous'), toast: $('#toast'),
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
  likely: {
    key: 'likely', cls: 'v-likely', glyph: GLYPHS.check,
    title: 'Wahrscheinlich vegan', sub: 'Keine tierischen Zutaten erkennbar'
  },
  unknown: {
    key: 'unknown', cls: 'v-unknown', glyph: GLYPHS.query,
    title: 'Unklar', sub: 'Zutaten nicht eindeutig'
  }
};

/* Zutaten, die Open Food Facts als „vielleicht tierisch“ markiert, die in
   Deutschland aber fast immer pflanzlich sind. Sind nur solche im Spiel,
   lautet das Ergebnis „Wahrscheinlich vegan“ statt „Unklar“. */
const MOSTLY_PLANT = /aroma|aromen|flavou?r|lecithin|e ?322|emulgator|emulsifier|mono- und diglyceride|mono- and diglycerides|e ?471|zucker|sugar|wein|wine|essig|vinegar|vitamin|glycerin|e ?422|stearinsäure|stearic|e ?570|farbstoff|colou?r|säuerungsmittel|acidity|trennmittel|überzugsmittel|glazing/i;

/* Kategorien als Rückfall, wenn es keine Zutatenliste gibt. */
const CAT_NO = /^en:(meats?|.*-meats?|sausages|hams|poultry|fishes|seafood|.*-fish|fish-.*|gelatin|charcuterie|.*-sausages|bacon|.*-broths-of-meat)$/;
const CAT_VEG = /^en:(dairies|milks?|cheeses|.*-cheeses|yogurts|butters|creams|eggs|honeys|.*-honeys|dairy-desserts|milk-chocolates|ice-creams)$/;
const CAT_PLANT = /^en:(fruits|vegetables|.*-vegetables|fresh-fruits|legumes|plant-based-.*|cereals-and-potatoes|pastas|rices|nuts|seeds|vegetable-oils|olive-oils|.*-oils|sugars|coffees|teas|waters|.*-waters|fruit-juices|juices|.*-juices|soft-drinks|flours|spices|salts|jams|meat-alternatives|dark-chocolates|tofu|breads)$/;

function categoryHint(product) {
  const cats = product.categories_tags || [];
  if (cats.some((c) => CAT_NO.test(c))) return 'no';
  if (cats.some((c) => CAT_VEG.test(c))) return 'vegetarian';
  if (cats.some((c) => CAT_PLANT.test(c))) return 'likely';
  return null;
}

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
  } else if (veganTag === 'unknown' && vegetarianTag === 'unknown' && ingredientsText(product)) {
    // Open Food Facts hat nicht analysiert – Zutatentext selbst prüfen.
    const local = RULES.analyze(ingredientsText(product));
    verdict = VERDICTS[local.level];
    if (local.level === 'unknown' && local.hits.every((h) => MOSTLY_PLANT.test(h.note) || MOSTLY_PLANT.test(h.text))) {
      verdict = VERDICTS.likely;
    }
    const names = (lvl) => local.hits.filter((h) => h.level === lvl).map((h) => h.text).slice(0, 8);
    if (local.level === 'vegan') reasons.push('Keine tierischen Zutaten im Zutatentext gefunden.');
    if (names('no').length) reasons.push('Nicht vegetarisch wegen: ' + names('no').join(', ') + '.');
    if (names('veg').length) reasons.push('Nicht vegan wegen: ' + names('veg').join(', ') + '.');
    if (names('maybe').length) reasons.push('Nicht eindeutig: ' + names('maybe').join(', ') + '.');
    reasons.push('Eigene Auswertung des Zutatentexts.');
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
      const hint = categoryHint(product);
      const nameVegan = /\bvegan/i.test(productTitle(product));
      if (maybe.length && maybe.every((m) => MOSTLY_PLANT.test(m)) && vegetarianTag !== 'maybe') {
        verdict = VERDICTS.likely;
        reasons.push('Nur ' + maybe.join(', ') + ' könnte tierisch sein – ist aber fast immer pflanzlich.');
      } else if (!(product.ingredients || []).length && (hint || nameVegan)) {
        // Keine Zutaten: Name oder Kategorie geben den Ausschlag.
        const k = nameVegan ? 'likely' : hint;
        verdict = VERDICTS[k];
        reasons.push(nameVegan ? '„Vegan“ steht im Produktnamen.' : 'Abgeleitet aus der Produktkategorie.');
        reasons.push('Keine Zutatenliste hinterlegt – im Zweifel Verpackung prüfen.');
      } else if (maybe.length) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Eine Quelle abfragen. Bei Überlastung (429/503) mit Pause erneut, abwechselnd über die Hosts. */
async function lookup(source, code) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const host = source.hosts[attempt % source.hosts.length];
    try {
      const res = await fetch(`${host}/api/v2/product/${encodeURIComponent(code)}.json?lc=de&cc=de&fields=${FIELDS}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || data.status === 0 || !data.product) return null;
      data.product._source = source.name;
      data.product._site = source.site;
      return data.product;
    } catch (err) {
      lastErr = err;
      await sleep([400, 1200, 2500, 0][attempt]);
    }
  }
  throw lastErr;
}

/** Codes, unter denen ein Produkt liegen kann (UPC-A ↔ EAN-13, EAN-13 mit führender Null). */
function variants(code) {
  const v = [code];
  if (code.length === 12) v.push('0' + code);
  if (code.length === 13 && code.startsWith('0')) v.push(code.slice(1));
  if (code.length === 14 && code.startsWith('0')) v.push(code.slice(1));
  return v;
}

async function fetchProduct(code) {
  const cached = cacheRead(code);
  if (cached) return cached;

  let failures = 0;
  for (const source of SOURCES) {
    for (const c of variants(code)) {
      try {
        const product = await lookup(source, c);
        if (product) { cacheWrite(code, product); return product; }
      } catch (_) { failures++; }
    }
  }
  if (failures) throw new Error('offline');
  return null;
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
        ${product._source && product._source !== 'Open Food Facts' ? `<div class="meta">Quelle: ${esc(product._source)}</div>` : ''}
      </div>
    </div>
    ${reasons.length ? `<div class="why">
      <ul>${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    </div>` : ''}
    ${scoresMarkup(product)}
    <div class="actions">
      <button type="button" class="secondary" data-act="fav" data-code="${esc(code)}" aria-pressed="${isFav(code)}">${isFav(code) ? '★ Gemerkt' : '☆ Merken'}</button>
      <button type="button" class="secondary" data-act="share" data-code="${esc(code)}">Teilen</button>
      <a class="secondary btn-link" href="${esc(product._site || 'https://de.openfoodfacts.org')}/produkt/${encodeURIComponent(code)}" target="_blank" rel="noopener">Bearbeiten</a>
    </div>
    ${detailsMarkup(product)}
    <div class="alts" id="alts" hidden></div>`;

  els.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  addHistory(code, productTitle(product), verdict.key, product);
  if (verdict.key !== 'vegan') loadAlternatives(product);
}

/* ---------------------------------------------------- Scores & Allergene */

const ALLERGENS = {
  'en:milk': 'Milch', 'en:eggs': 'Ei', 'en:gluten': 'Gluten', 'en:nuts': 'Schalenfrüchte',
  'en:peanuts': 'Erdnüsse', 'en:soybeans': 'Soja', 'en:fish': 'Fisch', 'en:crustaceans': 'Krebstiere',
  'en:molluscs': 'Weichtiere', 'en:celery': 'Sellerie', 'en:mustard': 'Senf',
  'en:sesame-seeds': 'Sesam', 'en:sulphur-dioxide-and-sulphites': 'Sulfite', 'en:lupin': 'Lupine'
};
const allergenNames = (tags) => (tags || []).map((t) => ALLERGENS[t] || t.replace(/^[a-z]{2}:/, '')).filter(Boolean);

function scoresMarkup(p) {
  const chips = [];
  const ns = (p.nutriscore_grade || '').toLowerCase();
  if (/^[a-e]$/.test(ns)) chips.push(`<span class="score ns-${ns}" title="Nutri-Score">Nutri-Score <b>${ns.toUpperCase()}</b></span>`);
  if (p.nova_group) chips.push(`<span class="score nova-${p.nova_group}" title="Verarbeitungsgrad">NOVA <b>${esc(p.nova_group)}</b></span>`);
  const eco = (p.ecoscore_grade || '').toLowerCase();
  if (/^[a-e]$/.test(eco)) chips.push(`<span class="score ns-${eco}" title="Umwelt">Eco-Score <b>${eco.toUpperCase()}</b></span>`);
  const al = allergenNames(p.allergens_tags);
  const tr = allergenNames(p.traces_tags).filter((t) => !al.includes(t));
  if (!chips.length && !al.length && !tr.length) return '';
  return `<div class="why scores">
    ${chips.length ? `<div class="score-row">${chips.join('')}</div>` : ''}
    ${al.length ? `<p><b>Allergene:</b> ${esc(al.join(', '))}</p>` : ''}
    ${tr.length ? `<p class="muted">Kann Spuren enthalten von: ${esc(tr.join(', '))}</p>` : ''}
  </div>`;
}

/* ---------------------------------------------------------- Alternativen */

async function loadAlternatives(product) {
  // Spezifischste englische Kategorie; sonst nach dem Produktnamen suchen.
  const cats = (product.categories_hierarchy || product.categories_tags || []).filter((c) => c.startsWith('en:'));
  const cat = cats[cats.length - 1];
  const box = $('#alts');
  const name = (product.product_name_de || product.product_name || '').trim();
  if (!box || (!cat && !name)) return;
  try {
    const tags = [['labels', 'en:vegan']];
    if (cat) tags.push(['categories', cat]);
    const data = await searchApi(cat ? '' : name, tags, 12);
    const items = (data.products || []).filter((x) => x.code !== product.code).slice(0, 6);
    if (!items.length || !box.isConnected) return;
    box.hidden = false;
    box.innerHTML = `<h3>Vegane Alternativen</h3><div class="alt-row">${items.map((x) => `
      <button type="button" class="alt" data-code="${esc(x.code)}">
        ${x.image_front_small_url ? `<img src="${esc(x.image_front_small_url)}" alt="" loading="lazy">` : '<span class="ph"></span>'}
        <span>${esc(productTitle(x))}</span><small>${esc(x.brands || '')}</small>
      </button>`).join('')}</div>`;
  } catch (_) { /* Alternativen sind ein Extra */ }
}

let lastProduct = null;

async function check(code) {
  go('scan');
  renderLoading(code);
  try {
    const product = await fetchProduct(code);
    if (!product) {
      renderMessage('Nicht gefunden',
        `Kein Eintrag für ${esc(code)} – weder bei Lebensmitteln noch bei Kosmetik oder Tierfutter.<br><br>
         <a href="#ingredients" data-ing-hint>Zutatenliste selbst prüfen</a> ·
         <a href="https://de.openfoodfacts.org/cgi/product.pl?type=add&code=${encodeURIComponent(code)}"
            target="_blank" rel="noopener">Produkt eintragen</a>`);
      return;
    }
    renderProduct(code, product);
    lastProduct = { code, product };
  } catch (err) {
    renderMessage('Datenbank überlastet',
      `Open Food Facts antwortet gerade nicht. <a href="#" data-retry="${esc(code)}">Erneut versuchen</a>`);
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
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || 'null');
    if (list) return list;
    // Alte Einträge (nur 8, ohne Zeit) übernehmen
    return JSON.parse(localStorage.getItem(OLD_HISTORY_KEY) || '[]').map((e) => ({ ...e, t: Date.now() }));
  } catch (_) { return []; }
}
function saveHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX))); } catch (_) {}
}

function addHistory(code, name, verdictKey, product) {
  const all = loadHistory();
  const prev = all.find((e) => e.code === code);
  const list = all.filter((e) => e.code !== code);
  list.unshift({
    code, name, v: verdictKey, t: Date.now(), fav: !!(prev && prev.fav),
    brand: product && product.brands ? product.brands.split(',')[0] : '',
    img: product ? product.image_front_small_url || '' : ''
  });
  saveHistory(list);
  renderHistory();
}

const isFav = (code) => loadHistory().some((e) => e.code === code && e.fav);
function toggleFav(code) {
  const list = loadHistory();
  const e = list.find((x) => x.code === code);
  if (!e) return false;
  e.fav = !e.fav;
  saveHistory(list);
  renderHistory();
  return e.fav;
}

const DATE = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short' });
let historyFilter = 'all';

function rowMarkup(e, withDate) {
  return `
    <li><button type="button" data-code="${esc(e.code)}">
      <span class="dot d-${esc(e.v)}"></span>
      <span class="t">${e.fav ? '<span class="star">★</span> ' : ''}${esc(e.name)}</span>
      <span class="c">${withDate && e.t ? esc(DATE.format(e.t)) : esc(e.code)}</span>
      <span class="chev" aria-hidden="true"><svg viewBox="0 0 7 12"><path d="M1 1l5 5-5 5"/></svg></span>
    </button></li>`;
}

function renderHistory() {
  const list = loadHistory();
  els.recentWrap.hidden = list.length === 0;
  els.recent.innerHTML = list.slice(0, 5).map((e) => rowMarkup(e, false)).join('');

  const shown = list.filter((e) => historyFilter === 'all' ? true
    : historyFilter === 'fav' ? e.fav : e.v === historyFilter);
  els.history.innerHTML = shown.map((e) => rowMarkup(e, true)).join('');
  els.history.hidden = shown.length === 0;
  els.historyEmpty.hidden = shown.length > 0;
  els.historyEmpty.textContent = list.length ? 'Keine Einträge für diesen Filter.'
    : 'Noch nichts geprüft. Scanne einen Barcode, er erscheint dann hier.';

  const n = (k) => list.filter((e) => e.v === k).length;
  const total = list.length || 1;
  const parts = [['vegan', 'Vegan'], ['likely', 'Wahrsch. vegan'], ['vegetarian', 'Vegetarisch'], ['no', 'Nicht veg.'], ['unknown', 'Unklar']];
  els.stats.hidden = list.length === 0;
  els.stats.innerHTML = `
    <div class="stat-top"><b>${list.length}</b> Produkte geprüft · <b>${Math.round((n('vegan') + n('likely')) / total * 100)}%</b> vegan</div>
    <div class="bar-stack">${parts.map(([k]) => n(k) ? `<span class="d-${k}" style="flex:${n(k)}"></span>` : '').join('')}</div>
    <div class="legend">${parts.map(([k, l]) => `<span><i class="dot d-${k}"></i>${l} ${n(k)}</span>`).join('')}</div>`;
}

/* ------------------------------------------------------------------ Suche */

let searchFilter = 'all';
let searchSeq = 0;

function quickVerdict(p) {
  const l = p.labels_tags || [], t = p.ingredients_analysis_tags || [];
  if (l.includes('en:vegan') || t.includes('en:vegan')) return 'vegan';
  if (t.includes('en:non-vegetarian')) return 'no';
  if (t.includes('en:non-vegan') && (t.includes('en:vegetarian') || l.includes('en:vegetarian'))) return 'vegetarian';
  return 'unknown';
}

/** Produktsuche bei Open Food Facts. terms = Freitext, tags = [[Typ, Wert], …]. */
async function searchApi(terms, tags, size) {
  let url = `${SEARCH}?action=process&json=1&page_size=${size}&sort_by=unique_scans_n&fields=${LIST_FIELDS}`;
  if (terms) url += `&search_simple=1&search_terms=${encodeURIComponent(terms)}`;
  tags.forEach(([type, value], i) => {
    url += `&tagtype_${i}=${type}&tag_contains_${i}=contains&tag_${i}=${encodeURIComponent(value)}`;
  });
  const res = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function runSearch() {
  const q = $('#search-q').value.trim();
  const box = $('#search-results');
  if (q.length < 2) { box.innerHTML = ''; return; }
  const seq = ++searchSeq;
  box.innerHTML = '<div class="spinner-box"><div class="spinner"></div>Suche …</div>';
  try {
    const data = await searchApi(q, searchFilter === 'all' ? []
      : [['ingredients_analysis', 'en:' + searchFilter]], 30);
    if (seq !== searchSeq) return;
    const items = data.products || [];
    if (!items.length) { box.innerHTML = '<p class="empty">Nichts gefunden.</p>'; return; }
    box.innerHTML = `<ul class="list">${items.map((p) => `
      <li><button type="button" data-code="${esc(p.code)}">
        ${p.image_front_small_url ? `<img class="thumb" src="${esc(p.image_front_small_url)}" alt="" loading="lazy">` : '<span class="thumb"></span>'}
        <span class="t two"><span>${esc(productTitle(p))}</span><small>${esc([p.brands, p.quantity].filter(Boolean).join(' · '))}</small></span>
        <span class="dot d-${quickVerdict(p)}"></span>
        <span class="chev" aria-hidden="true"><svg viewBox="0 0 7 12"><path d="M1 1l5 5-5 5"/></svg></span>
      </button></li>`).join('')}</ul>`;
  } catch (_) {
    // Open Food Facts erlaubt nur rund 10 Suchen pro Minute.
    if (seq === searchSeq) box.innerHTML = '<p class="empty">Suche gerade nicht erreichbar – bitte gleich noch einmal versuchen.</p>';
  }
}

/* ---------------------------------------------------------- Zutaten-Check */

const LEVEL_TEXT = { no: 'nicht vegetarisch', veg: 'nicht vegan', maybe: 'unklar' };
const LEVEL_DOT = { no: 'no', veg: 'vegetarian', maybe: 'unknown' };

function renderIngredients() {
  const text = $('#ing-text').value.trim();
  const box = $('#ing-result');
  if (!text) { box.innerHTML = ''; return; }
  const { level, hits } = RULES.analyze(text);
  const v = VERDICTS[level];
  box.innerHTML = `
    <div class="verdict ${v.cls}">${glyphMarkup(v.glyph)}<h2>${esc(v.title)}</h2>
      ${v.sub ? `<p class="sub">${esc(v.sub)}</p>` : ''}</div>
    ${hits.length ? `<ul class="list">${hits.map((h) => `
      <li><div class="li"><span class="dot d-${LEVEL_DOT[h.level]}"></span>
        <span class="t two"><span>${esc(h.text)}</span><small>${esc(h.note)}</small></span>
        <span class="c">${LEVEL_TEXT[h.level]}</span></div></li>`).join('')}</ul>` : ''}`;
}

function renderELexicon() {
  const order = { no: 0, veg: 1, maybe: 2 };
  $('#e-list').innerHTML = Object.entries(RULES.E)
    .sort((a, b) => order[a[1][0]] - order[b[1][0]] || parseInt(a[0].slice(1)) - parseInt(b[0].slice(1)))
    .map(([k, [lvl, name]]) => `<div><dt><span class="dot d-${LEVEL_DOT[lvl]}"></span> ${k} · ${esc(name)}</dt><dd>${LEVEL_TEXT[lvl]}</dd></div>`)
    .join('');
}

/* ------------------------------------------------------------- Navigation */

function go(tab) {
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.dataset.tab !== tab; });
  document.querySelectorAll('.tabbar button').forEach((b) =>
    b.toggleAttribute('aria-current', b.dataset.go === tab));
  if (tab !== 'scan') stopScan();
  const hash = tab === 'scan' ? '' : '#' + tab;
  if (location.hash !== hash) history.replaceState(null, '', location.pathname + location.search + hash);
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { els.toast.hidden = true; }, 2200);
}

async function share(code) {
  const url = `${location.origin}${location.pathname}?code=${code}`;
  const name = lastProduct && lastProduct.code === code ? productTitle(lastProduct.product) : 'Produkt';
  const v = lastProduct ? assess(lastProduct.product).verdict.title : '';
  const data = { title: 'VeganCheck', text: `${name}: ${v}`, url };
  try {
    if (navigator.share) await navigator.share(data);
    else { await navigator.clipboard.writeText(`${data.text} – ${url}`); toast('Link kopiert'); }
  } catch (_) {}
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

let lastHit = { code: '', t: 0 };

function onDetected(raw) {
  const code = String(raw || '').replace(/\D/g, '');
  if (code.length < 6) return false;
  if (navigator.vibrate) navigator.vibrate(60);
  if (els.continuous.checked) {
    // Im Dauerscan denselben Code nicht sofort erneut prüfen
    if (code === lastHit.code && Date.now() - lastHit.t < 4000) return false;
    lastHit = { code, t: Date.now() };
    check(code);
    return false;   // Schleife läuft weiter
  }
  stopScan();
  check(code);
  return true;
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
      if (hit && onDetected(hit.getText())) return;
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
      if (hits && hits.length && onDetected(hits[0].rawValue)) return;
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

// Ein Klick-Handler für alle Listen mit Produkten
document.addEventListener('click', (e) => {
  const retry = e.target.closest('[data-retry]');
  if (retry) { e.preventDefault(); check(retry.dataset.retry); return; }
  const ingHint = e.target.closest('[data-ing-hint]');
  if (ingHint) { e.preventDefault(); go('ingredients'); $('#ing-text').focus(); return; }
  const act = e.target.closest('[data-act]');
  if (act) {
    const code = act.dataset.code;
    if (act.dataset.act === 'fav') {
      const on = toggleFav(code);
      act.textContent = on ? '★ Gemerkt' : '☆ Merken';
      act.setAttribute('aria-pressed', on);
      toast(on ? 'Zu Favoriten hinzugefügt' : 'Aus Favoriten entfernt');
    } else if (act.dataset.act === 'share') share(code);
    return;
  }
  const row = e.target.closest('#recent button[data-code], #history button[data-code], #search-results button[data-code], .alt[data-code]');
  if (row) check(row.dataset.code);
  const tabBtn = e.target.closest('.tabbar button[data-go]');
  if (tabBtn) go(tabBtn.dataset.go);
});

function chipGroup(id, onPick) {
  $(id).addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    $(id).querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
    onPick(c.dataset.f);
  });
}
chipGroup('#history-filter', (f) => { historyFilter = f; renderHistory(); });
chipGroup('#search-filter', (f) => { searchFilter = f; runSearch(); });

$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); $('#search-q').blur(); runSearch(); });
let searchTimer;
$('#search-q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 900); });

$('#ing-text').addEventListener('input', renderIngredients);

$('#btn-clear').addEventListener('click', () => {
  if (!confirm('Gesamten Verlauf inklusive Favoriten löschen?')) return;
  saveHistory([]);
  renderHistory();
});
$('#btn-export').addEventListener('click', () => {
  const rows = [['Barcode', 'Produkt', 'Marke', 'Ergebnis', 'Favorit', 'Datum']].concat(
    loadHistory().map((e) => [e.code, e.name, e.brand || '', VERDICTS[e.v] ? VERDICTS[e.v].title : e.v,
      e.fav ? 'ja' : '', e.t ? new Date(e.t).toISOString().slice(0, 10) : '']));
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' }));
  a.download = 'vegancheck-verlauf.csv';
  a.click();
});

try { els.continuous.checked = !!JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}').continuous; } catch (_) {}
els.continuous.addEventListener('change', () => {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ continuous: els.continuous.checked })); } catch (_) {}
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
renderELexicon();
const startTab = location.hash.slice(1);
go(['search', 'history', 'ingredients'].includes(startTab) ? startTab : 'scan');
els.camHint.textContent = 'Barcode ins Bild halten';

// Barcode aus der Adresse, z. B. ?code=4000417025005
const initial = new URLSearchParams(location.search).get('code');
if (initial && /^\d{6,14}$/.test(initial)) check(initial);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
