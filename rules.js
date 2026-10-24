/* Lokale Zutatenprüfung ohne Datenbank: Schlüsselwörter, E-Nummern und ein kleines
   Lebensmittel-Lexikon. Wird vom Zutaten-Check genutzt und füllt Lücken, wenn
   Open Food Facts keine Analyse oder gar keine Zutatenliste hat. */
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
    'schellack', 'aspik', 'kollagen', 'chitosan', 'leberwurst', 'geflügelleber', 'blutwurst',
    // Gerichte und Sorten, die fast immer Fleisch oder Fisch enthalten
    'rentier', 'hirsch', 'reh', 'rippchen', 'ribs', 'rips', 'leberkäse', 'frikadelle',
    'bulette', 'döner', 'gyros', 'kebab', 'steak', 'schnitzel', 'gulasch', 'hackfleisch', 'mett',
    'herrensalat', 'fleischsalat', 'surimi', 'kaviar', 'carne', 'chicken nuggets',
    // Hartkäse mit tierischem Lab
    'parmesan', 'parmigiano', 'grana padano', 'pecorino',
    // Englisch (Importware, USDA-Daten)
    'beef', 'pork', 'chicken', 'turkey', 'bacon', 'ham', 'lard', 'tallow', 'gelatin', 'anchovy',
    'tuna', 'salmon', 'shrimp', 'crab', 'lobster', 'oyster', 'clam', 'fish', 'meat', 'carmine',
    'shellac', 'rennet', 'collagen', 'bone broth', 'chicken broth', 'beef broth'
  ];
  // Tierisch, aber vegetarisch: Milch, Ei, Honig & Co.
  const DAIRY_EGG = [
    'milch', 'vollmilch', 'magermilch', 'milchpulver', 'sahne', 'rahm', 'butter', 'butterreinfett',
    'käse', 'quark', 'joghurt', 'molke', 'molkenpulver', 'lactose', 'laktose', 'kasein',
    'casein', 'caseinat', 'milcheiweiß', 'milchzucker', 'buttermilch', 'kefir', 'ghee',
    'ei', 'eier', 'vollei', 'eigelb', 'eiklar', 'eiweiß vom huhn', 'hühnerei', 'eipulver',
    'honig', 'bienenwachs', 'gelée royale', 'propolis', 'lysozym', 'lanolin',
    // Käse- und Milchsorten
    'gouda', 'gruyère', 'gruyere', 'emmentaler', 'cheddar', 'mozzarella', 'feta', 'camembert',
    'brie', 'edamer', 'tilsiter', 'mascarpone', 'ricotta', 'skyr', 'schmand', 'crème fraîche',
    'eiscreme', 'pudding', 'trinkschokolade', 'mayonnaise', 'remoulade',
    // Englisch
    'milk', 'cream', 'cheese', 'whey', 'yogurt', 'egg', 'eggs', 'honey', 'beeswax', 'nonfat dry milk'
  ];
  // Kann pflanzlich oder tierisch sein.
  const MAYBE = [
    'aroma', 'natürliches aroma', 'mono- und diglyceride', 'emulgator', 'vitamin d3',
    'omega-3', 'glycerin', 'stearinsäure', 'l-cystein', 'natural flavor', 'natural flavors', 'mono and diglycerides'
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

  // Ein Pflanzenwort direkt vor dem tierischen Wort macht es pflanzlich: „Kokosmilch“,
  // „Kakaobutter“, „Soja-Joghurt“. Steht es nur irgendwo daneben („Kakao Milch“), zählt es nicht.
  const PLANT = 'soja|soy|hafer|oat|mandel|almond|kokos|coconut|reis|rice|erbsen|pea|cashew|pflanzen|plant|nuss|nut|kakao|cocoa|shea|erdnuss|peanut|dinkel|sonnenblumen|raps|kürbiskern|haselnuss|macadamia|pistazien';
  // Kennzeichnet einen Bestandteil als Ersatzprodukt: „vegane Wurst“, „pflanzliche Milchalternative“.
  const VEGAN_WORD = /(vegan|pflanzlich|vegetabil|veggie|fleischlos|plant[- ]based|dairy[- ]free)/;

  // Von Natur aus pflanzliche Lebensmittel – für Produkte, von denen nur der Name bekannt ist.
  const PLANT_FOODS = [
    'apfel', 'äpfel', 'rucola', 'birne', 'banane', 'kiwi', 'mango', 'ananas', 'orange', 'zitrone', 'limette',
    'mandarine', 'clementine', 'grapefruit', 'traube', 'beere', 'kirsche', 'pfirsich', 'aprikose',
    'pflaume', 'zwetschge', 'melone', 'avocado', 'dattel', 'feige', 'rosine', 'tomate', 'gurke',
    'paprika', 'zwiebel', 'schalotte', 'knoblauch', 'kartoffel', 'karotte', 'möhre', 'rübe', 'rote bete',
    'kohl', 'brokkoli', 'blumenkohl', 'spinat', 'zucchini', 'aubergine', 'kürbis',
    'pilz', 'champignon', 'artischocke', 'spargel', 'mais', 'erbse', 'bohne', 'linse', 'kichererbse',
    'edamame', 'tofu', 'tempeh', 'seitan', 'reis', 'quinoa', 'couscous', 'bulgur', 'hirse', 'polenta',
    'grieß', 'mehl', 'haferflocken', 'spaghetti', 'penne', 'fusilli', 'linguine', 'nuss', 'nüsse',
    'mandel', 'haselnuss', 'walnuss', 'cashew', 'erdnuss', 'pistazie', 'sesam', 'leinsamen', 'chia',
    'kerne', 'öl', 'essig', 'senf', 'salz', 'pfeffer', 'gewürz', 'kräuter', 'chili', 'jalape',
    'curry', 'zimt', 'tonka', 'zucker', 'sirup', 'agave', 'kaffee', 'espresso',
    'tee', 'wasser', 'saft', 'nektar', 'schorle', 'limonade', 'limo', 'cola', 'konfitüre', 'marmelade',
    'fruchtaufstrich', 'sauerkraut', 'oliven', 'kapern', 'ketchup', 'kakao', 'gin', 'wodka',
    'vodka', 'rum', 'whisky', 'tequila', 'korn', 'brandy', 'slivovitz', 'sljivovica', 'obstler', 'bier',
    'apple', 'banana', 'carrot', 'juice', 'rice', 'lentil', 'beans', 'oil', 'water', 'coffee', 'tea',
    'salt', 'sugar', 'flour', 'oats', 'almond', 'peanut', 'spice', 'tomato', 'potato',
    'kokos', 'maracuja', 'mandarin', 'hafer', 'ciabatta', 'baguette', 'dinkel',
    'roggen', 'weizen', 'gerste', 'buchweizen', 'soja', 'hummus', 'falafel', 'sauerteig'
  ];
  // Wein & Co. werden oft mit Gelatine, Hausenblase, Kasein oder Eiweiß geklärt.
  const FINED = /(wein|wine|champagner|sekt|prosecco|cava|cidre|cider)/;

  // Wörter, die nur so aussehen, als wären sie tierisch
  const FALSE_FRIENDS = /(honigmelone|honeymelon|honey ?melon|honigbusch|butternut|butterbohne|butterkeks ?vegan|kokosnussmilch|leberblümchen|fischerman|eisbergsalat|eisen|eis(?=tee)|zuckerei)/g;

  // Zusammengesetzte Lebensmittel: ein Pflanzenwort im Namen beweist hier nichts.
  const COMPOSITE = /(creme|cream|sahne|dessert|pudding|riegel|torte|kuchen|gebäck|keks|schoko|choco|glace|drink|shake|protein|suppe|soße|sauce|salat|dip|pesto|fertig|gericht|menü|pizza|snack|müsli|porridge|vitalkost|diät)/;

  const esc = (w) => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

  function words(text) {
    return text.toLowerCase().replace(/_/g, '').split(/[,;:()\[\]{}.\n]+/).map((s) => s.trim()).filter(Boolean);
  }

  function matchList(part, list) {
    for (const w of list) {
      // Kurze Wörter („ei“, „lab“) nur als ganzes Wort, längere auch in Komposita
      // („Vollmilchpulver“, „Schweinefleisch“).
      // Bis 3 Zeichen nur als ganzes Wort („Ei“, „Lab“). Bis 5 Zeichen am Wortanfang oder
      // -ende („Rinderbrühe“, „Spareribs“), damit „Vitalgebäck“ nicht „Talg“ und
      // „Studentenfutter“ nicht „Ente“ enthält. Längere Wörter auch mitten im Kompositum.
      const W = esc(w);
      const found = w.length <= 3 ? new RegExp(`(^|[^a-zäöüß])${W}([^a-zäöüß]|$)`).test(part)
        : w === 'ente' ? new RegExp(`(^|[^a-zäöüß])ente|flugente|pekingente`).test(part)   // nicht „contenente“, „Patente“
        : w.length <= 5 ? new RegExp(`(^|[^a-zäöüß])${W}|${W}([^a-zäöüß]|$)`).test(part)
        : part.includes(w);
      if (!found) continue;
      if (new RegExp(`(${PLANT})-?${esc(w)}`).test(part)) continue;
      return w;
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
      const part = raw.replace(/\s+/g, ' ').replace(FALSE_FRIENDS, ' ');
      let eHit = false;
      for (const m of part.matchAll(/\be\s?-?(\d{3,4})[a-f]?\b/gi)) {
        const key = 'E' + m[1];
        eHit = true;
        if (E[key]) add(key, E[key][0], E[key][1]);
      }
      if (VEGAN_WORD.test(part)) continue;
      if (matchList(part, MEAT)) add(cap(part), 'no', 'nicht vegetarisch');
      else if (matchList(part, DAIRY_EGG)) add(cap(part), 'veg', 'tierisch, vegetarisch');
      else if (!eHit && matchList(part, MAYBE)) add(cap(part), 'maybe', 'Herkunft unklar');
    }

    const level = hits.some((h) => h.level === 'no') ? 'no'
      : hits.some((h) => h.level === 'veg') ? 'vegetarian'
      : hits.some((h) => h.level === 'maybe') ? 'unknown'
      : 'vegan';
    return { level, hits };
  }

  /** Nur der Name ist bekannt: von Natur aus pflanzlich? → { word } | { fined: true } | null */
  function plantFood(name) {
    const n = name.toLowerCase();
    if (FINED.test(n)) return { fined: true };
    if (COMPOSITE.test(n)) return null;
    for (const w of PLANT_FOODS) {
      // Kurze Wörter nur allein („Tee“) oder am Wortende („Rapsöl“, „Meersalz“) – nicht „Teewurst“
      const found = w.length <= 3
        ? new RegExp(`(^|[^a-zäöüß])${esc(w)}([^a-zäöüß]|$)|${esc(w)}([^a-zäöüß]|$)`).test(n)
        : n.includes(w);
      if (found) return { word: w };
    }
    return null;
  }

  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  const isFined = (name) => FINED.test(name.toLowerCase());

  // Rohdaten für die iOS-App (tools/export-rules.mjs schreibt daraus rules.json)
  const data = {
    meat: MEAT, dairyEgg: DAIRY_EGG, maybe: MAYBE, e: E, plantFoods: PLANT_FOODS,
    plant: PLANT, veganWord: VEGAN_WORD.source, fined: FINED.source,
    falseFriends: FALSE_FRIENDS.source, composite: COMPOSITE.source
  };

  return { analyze, plantFood, isFined, E, data };
})();
