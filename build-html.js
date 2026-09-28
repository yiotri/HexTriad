// Combines build/bundle.js and build/styles.css into ../site/index.html,
// and writes the files that make the site installable as an app (manifest, service worker, icons).
const fs = require('fs');
const path = require('path');
const js = fs.readFileSync('build/bundle.js', 'utf8').replace(/<\/script>/g, '<\\/script>');
const css = fs.readFileSync('build/styles.css', 'utf8');
const favicon = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Cpolygon points=%2225,10 75,10 95,50 75,90 25,90 5,50%22 fill=%22%232563eb%22/%3E%3C/svg%3E';
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>HexTriad</title>
<meta name="description" content="HexTriad: a two-player abstract strategy game. Play a friend on the same screen or challenge the bot.">
<meta name="theme-color" content="#f9fafb">
<link rel="icon" href="${favicon}">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-title" content="HexTriad">
<meta name="mobile-web-app-capable" content="yes">
<style>${css}</style>
<style>
  :root { box-sizing: border-box; padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); color-scheme: light; }
  body { margin: 0; background: #f9fafb; color: #111827; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
<script>
  // Register the service worker (only works over https or localhost; skipped when opened as a local file).
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
</script>
</body>
</html>`;

const out = '../site';
fs.mkdirSync(path.join(out, 'icons'), { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.copyFileSync('public/manifest.webmanifest', path.join(out, 'manifest.webmanifest'));
for (const f of fs.readdirSync('public/icons')) fs.copyFileSync(path.join('public/icons', f), path.join(out, 'icons', f));
const version = Date.now().toString(36);
fs.writeFileSync(path.join(out, 'sw.js'), fs.readFileSync('sw.template.js', 'utf8').replace('__VERSION__', version));
console.log('Wrote ../site (index.html, manifest.webmanifest, sw.js, icons/)');
