#!/usr/bin/env node
/* Builds site/ — the planner as an installable phone app (a PWA), for a static web host
   such as GitHub Pages. `npm run site` (add `-- --with-art` to include the portraits).

   dist/p5x-planner.html is left exactly as it is: it still has to run from file:// and as
   a Cowork artifact, where a manifest fetch is an error and a service worker cannot run.
   So everything an installed app needs is added only to site/index.html:
     - the manifest and home-screen icons (rendered here from the page's own favicon),
     - sw.js, which keeps a copy of the page so it opens with no connection. It is not
       browser storage of the user's data — the save file is still the only persistence.
   Portraits are left out unless asked for: game art is not ours to redistribute (see
   the note on `artPath` in src/logic.js), and the page falls back to initials. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const out = path.join(root, 'site');
const withArt = process.argv.includes('--with-art');

require('../build.js');
const html = fs.readFileSync(path.join(root, 'dist/p5x-planner.html'), 'utf8');

const NAME = 'P5X Revelation Planner', SHORT = 'P5X Planner', BG = '#0b0b0d';
const ICONS = [180, 192, 512];

const head = `<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="${BG}">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="apple-mobile-web-app-title" content="${SHORT}">
<link rel="apple-touch-icon" href="icon-180.png">
`;
const register = `<script>
if ('serviceWorker' in navigator) addEventListener('load', () => {
  try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (e) {}
});
</script>
`;
const h = html.indexOf('</head>'), b = html.lastIndexOf('</body>');
if (h < 0 || b < 0) throw new Error('dist/p5x-planner.html has no </head> or </body>');
const index = html.slice(0, h) + head + html.slice(h, b) + register + html.slice(b);

const manifest = {
  name: NAME, short_name: SHORT,
  description: 'Revelation Card planner for Persona 5: The Phantom X',
  start_url: './', scope: './', display: 'standalone',
  background_color: BG, theme_color: BG,
  icons: [192, 512].flatMap(s => ['any', 'maskable'].map(purpose =>
    ({ src: `icon-${s}.png`, sizes: `${s}x${s}`, type: 'image/png', purpose }))),
};

/* The favicon is a 128 px tilted card on transparency. A home-screen icon needs a solid
   background (iOS fills transparency with black, Android crops a maskable icon to its own
   shape), so it is drawn on the page background at 64% — inside the 80% circle a
   maskable icon is guaranteed to show. */
async function renderIcons() {
  const fav = html.match(/<link rel="icon" href="(data:image\/png;base64,[^"]+)"/);
  if (!fav) throw new Error('no favicon in dist/p5x-planner.html');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const urls = await page.evaluate(async ({ src, sizes, bg }) => {
      const img = new Image(); img.src = src; await img.decode();
      return sizes.map(s => {
        const c = document.createElement('canvas'); c.width = c.height = s;
        const g = c.getContext('2d');
        g.fillStyle = bg; g.fillRect(0, 0, s, s);
        g.imageSmoothingQuality = 'high';
        const d = Math.round(s * 0.64), o = Math.round((s - d) / 2);
        g.drawImage(img, o, o, d, d);
        return c.toDataURL('image/png');
      });
    }, { src: fav[1], sizes: ICONS, bg: BG });
    return urls.map(u => Buffer.from(u.split(',')[1], 'base64'));
  } finally { await browser.close(); }
}

/* What the last build held, by content: a hosted copy is updated by uploading files by hand (GitHub's web
   uploader takes at most 100 at a time), so the build ends by naming the files that are new or changed. */
function snapshot(dir) {
  const seen = new Map();
  const walk = d => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else seen.set(path.relative(dir, p).split(path.sep).join('/'), crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  return seen;
}

(async () => {
  const before = snapshot(out);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const write = (f, data) => fs.writeFileSync(path.join(out, f), data);

  write('index.html', index);
  write('manifest.webmanifest', JSON.stringify(manifest, null, 2));
  write('.nojekyll', '');
  const pngs = await renderIcons();
  ICONS.forEach((s, i) => write(`icon-${s}.png`, pngs[i]));

  let art = [];
  if (withArt) {
    const src = path.join(root, 'dist/art');
    if (!fs.existsSync(src)) throw new Error('--with-art: dist/art/ is missing (tools/fetch-art.py fetches the portraits, tools/fetch-persona-art.js the Persona pictures)');
    art = fs.readdirSync(src).filter(f => f.endsWith('.webp'));
    // the Personas tab's pictures sit beside the portraits (art/persona-<slug>.webp); say so when there are none
    if (!art.some(f => f.startsWith('persona-'))) console.warn('--with-art: no Persona pictures in dist/art/ — run `node tools/fetch-persona-art.js` to include them');
    fs.mkdirSync(path.join(out, 'art'));
    art.forEach(f => fs.copyFileSync(path.join(src, f), path.join(out, 'art', f)));
  }

  /* The cache name changes with every build, so an installed app picks up a new version
     the next time it is opened online, and the old copy is dropped. */
  const version = crypto.createHash('sha256').update(index).update(art.join()).digest('hex').slice(0, 12);
  const shell = ['./', 'index.html', 'manifest.webmanifest', ...ICONS.map(s => `icon-${s}.png`)];
  write('sw.js', `/* Generated by tools/build-site.js. Keeps the planner usable offline:
   the page itself network-first (a new build shows up as soon as there is a connection),
   icons and portraits cache-first. */
const CACHE = 'p5x-planner-${version}';
const SHELL = ${JSON.stringify(shell)};
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const keep = res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  };
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(keep)
      .catch(() => caches.match(req).then(r => r || caches.match('index.html'))));
    return;
  }
  e.respondWith(caches.match(req).then(r => r || fetch(req).then(keep)));
});
`);

  const kb = f => (fs.statSync(path.join(out, f)).size / 1024).toFixed(0);
  const nPersona = art.filter(f => f.startsWith('persona-')).length;
  console.log(`built site/ — index.html ${kb('index.html')} kB, ${ICONS.length} icons, ` +
    (withArt ? `${art.length - nPersona} portraits and ${nPersona} Persona pictures` : 'no portraits or Persona pictures (add --with-art)') + `, cache ${version}`);

  // what to upload: the files that are new or differ from the last build (all of them the first time)
  const after = snapshot(out);
  const changed = [...after].filter(([f, h]) => before.get(f) !== h).map(([f]) => f).sort();
  const gone = [...before.keys()].filter(f => !after.has(f)).sort();
  if (!before.size) console.log(`first build here: upload everything in site/ (${after.size} files)`);
  else if (!changed.length && !gone.length) console.log('nothing changed since the last build');
  else {
    const top = changed.filter(f => !f.includes('/')), inArt = changed.filter(f => f.startsWith('art/'));
    console.log(`changed since the last build — upload these ${changed.length} file${changed.length === 1 ? '' : 's'}:`);
    if (top.length) console.log('  ' + top.join(', '));
    if (inArt.length) console.log(`  art/: ${inArt.length} picture${inArt.length === 1 ? '' : 's'}` +
      (inArt.length <= 12 ? ` (${inArt.map(f => f.slice(4)).join(', ')})` : ` (${inArt.filter(f => f.startsWith('art/persona-')).length} Persona pictures)`));
    if (gone.length) console.log(`  no longer built (delete from the hosted copy if you like): ${gone.join(', ')}`);
  }
  if (changed.length > 100 || (!before.size && after.size > 100))
    console.log("  GitHub's web uploader takes at most 100 files at a time: upload them in batches (e.g. art/ in two halves), or push with git.");
})().catch(e => { console.error(e); process.exit(1); });
