/* VeganCheck – Barcode scannen, sofort sehen: vegan, vegetarisch oder keins von beidem.
   Daten: Open Food Facts & Schwesterprojekte (ODbL), USDA FoodData Central.
   Läuft vollständig im Browser; Verlauf und Zwischenspeicher bleiben auf dem Gerät. */
'use strict';

/* ================================================================== Daten */

const FIELDS = [
  'code', 'product_name', 'product_name_de', 'brands', 'quantity',
  'image_front_small_url', 'image_front_url',
  'labels_tags', 'ingredients_analysis_tags', 'ingredients',
  'ingredients_text_de', 'ingredients_text',
  'nutriments', 'allergens_tags', 'traces_tags',
  'nutriscore_grade', 'nova_group', 'categories_tags', 'categories_hierarchy',
  'image_ingredients_url', 'generic_name', 'generic_name_de'
].join(',');
const LIST_FIELDS = 'code,product_name,product_name_de,brands,quantity,image_front_small_url,labels_tags,ingredients_analysis_tags';

// Lebensmittel zuerst; die anderen nur, wenn dort nichts liegt.
const FOOD = { hosts: ['https://world.openfoodfacts.org', 'https://de.openfoodfacts.org'], name: 'Open Food Facts', site: 'https://de.openfoodfacts.org' };
const OTHER_SOURCES = [
  { hosts: ['https://world.openbeautyfacts.org'], name: 'Open Beauty Facts', site: 'https://de.openbeautyfacts.org' },
  { hosts: ['https://world.openpetfoodfacts.org'], name: 'Open Pet Food Facts', site: 'https://de.openpetfoodfacts.org' },
  { hosts: ['https://world.openproductsfacts.org'], name: 'Open Products Facts', site: 'https://de.openproductsfacts.org' }
];
// USDA FoodData Central: Markenprodukte aus den USA (Importware), mit Zutatenliste.
// DEMO_KEY ist stark limitiert – eigener kostenloser Schlüssel: https://fdc.nal.usda.gov/api-key-signup
const USDA_KEY = 'DEMO_KEY';
// Ältere Suche von Open Food Facts; die Server lehnen unter Last oft ab, daher mehrere.
const SEARCH_HOSTS = ['https://world.openfoodfacts.org', 'https://de.openfoodfacts.org', 'https://fr.openfoodfacts.org',
  'https://uk.openfoodfacts.org', 'https://at.openfoodfacts.org', 'https://ch.openfoodfacts.org'];

const HISTORY_KEY = 'vc.history.v2';
const CACHE_KEY = 'vc.products.v4';
const CACHE_TTL = 7 * 24 * 3600 * 1000;
const HISTORY_MAX = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeout = (ms) => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

function cacheRead(code) {
  try {
    const hit = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')[code];
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.p;
  } catch (_) {}
  return null;
}
function cacheWrite(code, product) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    all[code] = { t: Date.now(), p: product };
    const keys = Object.keys(all);
    if (keys.length > 150) keys.sort((a, b) => all[a].t - all[b].t).slice(0, keys.length - 150).forEach((k) => delete all[k]);
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch (_) {}
}

class Busy extends Error {}

/** Eine Open-*-Facts-Quelle. Bei Überlastung (429/5xx/Netz) sofort über den zweiten Host, dann mit kurzer Pause. */
async function offLookup(source, code) {
  const waits = [0, 0, 500, 1400];
  for (let i = 0; i < waits.length; i++) {
    if (waits[i]) await sleep(waits[i]);
    const host = source.hosts[i % source.hosts.length];
    try {
      const res = await fetch(`${host}/api/v2/product/${code}.json?lc=de&cc=de&fields=${FIELDS}`, { signal: timeout(i < 2 ? 5000 : 8000) });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) continue;
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || data.status === 0 || !data.product) return null;
      return Object.assign(data.product, { code: data.product.code || code, _source: source.name, _site: source.site });
    } catch (_) { /* Netz oder Zeitüberschreitung: nächster Versuch */ }
  }
  throw new Busy(source.name);
}

/** USDA: sucht im Feld gtinUpc; dort liegen Codes mal mit, mal ohne führende Nullen. */
async function usdaLookup(code) {
  const bare = code.replace(/^0+/, '');
  const forms = [...new Set([bare.padStart(12, '0'), bare.padStart(13, '0'), bare.padStart(14, '0'), bare])];
  const q = forms.map((f) => `gtinUpc:${f}`).join(' OR ');
  const res = await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?dataType=Branded&pageSize=1&api_key=${USDA_KEY}&query=${encodeURIComponent(q)}`, { signal: timeout(7000) });
  if (!res.ok) throw new Busy('USDA');
  const f = ((await res.json()).foods || [])[0];
  if (!f || f.gtinUpc.replace(/^0+/, '') !== bare) return null;
  const title = (s) => String(s || '').toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase());
  return {
    code, product_name: title(f.description), brands: title(f.brandName || f.brandOwner),
    quantity: f.packageWeight || '', ingredients_text: (f.ingredients || '').toLowerCase(),
    categories_tags: [], _source: 'USDA FoodData Central', _site: `https://fdc.nal.usda.gov/food-details/${f.fdcId}/details`
  };
}

/** Codes, unter denen dasselbe Produkt liegen kann (UPC-A ↔ EAN-13, führende Nullen). */
function variants(code) {
  const v = new Set([code]);
  if (code.length === 12) v.add('0' + code);
  if (/^0/.test(code) && code.length >= 13) v.add(code.slice(1));
  if (code.length === 8) v.add(code.padStart(13, '0'));
  return [...v];
}

/** Erstes Ergebnis ≠ null aus mehreren parallel laufenden Abfragen. */
function firstFound(promises) {
  return new Promise((resolve, reject) => {
    let pending = promises.length, failed = 0;
    if (!pending) resolve(null);
    for (const p of promises) {
      p.then((r) => { if (r) resolve(r); }, () => { failed++; })
        .finally(() => { if (--pending === 0) failed === promises.length ? reject(new Busy('alle')) : resolve(null); });
    }
  });
}

