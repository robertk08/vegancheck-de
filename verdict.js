/* Einstufung: vegan / wahrscheinlich vegan / vegetarisch / nicht vegetarisch / unklar.
   Siegel schlagen die Zutatenanalyse von Open Food Facts; fehlt sie, prüft rules.js
   den Zutatentext, und ohne Zutaten geben Name oder Kategorie den Ausschlag. */
'use strict';

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
const CAT_PLANT = /^en:(fruits|vegetables|.*-vegetables|fresh-fruits|legumes|plant-based-.*|cereals-and-potatoes|pastas|rices|nuts|seeds|vegetable-oils|olive-oils|.*-oils|sugars|coffees|teas|waters|.*-waters|fruit-juices|juices|.*-juices|soft-drinks|flours|spices|salts|jams|meat-alternatives|dark-chocolates|tofu|breads|hard-liquors|gins|vodkas|rums|whiskies|brandys|eaux-de-vie|beers|lagers)$/;

function categoryHint(product) {
  const cats = product.categories_tags || [];
  if (cats.some((c) => CAT_NO.test(c))) return 'no';
  if (cats.some((c) => CAT_VEG.test(c))) return 'vegetarian';
  if (cats.some((c) => CAT_PLANT.test(c))) return 'likely';
  return null;
}

/**
 * Rückfall ohne Zutatenliste: Was verraten Name, Sachbezeichnung und Kategorien?
 * „6 Bio-Eier“ → vegetarisch, „Hähnchenbrustfilet“ → nicht vegetarisch,
 * „Vegane Pommersche“ → wahrscheinlich vegan. Ergebnis: { key, reason } oder null.
 */
