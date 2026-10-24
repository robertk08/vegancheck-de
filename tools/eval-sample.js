// Misst, wie viele Produkte einer Stichprobe welche Einstufung bekommen.
// Aufruf (aus web/): node tools/eval-sample.js . tools/sample-de.json
// Bewertet eine Stichprobe mit dem echten Code der Website.
const fs = require('fs');
const web = process.argv[2];
eval(fs.readFileSync(web + '/rules.js', 'utf8') + fs.readFileSync(web + '/verdict.js', 'utf8')
  + ';globalThis.assess=assess;globalThis.RULESX=RULES;');
const list = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const count = {}; const why = {};
for (const p of list) {
  if (Array.isArray(p.brands)) p.brands = p.brands.join(', ');
  const v = assess(p).verdict.key;
  count[v] = (count[v] || 0) + 1;
  if (v === 'unknown') {
    const k = !p.ingredients_text && !p.ingredients_text_de ? (p.image_ingredients_url ? 'no text, has photo' : 'no text, no photo') : 'text but unclear';
    why[k] = (why[k] || 0) + 1;
  }
}
console.log(list.length, count, why);