const inflight = new Map();

/** Produkt zu einem Barcode – erst Cache, dann Open Food Facts, dann alle anderen Quellen gleichzeitig. */
function fetchProduct(code) {
  const cached = cacheRead(code);
  if (cached) return Promise.resolve(cached);
  if (inflight.has(code)) return inflight.get(code);

  const job = (async () => {
    let busy = false;
    try {
      const p = await offLookup(FOOD, code);
      if (p) return p;
    } catch (_) { busy = true; }

    const more = [
      ...variants(code).slice(1).map((c) => offLookup(FOOD, c)),
      ...OTHER_SOURCES.map((s) => offLookup(s, code)),
      usdaLookup(code)
    ];
    try {
      const p = await firstFound(more);
      if (p || !busy) return p;
    } catch (_) { /* alles überlastet */ }
    throw new Busy('offline');
  })();

  inflight.set(code, job);
  job.then((p) => { if (p) cacheWrite(code, p); }, () => {}).finally(() => inflight.delete(code));
  return job;
}

/** Produktsuche: Server der Reihe nach, bis einer antwortet. */
const searchCache = new Map();
async function searchProducts(terms, tags = [], size = 24, signal) {
  const key = JSON.stringify([terms, tags, size]);
  if (searchCache.has(key)) return searchCache.get(key);
  let qs = `?action=process&json=1&page_size=${size}&sort_by=unique_scans_n&fields=${LIST_FIELDS}`;
  if (terms) qs += `&search_simple=1&search_terms=${encodeURIComponent(terms)}`;
  tags.forEach(([type, value], i) => { qs += `&tagtype_${i}=${type}&tag_contains_${i}=contains&tag_${i}=${encodeURIComponent(value)}`; });

  for (const [i, host] of SEARCH_HOSTS.entries()) {
    if (signal && signal.aborted) throw new DOMException('abgebrochen', 'AbortError');
    try {
      const res = await fetch(`${host}/cgi/search.pl${qs}`, { signal: signal || timeout(6000) });
      if (res.ok) {
        const list = (await res.json()).products || [];
        searchCache.set(key, list);
        return list;
      }
    } catch (err) { if (err.name === 'AbortError' && signal && signal.aborted) throw err; }
    await sleep(i < 2 ? 150 : 400);
  }
  throw new Busy('Suche');
}

/* ================================================================ Verlauf */

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (_) { return []; }
}
function saveHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX))); } catch (_) {}
  renderRecent();
}
function addHistory(code, product, v) {
  const all = loadHistory();
  const prev = all.find((e) => e.code === code);
  saveHistory([{
    code, name: productTitle(product), v, t: Date.now(), fav: !!(prev && prev.fav),
    brand: (product.brands || '').split(',')[0].trim(), img: product.image_front_small_url || ''
  }, ...all.filter((e) => e.code !== code)]);
}
const isFav = (code) => loadHistory().some((e) => e.code === code && e.fav);
function toggleFav(code) {
  const list = loadHistory();
  const e = list.find((x) => x.code === code);
  if (!e) return false;
  e.fav = !e.fav;
  saveHistory(list);
  return e.fav;
}

/* =========================================================== Bausteine */

const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NUM = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
const REL = new Intl.RelativeTimeFormat('de-DE', { numeric: 'auto' });
const DATE = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short' });

function when(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return 'gerade';
  if (d < 3600) return REL.format(-Math.round(d / 60), 'minute');
  if (d < 86400) return REL.format(-Math.round(d / 3600), 'hour');
  if (d < 7 * 86400) return REL.format(-Math.round(d / 86400), 'day');
  return DATE.format(t);
}

const PH = '<svg viewBox="0 0 24 24"><path d="M6 8h12l-1 11H7z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>';
const thumb = (url, cls = 'thumb') => url
  ? `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" decoding="async">`
  : `<span class="${cls} thumb-ph">${PH}</span>`;

const ICON = {
  star: '<svg viewBox="0 0 24 24"><path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.2-4.1 5.8-.8z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V3.8M8 7.4l4-3.9 4 3.9"/><path d="M8.5 10.5H7a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6.5a2 2 0 0 0-2-2h-1.5"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  seal: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  scan: '<svg viewBox="0 0 24 24"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M7 12h10"/></svg>'
};

function heroMarkup(v, title, sub, extra = '') {
  return `<div class="hero anim ${v.cls}" role="status">
    <div class="glyph"><svg viewBox="0 0 24 24" aria-hidden="true">${v.glyph}</svg></div>
    <h3>${esc(title)}</h3>${sub ? `<p class="sub">${sub}</p>` : ''}${extra}</div>`;
}

const SHORT = { vegan: 'Vegan', likely: 'Wahrscheinlich vegan', vegetarian: 'Vegetarisch', no: 'Nicht vegetarisch', unknown: 'Unklar' };

function productRow(p, v, withTime = false) {
  const verdict = VERDICTS[v] || VERDICTS.unknown;
  return `<li><button type="button" class="row" data-code="${esc(p.code)}">
    ${thumb(p.image_front_small_url || p.img)}
    <span class="row-text"><span>${p.fav ? '<span class="star">★</span> ' : ''}${esc(p.name || productTitle(p))}</span>
      <small><span class="t-${v}">${esc(SHORT[v] || verdict.title)}</span>${p.brands || p.brand ? ' · ' + esc((p.brands || p.brand).split(',')[0]) : ''}${p.t && withTime ? ' · ' + esc(when(p.t)) : ''}</small></span>
    <span class="chev"></span>
  </button></li>`;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2000);
}
const haptic = (ms = 12) => { if (navigator.vibrate) navigator.vibrate(ms); };

/* ================================================================= Sheet */

