/* Lokale Zutatenprüfung ohne Datenbank: Schlüsselwörter und E-Nummern.
   Wird vom Zutaten-Check genutzt und dient als Rückfall, wenn Open Food Facts
   keine Analyse liefert. Die Listen sind bewusst knapp und deutschsprachig. */
'use strict';

const RULES = (() => {
  // Tierisch, nicht vegetarisch: Fleisch, Fisch, Schlachtnebenprodukte.
  const MEAT = [
    'fleisch', 'rind', 'schwein', 'kalb', 'lamm', 'hammel', 'huhn', 'hähnchen', 'hühnchen',
    'pute', 'truthahn', 'ente', 'gans', 'wildschwein', 'speck', 'schinken', 'salami', 'wurst',
    'schmalz', 'talg', 'gelatine', 'fisch', 'lachs', 'thunfisch', 'sardelle', 'anchovis',
    'hering', 'makrele', 'kabeljau', 'garnele', 'shrimp', 'krabbe', 'muschel', 'tintenfisch',
    'hummer', 'fischsauce', 'fischöl', 'lab', 'tierisches lab', 'knochen',
    'brühe vom rind', 'hühnerbrühe', 'rinderbrühe', 'fleischextrakt', 'karmin', 'cochenille',
    'schellack', 'aspik', 'kollagen', 'chitosan', 'leberwurst', 'geflügelleber', 'blutwurst'
  ];
  // Tierisch, aber vegetarisch: Milch, Ei, Honig & Co.
  const DAIRY_EGG = [
    'milch', 'vollmilch', 'magermilch', 'milchpulver', 'sahne', 'rahm', 'butter', 'butterreinfett',
    'käse', 'quark', 'joghurt', 'molke', 'molkenpulver', 'lactose', 'laktose', 'kasein',
    'casein', 'caseinat', 'milcheiweiß', 'milchzucker', 'buttermilch', 'kefir', 'ghee',
    'ei', 'eier', 'vollei', 'eigelb', 'eiklar', 'eiweiß vom huhn', 'hühnerei', 'eipulver',
    'honig', 'bienenwachs', 'gelée royale', 'propolis', 'lysozym', 'lanolin'
  ];
  // Kann pflanzlich oder tierisch sein.
  const MAYBE = [
    'aroma', 'natürliches aroma', 'mono- und diglyceride', 'emulgator', 'vitamin d3',
    'omega-3', 'glycerin', 'stearinsäure', 'l-cystein'
  ];

  // E-Nummern: 'no' = nicht vegetarisch, 'veg' = tierisch aber vegetarisch, 'maybe' = unklar.
  const E = {
    E120: ['no', 'Karmin (aus Läusen)'],
    E441: ['no', 'Gelatine'],
    E542: ['no', 'Knochenphosphat'],
    E904: ['no', 'Schellack'],
    E901: ['veg', 'Bienenwachs'],
    E913: ['veg', 'Lanolin (Wollfett)'],
    E966: ['veg', 'Lactit (aus Milch)'],
    E1105: ['veg', 'Lysozym (aus Ei)'],
    E322: ['maybe', 'Lecithin (meist Soja, selten Ei)'],
    E422: ['maybe', 'Glycerin'],
    E430: ['maybe', 'Polyoxyethylenstearat'],
    E431: ['maybe', 'Polyoxyethylenstearat'],
    E470: ['maybe', 'Fettsäuresalze'],
    E471: ['maybe', 'Mono- und Diglyceride'],
    E472: ['maybe', 'Ester von Mono- und Diglyceriden'],
    E473: ['maybe', 'Zuckerester'],
    E474: ['maybe', 'Zuckerglyceride'],
    E475: ['maybe', 'Polyglycerinester'],
    E476: ['maybe', 'Polyglycerin-Polyricinoleat'],
    E477: ['maybe', 'Propylenglycolester'],
    E478: ['maybe', 'Lactylierte Fettsäureester'],
    E479: ['maybe', 'Thermooxidiertes Sojaöl'],
    E481: ['maybe', 'Natriumstearoyllactylat'],
    E482: ['maybe', 'Calciumstearoyllactylat'],
    E570: ['maybe', 'Stearinsäure'],
    E572: ['maybe', 'Magnesiumstearat'],
    E631: ['maybe', 'Inosinat (oft aus Fleisch/Fisch)'],
    E627: ['maybe', 'Guanylat (oft aus Fisch)'],
    E635: ['maybe', 'Ribonukleotide'],
    E640: ['maybe', 'Glycin'],
    E920: ['maybe', 'L-Cystein (oft aus Federn)'],
    E1518: ['maybe', 'Glycerintriacetat']
  };

  const PLANT_PREFIX = /(soja|hafer|mandel|kokos|reis|erbsen|cashew|pflanz|nuss|vegan|kakao|shea|erdnuss|dinkel)/;

  function words(text) {
    return text.toLowerCase().replace(/_/g, '').split(/[,;:()\[\]{}.\n]+/).map((s) => s.trim()).filter(Boolean);
  }

  function matchList(part, list) {
    for (const w of list) {
      // Kurze Wörter ("ei", "lab") nur als ganzes Wort, längere auch in Komposita
      // ("Vollmilchpulver", "Schweinefleisch").
      if (w.length <= 3 ? new RegExp(`(^|\\s)${w}(\\s|$)`).test(part) : part.includes(w)) return w;
    }
    return null;
  }

  /** Bewertet freien Zutatentext. Ergebnis: { level, hits:[{text, level, note}] } */
  function analyze(text) {
    const hits = [];
    const seen = new Set();
    const add = (t, level, note) => {
      const k = t.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      hits.push({ text: t, level, note });
    };

    for (const raw of words(text)) {
      const part = raw.replace(/\s+/g, ' ');
      let eHit = false;
      for (const m of part.matchAll(/\be\s?-?(\d{3,4})[a-f]?\b/gi)) {
        const key = 'E' + m[1];
        eHit = true;
        if (E[key]) add(key, E[key][0], E[key][1]);
      }
      if (PLANT_PREFIX.test(part)) continue;   // "Sojamilch", "Kokosmilch", "Pflanzenbutter"
      let w;
      if ((w = matchList(part, MEAT))) add(cap(part), 'no', 'nicht vegetarisch');
      else if ((w = matchList(part, DAIRY_EGG))) add(cap(part), 'veg', 'tierisch, vegetarisch');
      else if (!eHit && (w = matchList(part, MAYBE))) add(cap(part), 'maybe', 'Herkunft unklar');
    }

    const level = hits.some((h) => h.level === 'no') ? 'no'
      : hits.some((h) => h.level === 'veg') ? 'vegetarian'
      : hits.some((h) => h.level === 'maybe') ? 'unknown'
      : 'vegan';
    return { level, hits };
  }

  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  return { analyze, E };
})();
