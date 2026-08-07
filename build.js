#!/usr/bin/env node
/* Concatenates src/ into a single self-contained dist/p5x-planner.html.
   No bundler, no dependencies — the output must run from file:// with no server. */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const data  = read('src/data.js');
const ui    = read('src/ui.html');
const logic = read('src/logic.js');

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>P5X Revelation Planner</title>
</head><body>
${ui}
<script>
${data}
</script>
<script>
${logic}
</script>
</body></html>
`;

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/p5x-planner.html'), html);
console.log(`built dist/p5x-planner.html — ${(html.length / 1024).toFixed(1)} kB`);