const sheet = $('#sheet');
const sheetBody = $('#sheet-body');
const stack = [];       // Ansichten im Sheet (für „Zurück“)

function showView(view) {
  $('#sheet-title').textContent = view.title || '';
  $('#sheet-actions').innerHTML = view.actions || '';
  $('#sheet-back').hidden = stack.length < 2;
  sheetBody.scrollTop = 0;
  sheetBody.innerHTML = '';
  view.render(sheetBody, view);
}

/* Zwei Arten: modal (normal) oder halbhoch über der laufenden Kamera –
   dann bleibt der Scanner aktiv und ein neuer Code ersetzt den Inhalt. */
function openSheet(view, { push = false, half = false } = {}) {
  if (!push) stack.length = 0;
  stack.push(view);
  showView(view);
  const wantModal = !half;
  if (sheet.open && sheet.classList.contains('half') === wantModal) {
    sheet.close();                       // Art wechseln
  }
  sheet.classList.toggle('half', half);
  document.body.classList.toggle('has-result', half);
  if (!sheet.open) {
    sheet.classList.remove('closing');
    if (half) sheet.show(); else sheet.showModal();
    document.body.classList.toggle('sheet-open', !half);
  }
}

function closeSheet() {
  if (!sheet.open || sheet.classList.contains('closing')) return;
  sheet.classList.add('closing');
  const done = () => {
    sheet.classList.remove('closing');
    sheet.style.transform = '';
    sheet.close();
    sheet.classList.remove('half', 'expanded');
    document.body.classList.remove('sheet-open', 'has-result');
    shownCode = '';
    stack.length = 0;
    if (location.search) history.replaceState(null, '', location.pathname);
  };
  matchMedia('(prefers-reduced-motion: reduce)').matches ? done() : setTimeout(done, 280);
}

$('#sheet-close').addEventListener('click', closeSheet);
// Tippen auf die Titelleiste schaltet das halbe Sheet zwischen halb und groß
$('.sheet-bar').addEventListener('click', (e) => {
  if (!e.target.closest('button') && sheet.classList.contains('half')) sheet.classList.toggle('expanded');
});
$('#sheet-back').addEventListener('click', () => { stack.pop(); showView(stack[stack.length - 1]); });
sheet.addEventListener('cancel', (e) => { e.preventDefault(); closeSheet(); });
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });

// Nach unten ziehen schließt – wie unter iOS.
(() => {
  let startY = null, dy = 0;
  const begin = (y) => { startY = y; dy = 0; sheet.classList.add('dragging'); };
  const move = (y) => {
    if (startY === null) return;
    dy = Math.max(0, y - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  };
  const end = () => {
    if (startY === null) return;
    sheet.classList.remove('dragging');
    startY = null;
    if (sheet.classList.contains('half') && sheet.classList.contains('expanded') && dy > 110) {
      sheet.classList.remove('expanded');          // groß → halb
      sheet.style.transform = '';
      return;
    }
    if (dy > 110) closeSheet();
    else { sheet.style.transition = 'transform .35s var(--ease)'; sheet.style.transform = ''; setTimeout(() => { sheet.style.transition = ''; }, 360); }
  };
  for (const el of [$('.sheet-grabber'), $('.sheet-bar')]) {
    el.addEventListener('touchstart', (e) => { if (!e.target.closest('button')) begin(e.touches[0].clientY); }, { passive: true });
  }
  sheetBody.addEventListener('touchstart', (e) => { if (sheetBody.scrollTop <= 0) begin(e.touches[0].clientY); }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    // Nach oben ziehen vergrößert das halbe Sheet
    if (sheet.classList.contains('half') && startY - e.touches[0].clientY > 50) {
      sheet.classList.add('expanded'); sheet.classList.remove('dragging'); startY = null; return;
    }
    if (e.touches[0].clientY < startY && dy === 0) { sheet.classList.remove('dragging'); startY = null; return; }
    move(e.touches[0].clientY);
  }, { passive: true });
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);
})();

/* ============================================================== Ergebnis */

const ALLERGENS = {
  'en:milk': 'Milch', 'en:eggs': 'Ei', 'en:gluten': 'Gluten', 'en:nuts': 'Schalenfrüchte',
  'en:peanuts': 'Erdnüsse', 'en:soybeans': 'Soja', 'en:fish': 'Fisch', 'en:crustaceans': 'Krebstiere',
  'en:molluscs': 'Weichtiere', 'en:celery': 'Sellerie', 'en:mustard': 'Senf',
  'en:sesame-seeds': 'Sesam', 'en:sulphur-dioxide-and-sulphites': 'Sulfite', 'en:lupin': 'Lupine'
};
function allergenNames(tags) {
  // Manche Einträge bündeln mehrere Tags in einem: „en:en:milk en:nuts en:soybeans“
  const split = (tags || []).flatMap((t) => t.split(/[\s,]+/)).filter((t) => /[a-z]{3,}/i.test(t));
  const out = split.map((t) => {
    const clean = 'en:' + t.replace(/^([a-z]{2}:\s*)+/i, '').trim();
    return ALLERGENS[clean] || clean.slice(3).replace(/-/g, ' ');
  }).filter(Boolean).map((n) => n.charAt(0).toUpperCase() + n.slice(1));
  return [...new Set(out)];
}

const NUTRIENTS = [
  ['energy-kcal', 'Energie', 'kcal'], ['fat', 'Fett', 'g'], ['saturated-fat', 'davon gesättigte Fettsäuren', 'g'],
  ['carbohydrates', 'Kohlenhydrate', 'g'], ['sugars', 'davon Zucker', 'g'], ['fiber', 'Ballaststoffe', 'g'],
  ['proteins', 'Eiweiß', 'g'], ['salt', 'Salz', 'g']
];

