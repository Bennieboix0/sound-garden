/**
 * Generates every app icon from the single SVG in assets/icon.svg.
 *
 * Run with:  npm run icons
 *
 * Nothing here should be edited to change the mark — edit the SVG instead.
 * Hand-maintained PNGs drift out of sync the moment the logo changes, and the
 * maskable and Apple variants have real constraints that are easy to get wrong
 * by eye.
 */
import { Resvg } from '@resvg/resvg-js';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'assets', 'icon.svg'), 'utf8');
const outDir = join(root, 'public');

/** The app's dark surface — ink-900 in tailwind.config.js. */
const BACKGROUND = '#0b0d0c';

/**
 * Android masks icons to a circle or squircle and can crop up to 20%. The
 * maskable variant therefore shrinks the artwork into the middle 80% and lets
 * the background bleed to the edge, so nothing meaningful can be clipped.
 */
const MASKABLE_SAFE_FRACTION = 0.8;

/**
 * Renders onto an opaque canvas rather than a transparent one.
 *
 * Scaling a 512pt viewBox down to 180 leaves the background rect's edges on
 * fractional pixels, which come out semi-transparent — and iOS composites any
 * alpha against black, so an otherwise perfect icon gets a dark fringe. Filling
 * the canvas first makes every pixel opaque by construction, which is also what
 * the maskable variant needs.
 */
function render(svg, size, background = BACKGROUND) {
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background,
  })
    .render()
    .asPng();
}

/** Wraps the artwork in a full-bleed background, scaled into the safe zone. */
function insetSvg(svg, fraction, background) {
  const inner = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    // The source already paints its own background; the wrapper supplies it.
    .replace(/<rect width="512" height="512" fill="[^"]*"\/>/, '');
  const scaled = (512 * fraction).toFixed(2);
  const offset = ((512 - 512 * fraction) / 2).toFixed(2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="${background}"/>
  <g transform="translate(${offset} ${offset}) scale(${fraction})">${inner}</g>
</svg>`;
}

/**
 * iOS renders any alpha channel as black and applies its own rounded mask, so
 * the Apple icon must be fully opaque with the background already painted in.
 */
function opaqueSvg(svg, background) {
  return svg.replace(
    /<rect width="512" height="512" fill="[^"]*"\/>/,
    `<rect width="512" height="512" fill="${background}"/>`,
  );
}

function write(name, buffer) {
  writeFileSync(join(outDir, name), buffer);
  console.log(`  ${name.padEnd(24)} ${String(buffer.length).padStart(7)} bytes`);
}

mkdirSync(outDir, { recursive: true });
console.log('Generating icons from assets/icon.svg');

write('icon-192.png', render(source, 192));
write('icon-512.png', render(source, 512));
write('icon-maskable-512.png', render(insetSvg(source, MASKABLE_SAFE_FRACTION, BACKGROUND), 512));
write('apple-touch-icon.png', render(opaqueSvg(source, BACKGROUND), 180));

copyFileSync(join(root, 'assets', 'icon.svg'), join(outDir, 'favicon.svg'));
console.log('  favicon.svg              (copied from source)');
