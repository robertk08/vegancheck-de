// Schreibt die Zutatenregeln der Website als JSON für die iOS-App.
// Aufruf (aus web/): node tools/export-rules.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');   // web/tools → Projektordner
const src = readFileSync(join(root, 'web/rules.js'), 'utf8');
const RULES = new Function(src + '\nreturn RULES;')();
const out = join(root, 'ios/VeganCheck/rules.json');
writeFileSync(out, JSON.stringify(RULES.data, null, 1) + '\n');
console.log('geschrieben:', out);