function detailsMarkup(p) {
  const n = p.nutriments || {};
  const rows = NUTRIENTS.filter(([k]) => typeof n[k + '_100g'] === 'number');
  const al = allergenNames(p.allergens_tags);
  const tr = allergenNames(p.traces_tags).filter((t) => !al.includes(t));
  const ns = (p.nutriscore_grade || '').toLowerCase();
  const scores = [
    /^[a-e]$/.test(ns) ? `<span class="score ns-${ns}">Nutri-Score <b>${ns.toUpperCase()}</b></span>` : '',
    p.nova_group ? `<span class="score">NOVA <b>${esc(p.nova_group)}</b></span>` : ''
  ].join('');
  const text = ingredientsText(p);
  if (!rows.length && !al.length && !tr.length && !scores && !text) return '';

  return `<details class="disclosure">
    <summary class="row"><span class="row-text"><span>Zutaten, Allergene & Nährwerte</span></span><span class="chev"></span></summary>
    ${scores ? `<div class="chips-row divided">${scores}</div>` : ''}
    ${al.length || tr.length ? `<ul class="list">
      ${al.length ? `<li><div class="static kv"><span class="k">Allergene</span><span class="v">${esc(al.join(', '))}</span></div></li>` : ''}
      ${tr.length ? `<li><div class="static kv"><span class="k">Spuren</span><span class="v">${esc(tr.join(', '))}</span></div></li>` : ''}
    </ul>` : ''}
    ${text ? `<div class="sub-head">Zutaten</div><p class="prose">${esc(text)}</p>` : ''}
    ${rows.length ? `<div class="sub-head">Nährwerte je 100 g</div><ul class="list">${rows.map(([k, name, unit]) => `
      <li><div class="static kv${name.startsWith('davon') ? ' sub' : ''}"><span class="k">${esc(name)}</span><span class="v">${NUM.format(n[k + '_100g'])} ${unit}</span></div></li>`).join('')}</ul>` : ''}
  </details>`;
}

function skeleton(body) {
  body.innerHTML = `
    <div class="hero"><div class="sk sk-circle"></div><div class="sk sk-line"></div><div class="sk sk-line short"></div></div>
    <div class="product-card"><div class="product-head"><div class="sk sk-thumb"></div><div class="sk-text"><div class="sk"></div><div class="sk"></div></div></div></div>`;
}

function productView(code) {
  return {
    title: '',
    render(body, view) {
      const cached = cacheRead(code);
      if (cached) { renderProduct(body, view, code, cached); return; }
      skeleton(body);
      fetchProduct(code).then((p) => {
        if (stack[stack.length - 1] !== view) return;      // inzwischen weiter navigiert
        if (p) renderProduct(body, view, code, p);
        else renderNotFound(body, code);
      }, () => {
        if (stack[stack.length - 1] !== view) return;
        body.innerHTML = heroMarkup(VERDICTS.unknown, 'Keine Verbindung',
          'Die Datenbank antwortet gerade nicht.', `<div><button class="btn" type="button" data-retry="${esc(code)}">Erneut versuchen</button></div>`);
      });
    }
  };
}