function fallbackHint(product) {
  const name = [productTitle(product), product.generic_name_de, product.generic_name].filter(Boolean).join(', ');
  if (/\b(vegan|pflanzlich|plant[- ]based)/i.test(name)) return { key: 'likely', reason: '„Vegan“ bzw. „pflanzlich“ steht im Produktnamen.' };
  const byName = RULES.analyze(name.replace(/[-/]/g, ' '));
  if (byName.level === 'no' || byName.level === 'vegetarian') {
    return { key: byName.level, reason: `Laut Produktname: ${byName.hits.filter((h) => h.level !== 'maybe').map((h) => h.text).join(', ')}.` };
  }
  const cat = categoryHint(product);
  // „Gnocchi mit Rucolacreme“: Kategorie pflanzlich, Gericht aber womöglich mit Sahne
  if (cat && !(cat === 'likely' && RULES.isComposite(name))) return { key: cat, reason: 'Abgeleitet aus der Produktkategorie.' };
  // Kategorien in anderen Sprachen (z. B. „de:eier-aus-ökologischer-erzeugung“) als Text prüfen
  const catText = (product.categories_tags || []).map((c) => c.replace(/^[a-z]{2}:/, '').replace(/-/g, ' ')).join(', ');
  const byCat = RULES.analyze(catText);
  if (byCat.level === 'no' || byCat.level === 'vegetarian') return { key: byCat.level, reason: 'Abgeleitet aus der Produktkategorie.' };
  // Von Natur aus pflanzlich? („Kiwi“, „Olivenöl“, „Basmati Reis“)
  const plant = RULES.plantFood(name);
  if (plant && plant.fined) return { key: 'unknown', reason: 'Wein und Sekt werden oft mit Gelatine, Kasein oder Eiweiß geklärt – das steht nicht auf dem Etikett.' };
  if (plant) return { key: 'likely', reason: 'Laut Produktname ein pflanzliches Lebensmittel.' };
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

/** „MAGERMILCHPULVER“ → „Magermilchpulver“ */
function niceName(name) {
  const n = name === name.toUpperCase() ? name.toLowerCase() : name;
  return n.charAt(0).toUpperCase() + n.slice(1);
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
    names.push(niceName(name));
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
      const named = new Set(bad.map((n) => n.toLowerCase()));
      const maybeMeat = ingredientsWith(product, 'vegetarian', 'maybe')
        .filter((n) => !named.has(n.toLowerCase()));
      // Offen sind nur Lecithin, Aroma & Co.: so gut wie immer vegetarisch.
      const mostlyVeg = maybeMeat.every((n) => MOSTLY_PLANT.test(n));
      verdict = mostlyVeg ? VERDICTS.vegetarian
        : Object.assign({}, VERDICTS.vegetarian, { title: 'Nicht vegan', sub: 'Vegetarisch unklar' });
      if (bad.length) reasons.push('Nicht vegan wegen: ' + bad.join(', ') + '.');
      if (maybeMeat.length && !mostlyVeg) reasons.push('Unklar, ob vegetarisch: ' + maybeMeat.join(', ') + '.');
    }
  } else if (veganTag === 'unknown' && vegetarianTag !== 'no' && ingredientsText(product)) {
    // Open Food Facts hat nicht analysiert – Zutatentext selbst prüfen.
    const local = RULES.analyze(ingredientsText(product));
    verdict = VERDICTS[local.level];
    if (local.level === 'unknown' && local.hits.every((h) => MOSTLY_PLANT.test(h.note) || MOSTLY_PLANT.test(h.text))) {
      verdict = VERDICTS.likely;
    }
    // Aus einem Foto gelesen: Texterkennung kann Wörter verschlucken – nie mehr als „wahrscheinlich“.
    if (verdict.key === 'vegan' && product._ocr && !product.ingredients_text) verdict = VERDICTS.likely;
    // Wein & Co.: Klärhilfen stehen nicht in der Zutatenliste
    if ((local.level === 'vegan' || local.level === 'unknown') && RULES.isFined(productTitle(product) + ' ' + (product.categories_tags || []).join(' '))) {
      verdict = Object.assign({}, VERDICTS.unknown, { sub: 'Klärung unbekannt' });
      reasons.push('Wein und Sekt werden oft mit Gelatine, Kasein oder Eiweiß geklärt – das steht nicht auf dem Etikett.');
      return { verdict, reasons, veganLabel };
    }
    const names = (lvl) => local.hits.filter((h) => h.level === lvl).map((h) => h.text).slice(0, 8);
    if (local.level === 'vegan') reasons.push('Keine tierischen Zutaten im Zutatentext gefunden.');
    if (names('no').length) reasons.push('Nicht vegetarisch wegen: ' + names('no').join(', ') + '.');
    if (names('veg').length) reasons.push('Nicht vegan wegen: ' + names('veg').join(', ') + '.');
    if (names('maybe').length) reasons.push('Nicht eindeutig: ' + names('maybe').join(', ') + '.');
    reasons.push(product._ocr && !product.ingredients_text ? 'Aus dem Foto der Zutatenliste gelesen.' : 'Eigene Auswertung des Zutatentexts.');
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
      const hint = !(product.ingredients || []).length ? fallbackHint(product) : null;
      if (maybe.length && maybe.every((m) => MOSTLY_PLANT.test(m)) && vegetarianTag !== 'maybe') {
        verdict = VERDICTS.likely;
        reasons.push('Nur ' + maybe.join(', ') + ' könnte tierisch sein – ist aber fast immer pflanzlich.');
      } else if (hint) {
        // Keine Zutaten: Name oder Kategorie geben den Ausschlag.
        verdict = VERDICTS[hint.key];
        reasons.push(hint.reason);
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

  // Zutaten da, aber nicht auswertbar: eindeutige Kategorien (Käse, Fleisch, Fisch) entscheiden trotzdem.
  if (verdict.key === 'unknown') {
    const cat = categoryHint(product);
    if (cat === 'no' || cat === 'vegetarian') {
      verdict = VERDICTS[cat];
      reasons.push('Abgeleitet aus der Produktkategorie.');
    }
  }
  // Nichts Belastbares gefunden: Wie sind gleichnamige Produkte eingestuft?
  const sim = product._similar;
  if (verdict.key === 'unknown' && sim) {
    verdict = Object.assign({}, VERDICTS[sim.key === 'vegan' ? 'likely' : sim.key], { sub: 'Laut ähnlichen Produkten' });
    reasons.unshift(`${sim.count} von ${sim.total} gleichnamigen Produkten sind ${sim.key === 'vegan' ? 'vegan' : VERDICTS[sim.key].title.toLowerCase()}.`);
  }
  return { verdict, reasons, veganLabel };
}

function productTitle(p) {
  return p.product_name_de || p.product_name || 'Unbekanntes Produkt';
}

function ingredientsText(product) {
  const text = product.ingredients_text_de || product.ingredients_text || product._ocr || '';
  // Open Food Facts markiert Allergene mit Unterstrichen (_Milch_).
  return text.replace(/_/g, '').replace(/\s+/g, ' ').trim();
}

/** Schnelle Einstufung für Suchtreffer (ohne Zutatenliste). */
function quickVerdict(p) {
  const l = p.labels_tags || [], t = p.ingredients_analysis_tags || [];
  if (l.includes('en:vegan') || t.includes('en:vegan')) return 'vegan';
  if (t.includes('en:non-vegetarian')) return 'no';
  if (t.includes('en:non-vegan') && (t.includes('en:vegetarian') || l.includes('en:vegetarian'))) return 'vegetarian';
  if (t.includes('en:maybe-vegan') && t.includes('en:vegetarian')) return 'likely';
  return 'unknown';
}