function renderProduct(body, view, code, p) {
  const { verdict, reasons, veganLabel } = assess(p);
  const meta = [p.brands && p.brands.split(',')[0], p.quantity].filter(Boolean).join(' · ');
  const sourceNote = p._source && p._source !== 'Open Food Facts' ? `<br><small>Quelle: ${esc(p._source)}</small>` : '';
  $('#sheet-title').textContent = productTitle(p);
  haptic(verdict.key === 'vegan' || verdict.key === 'likely' ? 15 : [20, 60, 20]);

  body.innerHTML = `
    ${heroMarkup(verdict, verdict.title, esc(verdict.sub), veganLabel ? `<div><span class="seal">${ICON.seal}Vegan-Siegel</span></div>` : '')}
    <div class="product-card anim">
      <div class="product-head">${thumb(p.image_front_small_url || p.image_front_url)}
        <div><div class="name">${esc(productTitle(p))}</div><div class="meta">${esc(meta || 'Barcode ' + code)}${sourceNote}</div></div>
      </div>
      ${reasons.length ? `<ul class="reasons">${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    </div>
    <div class="actions">
      <button type="button" class="action" data-fav="${esc(code)}" aria-pressed="${isFav(code)}">${ICON.star}<span>${isFav(code) ? 'Gemerkt' : 'Merken'}</span></button>
      <button type="button" class="action" data-share="${esc(code)}">${ICON.share}<span>Teilen</span></button>
      <a class="action" href="${esc(p._site || 'https://de.openfoodfacts.org')}${p._source === 'USDA FoodData Central' ? '' : '/produkt/' + encodeURIComponent(code)}" target="_blank" rel="noopener">${ICON.edit}<span>${p._source === 'USDA FoodData Central' ? 'Quelle' : 'Korrigieren'}</span></a>
    </div>
    <section id="alts-wrap" hidden><span class="section-title">Vegane Alternativen</span><div class="alts" id="alts"></div></section>
    ${detailsMarkup(p)}
    <p class="footnote">Ohne Gewähr – Rezepturen ändern sich. Im Zweifel die Verpackung lesen.</p>`;

  addHistory(code, p, verdict.key);
  view.product = p;
  if (!ingredientsText(p) && !(p.ingredients || []).length && p.image_ingredients_url && !p._ocrTried) readPhoto(code, p, view);
  else if (verdict.key === 'unknown' && !p._similar && !p._similarTried) askSimilar(code, p, view);
  if (verdict.key !== 'vegan' && verdict.key !== 'likely') loadAlternatives(p, view);
}

/* Viele Produkte haben ein Foto der Zutatenliste, aber keinen abgetippten Text.
   Dann liest Tesseract es direkt im Browser – erst bei Bedarf geladen. */
let ocrWorker = null;
async function readPhoto(code, p, view) {
  const card = $('.product-card', sheetBody);
  const note = document.createElement('p');
  note.className = 'ocr-note';
  note.innerHTML = '<span class="spinner"></span>Lese das Foto der Zutatenliste …';
  if (card) card.appendChild(note);
  p._ocrTried = true;
  try {
    if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
    if (!ocrWorker) ocrWorker = await Tesseract.createWorker(['deu', 'eng']);
    const url = p.image_ingredients_url.replace(/\.\d+\.jpg$/, '.full.jpg');
    const { data } = await ocrWorker.recognize(url);
    const text = cleanOcr(data.text || '');
    if (text) { p._ocr = text; cacheWrite(code, p); }
  } catch (_) { /* Foto nicht lesbar – Ergebnis bleibt */ }
  if (stack[stack.length - 1] !== view) return;
  if (p._ocr) renderProduct(sheetBody, view, code, p);
  else { note.remove(); if (assess(p).verdict.key === 'unknown') askSimilar(code, p, view); }
}

/** Immer noch unklar? Gleichnamige Produkte befragen – nur bei klarer Mehrheit. */
async function askSimilar(code, p, view) {
  p._similarTried = true;
  const stop = new Set(['bio', 'mit', 'und', 'der', 'die', 'das', 'von', 'für']);
  const words = productTitle(p).toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length >= 3 && !stop.has(w)).slice(0, 3);
  if (!words.length) return;
  try {
    const hits = await searchProducts(words.join(' '), [['countries', 'en:germany']], 20);
    const rated = hits.filter((x) => x.code !== p.code).map(quickVerdict).filter((v) => v !== 'unknown')
      .map((v) => (v === 'likely' ? 'vegan' : v));
    if (rated.length < 3) return;
    const counts = {};
    rated.forEach((v) => { counts[v] = (counts[v] || 0) + 1; });
    const [key, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (n / rated.length < 0.75) return;
    p._similar = { key, count: n, total: rated.length };
    cacheWrite(code, p);
    if (stack[stack.length - 1] === view) renderProduct(sheetBody, view, code, p);
  } catch (_) { /* Suche überlastet – bleibt „Unklar“ */ }
}

/** Nur den Teil ab „Zutaten:“ behalten, Nährwerte usw. abschneiden. */
function cleanOcr(raw) {
  let t = raw.replace(/\s+/g, ' ');
  const start = t.search(/(zutaten|ingredients|ingrédients)\s*:/i);
  if (start >= 0) t = t.slice(start).replace(/^[^:]*:/, '');
  const end = t.search(/(nährwert|durchschnittlich|nutrition|mindestens haltbar|kann spuren)/i);
  if (end > 0) t = t.slice(0, end);
  t = t.trim();
  return t.length >= 8 ? t : '';
}

async function loadAlternatives(p, view) {
  const cats = (p.categories_hierarchy || p.categories_tags || []).filter((c) => c.startsWith('en:'));
  const cat = cats[cats.length - 1];
  if (!cat) return;
  try {
    const items = (await searchProducts('', [['labels', 'en:vegan'], ['categories', cat]], 12))
      .filter((x) => x.code !== p.code).slice(0, 8);
    if (!items.length || stack[stack.length - 1] !== view) return;
    $('#alts').innerHTML = items.map((x) => `
      <button type="button" class="alt" data-code="${esc(x.code)}">
        ${x.image_front_small_url ? `<img src="${esc(x.image_front_small_url)}" alt="" loading="lazy">` : '<span class="ph"></span>'}
        <span class="t">${esc(productTitle(x))}</span><small>${esc((x.brands || '').split(',')[0])}</small>
      </button>`).join('');
    $('#alts-wrap').hidden = false;
  } catch (_) { /* Alternativen sind nur ein Extra */ }
}

function renderNotFound(body, code) {
  $('#sheet-title').textContent = 'Nicht gefunden';
  body.innerHTML = `
    ${heroMarkup(VERDICTS.unknown, 'Noch nicht erfasst',
      `Barcode ${esc(code)} steht in keiner der offenen Datenbanken. Prüfe die Zutatenliste selbst – das geht in Sekunden.`)}
    <div class="btn-col">
      <button type="button" class="btn wide" data-open="ingredients">Zutatenliste prüfen</button>
      <a class="btn secondary wide" href="https://de.openfoodfacts.org/cgi/product.pl?type=add&code=${encodeURIComponent(code)}" target="_blank" rel="noopener">Produkt eintragen</a>
    </div>
    <p class="footnote">Gesucht in Open Food Facts, Open Beauty Facts, Open Pet Food Facts, Open Products Facts und USDA FoodData Central.</p>`;
  haptic([20, 60, 20]);
}

let shownCode = '';

function check(code) {
  $('#q').blur();
  shownCode = code;
  history.replaceState(null, '', `${location.pathname}?code=${code}`);
  // Läuft die Kamera, bleibt sie an: Ergebnis halbhoch darüber.
  openSheet(productView(code), { half: !!stream });
}

/* ========================================================= Weitere Sheets */

let historyFilter = 'all';
function historyView() {
  return {
    title: 'Verlauf',
    render(body) {
      const all = loadHistory();
      if (!all.length) {
        body.innerHTML = `<div class="empty"><b>Noch nichts geprüft</b>Gescannte Produkte erscheinen hier.</div>`;
        return;
      }
      const counts = (k) => all.filter((e) => e.v === k).length;
      const vegan = counts('vegan') + counts('likely');
      const shown = historyFilter === 'fav' ? all.filter((e) => e.fav)
        : historyFilter === 'vegan' ? all.filter((e) => e.v === 'vegan' || e.v === 'likely') : all;
      body.innerHTML = `
        <div class="segmented" role="group" aria-label="Filter">
          ${[['all', `Alle (${all.length})`], ['vegan', `Vegan (${vegan})`], ['fav', `Favoriten (${all.filter((e) => e.fav).length})`]]
            .map(([k, l]) => `<button type="button" data-filter="${k}" aria-pressed="${historyFilter === k}">${l}</button>`).join('')}
        </div>
        ${shown.length ? `<ul class="list thumbs">${shown.map((e) => productRow(e, e.v, true)).join('')}</ul>`
          : `<div class="empty">${historyFilter === 'fav' ? 'Tippe im Ergebnis auf „Merken“, um Produkte hier zu sammeln.' : 'Keine Einträge.'}</div>`}
        <div class="btn-col"><button type="button" class="btn secondary wide" data-clear style="color:var(--red-ink)">Verlauf löschen</button></div>`;
    }
  };
}

const LEVEL_TEXT = { no: 'nicht vegetarisch', veg: 'nicht vegan', maybe: 'unklar' };
const LEVEL_DOT = { no: 'no', veg: 'vegetarian', maybe: 'unknown' };

function ingredientsView() {
  return {
    title: 'Zutatenliste prüfen',
    render(body) {
      body.innerHTML = `
        <textarea id="ing-text" class="textarea" placeholder="Zutaten einfügen oder abtippen, z. B. Weizenmehl, Zucker, Vollmilchpulver, E471"></textarea>
        <p class="footnote">Tipp fürs iPhone: lange ins Feld tippen → „Text scannen“ und die Kamera auf die Verpackung halten. Geprüft wird auf dem Gerät, auch ohne Netz.</p>
        <div id="ing-result"></div>
        <details class="disclosure">
          <summary class="row"><span class="row-text"><span>E-Nummern tierischen Ursprungs</span></span><span class="chev"></span></summary>
          <ul class="list">${Object.entries(RULES.E)
            .sort((a, b) => 'nvm'.indexOf(a[1][0][0]) - 'nvm'.indexOf(b[1][0][0]) || parseInt(a[0].slice(1)) - parseInt(b[0].slice(1)))
            .map(([k, [lvl, name]]) => `<li><div class="static"><span class="dot d-${LEVEL_DOT[lvl]}"></span>
              <span class="row-text"><span>${k}</span><small>${esc(name)}</small></span><span class="row-meta">${LEVEL_TEXT[lvl]}</span></div></li>`).join('')}
          </ul>
        </details>`;
      const ta = $('#ing-text', body);
      ta.addEventListener('input', () => renderIngredientResult(ta.value));
      setTimeout(() => ta.focus({ preventScroll: true }), 350);
    }
  };
}

function renderIngredientResult(text) {
  const box = $('#ing-result');
  if (!text.trim()) { box.innerHTML = ''; return; }
  let { level, hits } = RULES.analyze(text);
  if (level === 'unknown' && hits.every((h) => MOSTLY_PLANT.test(h.text) || MOSTLY_PLANT.test(h.note))) level = 'likely';
  const v = VERDICTS[level];
  box.innerHTML = `<div class="hero ${v.cls}"><div class="glyph"><svg viewBox="0 0 24 24">${v.glyph}</svg></div>
      <h3>${esc(v.title)}</h3><p class="sub">${hits.length ? hits.length + ' auffällige Zutat' + (hits.length > 1 ? 'en' : '') : 'Keine tierischen Zutaten gefunden'}</p></div>
    ${hits.length ? `<ul class="list" style="margin-top:16px">${hits.map((h) => `
      <li><div class="static"><span class="dot d-${LEVEL_DOT[h.level]}"></span>
        <span class="row-text"><span>${esc(h.text)}</span><small>${esc(h.note)}</small></span></div></li>`).join('')}</ul>` : ''}`;
}

function infoView() {
  return {
    title: 'Über VeganCheck',
    render(body) {
      body.innerHTML = `
        <section><span class="section-title">Ergebnisse</span><ul class="list">
          ${['vegan', 'likely', 'vegetarian', 'no', 'unknown'].map((k) => `<li><div class="static"><span class="dot d-${k}"></span>
            <span class="row-text"><span>${VERDICTS[k].title}</span><small>${{
              vegan: 'Siegel oder alle Zutaten pflanzlich', likely: 'Nur Aroma, Lecithin & Co. offen',
              vegetarian: 'Enthält z. B. Milch, Ei oder Honig', no: 'Fleisch, Fisch, Gelatine …', unknown: 'Zu wenige Angaben'
            }[k]}</small></span></div></li>`).join('')}
        </ul></section>
        <section><span class="section-title">Daten</span><ul class="list"><li><p class="prose" style="color:var(--label)">
          Open Food Facts, Open Beauty Facts, Open Pet Food Facts, Open Products Facts (ODbL) und USDA FoodData Central.
          Fehlt eine Analyse, prüft VeganCheck den Zutatentext selbst.</p></li></ul></section>
        <section><span class="section-title">Hinweise</span><ul class="list"><li><p class="prose">
          Keine Garantie: Rezepturen ändern sich, Einträge können fehlerhaft sein. Im Zweifel die Verpackung lesen – besonders bei Allergien.
          Keine Tracker, keine Cookies. Verlauf und Zwischenspeicher bleiben auf diesem Gerät.</p></li></ul></section>
        <p class="footnote">Tipp: „Teilen → Zum Home-Bildschirm“ macht VeganCheck zur App.</p>`;
    }
  };
}

/* ============================================================ Startseite */

function renderRecent() {
  const list = loadHistory();
  $('#recent-wrap').hidden = !list.length;
  $('#recent').className = 'list thumbs';
  $('#recent').innerHTML = list.slice(0, 5).map((e) => productRow(e, e.v)).join('');
}

/* Ein Feld für alles: Ziffern → Barcode prüfen, Text → Suche. */
const q = $('#q');
let searchCtl = null, searchTimer = null;

function setSearchMode(on) {
  $('#home').hidden = on;
  $('#search').hidden = !on;
  // Wie unter iOS: beim Suchen rückt das Feld nach oben, die Kamera macht Platz.
  if (on) closeScanner();
  camera.classList.toggle('collapsed', on);
  $('#btn-clear').hidden = !q.value;
}

function onQuery(immediate) {
  const value = q.value.trim();
  clearTimeout(searchTimer);
  if (searchCtl) searchCtl.abort();
  setSearchMode(!!value);
  if (!value) return;
  const box = $('#search');
  const digits = value.replace(/[\s-]/g, '');

  if (/^\d+$/.test(digits)) {
    box.innerHTML = `<ul class="list icons"><li><button type="button" class="row" data-code="${esc(digits)}" ${digits.length < 8 || digits.length > 14 ? 'disabled style="opacity:.5"' : ''}>
      <span class="row-icon ri-green">${ICON.scan}</span>
      <span class="row-text"><span>Barcode ${esc(digits)} prüfen</span><small>${digits.length < 8 || digits.length > 14 ? 'Barcodes haben 8 bis 14 Ziffern' : 'Eingabetaste oder tippen'}</small></span>
      <span class="chev"></span></button></li></ul>`;
    if (immediate && digits.length >= 8 && digits.length <= 14) check(digits);
    return;
  }

  // Treffer aus dem eigenen Verlauf sofort zeigen
  const needle = value.toLowerCase();
  const local = loadHistory().filter((e) => (e.name + ' ' + (e.brand || '')).toLowerCase().includes(needle)).slice(0, 4);
  const localHtml = local.length ? `<div class="group-head" style="padding-top:0"><h2>Im Verlauf</h2></div>
    <ul class="list thumbs">${local.map((e) => productRow(e, e.v)).join('')}</ul>` : '';
  if (value.length < 2) { box.innerHTML = localHtml; return; }

  box.innerHTML = localHtml + `<div class="group-head" style="padding-top:${local.length ? 22 : 0}px"><h2>Produkte</h2></div>
    <div id="remote" class="list"><div class="searching"><span class="spinner"></span>Suche …</div></div>`;

  searchTimer = setTimeout(async () => {
    const ctl = searchCtl = new AbortController();
    try {
      const items = await searchProducts(value, [['countries', 'en:germany']], 24, ctl.signal);
      if (ctl !== searchCtl) return;
      const remote = $('#remote');
      if (!remote) return;
      remote.outerHTML = items.length
        ? `<ul class="list thumbs" id="remote">${items.map((p) => productRow(p, quickVerdict(p))).join('')}</ul>`
        : `<div class="list" id="remote"><div class="empty"><b>Keine Treffer</b>Anders schreiben oder den Barcode scannen.</div></div>`;
    } catch (err) {
      if (err.name === 'AbortError' || ctl !== searchCtl) return;
      const remote = $('#remote');
      if (remote) remote.outerHTML = `<div class="list" id="remote"><div class="empty"><b>Suche überlastet</b>
        Open Food Facts lässt gerade keine Suche zu. Barcode scannen klappt weiterhin.<br><br>
        <button type="button" class="btn secondary" data-research>Erneut suchen</button></div></div>`;
    }
  }, immediate ? 0 : 450);
}

q.addEventListener('input', () => onQuery(false));
$('#query-form').addEventListener('submit', (e) => { e.preventDefault(); onQuery(true); });
$('#btn-clear').addEventListener('click', () => { q.value = ''; onQuery(false); q.focus(); });

/* ================================================================ Klicks */

document.addEventListener('click', (e) => {
  const t = e.target;
  let el;
  if ((el = t.closest('[data-code]'))) {
    const inSheet = sheet.contains(el);
    if (inSheet) { openSheet(productView(el.dataset.code), { push: true }); return; }
    check(el.dataset.code);
  } else if ((el = t.closest('[data-open]'))) {
    const view = { ingredients: ingredientsView, history: historyView, info: infoView }[el.dataset.open]();
    openSheet(view, { push: sheet.open });
  } else if ((el = t.closest('[data-fav]'))) {
    const on = toggleFav(el.dataset.fav);
    el.setAttribute('aria-pressed', on);
    el.querySelector('span').textContent = on ? 'Gemerkt' : 'Merken';
    haptic();
    toast(on ? 'Gemerkt' : 'Nicht mehr gemerkt');
  } else if ((el = t.closest('[data-share]'))) {
    share(el.dataset.share);
  } else if ((el = t.closest('[data-retry]'))) {
    showView(stack[stack.length - 1]);
  } else if (t.closest('[data-research]')) {
    searchCache.clear();
    onQuery(true);
  } else if ((el = t.closest('[data-filter]'))) {
    historyFilter = el.dataset.filter;
    showView(stack[stack.length - 1]);
  } else if (t.closest('[data-clear]')) {
    if (confirm('Gesamten Verlauf inklusive Favoriten löschen?')) { saveHistory([]); showView(stack[stack.length - 1]); }
  }
});

$('#btn-all').addEventListener('click', () => openSheet(historyView()));
$('#btn-info').addEventListener('click', () => openSheet(infoView()));

async function share(code) {
  const view = stack[stack.length - 1];
  const p = view && view.product;
  const url = `${location.origin}${location.pathname}?code=${code}`;
  const text = p ? `${productTitle(p)}: ${assess(p).verdict.title}` : 'VeganCheck';
  try {
    if (navigator.share) await navigator.share({ title: 'VeganCheck', text, url });
    else { await navigator.clipboard.writeText(`${text} – ${url}`); toast('Link kopiert'); }
  } catch (_) {}
}

// Kleine Titelleiste erscheint, sobald die große Überschrift wegscrollt.
const navbar = $('#navbar');
addEventListener('scroll', () => navbar.classList.toggle('show', scrollY > 52), { passive: true });

/* =============================================================== Scanner */

const camera = $('#camera');
const video = $('#video');
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'itf'];
// Zeilenweise Leser sehen nur ungefähr waagerechte Codes. Die meisten liegen
// waagerecht, also kommt 0° jedes zweite Mal dran; 90°/45°/135° decken den Rest.
const ANGLES = [0, 90, 0, 45, 0, 135];
let stream = null, loop = null, torchTrack = null;
const frame = document.createElement('canvas');

function grab(angle) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  // Nur den Bereich um den Rahmen lesen – schneller und weniger Fehltreffer.
  // Bei offenem Ergebnis sitzt der Rahmen in der oberen Hälfte.
  const upper = document.body.classList.contains('has-result');
  const cw = vw * 0.86, ch = vh * (upper ? 0.42 : 0.6), sx = (vw - cw) / 2, sy = upper ? vh * 0.04 : (vh - ch) / 2;
  const scale = Math.min(1, 720 / Math.max(cw, ch));
  const w = Math.round(cw * scale), h = Math.round(ch * scale);
  frame.width = angle === 90 ? h : w;
  frame.height = angle === 90 ? w : h;
  const ctx = frame.getContext('2d', { willReadFrequently: true });
  ctx.save();
  ctx.translate(frame.width / 2, frame.height / 2);
  ctx.rotate(-angle * Math.PI / 180);
  ctx.drawImage(video, sx, sy, cw, ch, -w / 2, -h / 2, w, h);
  ctx.restore();
  return frame;
}

function setStatus(text) {
  let el = $('.camera-status', camera);
  if (!el) { el = document.createElement('div'); el.className = 'camera-status'; camera.appendChild(el); }
  el.textContent = text;
}

function closeScanner() {
  const wasLive = !!stream;
  camera.classList.remove('live', 'hit');
  document.body.classList.remove('scanning');
  if (wasLive && sheet.open && sheet.classList.contains('half')) {
    // Ergebnis bleibt offen, jetzt als normales Sheet
    sheet.close(); sheet.classList.remove('half');
    document.body.classList.remove('has-result');
    sheet.showModal(); document.body.classList.add('sheet-open');
  }
  $('#btn-torch').hidden = true;
  torchTrack = null;
  if (loop) { clearTimeout(loop); loop = null; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  video.srcObject = null;
}

let lastHit = { code: '', t: 0 };

/** Treffer: Ergebnis zeigen, Kamera läuft weiter. Gibt nie „stopp“ zurück. */
function detected(raw) {
  const code = String(raw || '').replace(/\D/g, '');
  if (code.length < 8 || code === shownCode) return false;
  if (code === lastHit.code && Date.now() - lastHit.t < 2500) return false;
  lastHit = { code, t: Date.now() };
  camera.classList.add('hit');
  setTimeout(() => camera.classList.remove('hit'), 450);
  haptic(40);
  fetchProduct(code).catch(() => {});       // Abfrage sofort starten
  setTimeout(() => check(code), 120);
  return false;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function zxingLoop() {
  if (!window.ZXing) await loadScript('vendor/zxing-0.21.3.min.js');
  const Z = window.ZXing;
  const reader = new Z.MultiFormatReader();
  reader.setHints(new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, [
    Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E,
    Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.ITF]]]));
  let turn = 0;
  const tick = () => {
    if (!stream) return;
    {
      const c = grab(ANGLES[turn]);
      if (c) {
        try {
          const hit = reader.decodeWithState(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(c))));
          if (hit && detected(hit.getText())) return;
        } catch (_) { /* kein Code in diesem Bild */ } finally { reader.reset(); }
      }
      turn = (turn + 1) % ANGLES.length;
    }
    loop = setTimeout(tick, 40);
  };
  loop = setTimeout(tick, 40);
}

async function nativeLoop() {
  const supported = await BarcodeDetector.getSupportedFormats();
  const formats = FORMATS.filter((f) => supported.includes(f));
  if (!formats.length) return zxingLoop();
  const detector = new BarcodeDetector({ formats });
  let turn = 0;
  const tick = async () => {
    if (!stream) return;
    try {
      const angle = ANGLES[turn];
      const hits = await detector.detect(angle === 0 ? video : grab(angle));
      if (hits.length && detected(hits[0].rawValue)) return;
    } catch (_) {}
    turn = (turn + 1) % ANGLES.length;
    if (stream) loop = setTimeout(tick, 40);
  };
  loop = setTimeout(tick, 40);
}

async function openScanner() {
  if (stream) return;
  const hint = $('#cam-hint');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !isSecureContext) {
    hint.textContent = 'Kamera nicht verfügbar – Nummer unten eintippen';
    return;
  }
  hint.textContent = 'Kamera wird gestartet …';
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, focusMode: 'continuous' },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    camera.classList.add('live');
    document.body.classList.add('scanning');
    setStatus('Barcode in den Rahmen halten');
    hint.textContent = 'Tippen, um die Kamera zu starten';
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    torchTrack = 'torch' in caps ? track : null;
    $('#btn-torch').hidden = !torchTrack;
    if ('BarcodeDetector' in window) await nativeLoop(); else await zxingLoop();
  } catch (err) {
    closeScanner();
    hint.textContent = err && err.name === 'NotAllowedError'
      ? 'Kein Kamerazugriff – in den Einstellungen erlauben oder Nummer eintippen'
      : 'Kamera nicht verfügbar – Nummer unten eintippen';
  }
}

$('#btn-start').addEventListener('click', openScanner);
$('#btn-stop').addEventListener('click', closeScanner);
$('#btn-torch').addEventListener('click', async () => {
  if (!torchTrack) return;
  const btn = $('#btn-torch');
  const on = btn.getAttribute('aria-pressed') !== 'true';
  try { await torchTrack.applyConstraints({ advanced: [{ torch: on }] }); btn.setAttribute('aria-pressed', on); } catch (_) {}
});
document.addEventListener('visibilitychange', () => { if (document.hidden) closeScanner(); });

/* ================================================================= Start */

renderRecent();
function route() {
  const code = new URLSearchParams(location.search).get('code');
  if (code && /^\d{6,14}$/.test(code)) check(code);
  else if (location.hash === '#history') openSheet(historyView());
  else if (location.hash === '#ingredients') openSheet(ingredientsView());
  else return;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}
route();
addEventListener('hashchange', route);

if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
