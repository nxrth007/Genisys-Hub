/**
 * Genisys OS's home-screen icons, drawn here and rendered to PNG with sharp.
 *
 * The mark is the Hub's G (src/app/icon.svg: an arc and a bar, not font text),
 * white on black like Genisys OS's entrance screen. Three shapes:
 *   - rounded: a rounded square on transparent, for desktop installs and the manifest's "any" icons
 *   - maskable: full-bleed, the G inside the middle 80% (Android crops it to its own shape)
 *   - apple: full-bleed square at 180px (iOS rounds the corners itself)
 *
 * Writes public/icons/genisys-os-{192,512}.png, public/icons/genisys-os-maskable-512.png, the
 * notification badge public/icons/genisys-os-badge.png (white on transparent), and the
 * apple-icon.png that src/app/genisys-os and src/app/login use instead of the Hub's.
 *
 * Run from the repo: node scripts/build-genisys-os-icons.mjs
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The G centred on 256,256 in a 512 box: the Hub icon's path at `scale` (1 = the Hub's proportions). */
function g(scale) {
  const r = 136 * scale
  const w = 64 * scale
  // The arc starts at the upper right (the Hub's 44.02,19.98 on its 64 grid) and runs round to the bar.
  const a = (-45 * Math.PI) / 180
  const sx = 256 + r * Math.cos(a)
  const sy = 256 + r * Math.sin(a)
  return `<path d="M${sx.toFixed(2)} ${sy.toFixed(2)}A${r} ${r} 0 1 0 ${256 + r} 256H${256 + 8 * scale}" fill="none" stroke="#fff" stroke-width="${w}" stroke-linejoin="miter"/>`
}

const background = `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#202024"/><stop offset="1" stop-color="#050506"/></linearGradient></defs>`

const svg = {
  rounded: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${background}<rect width="512" height="512" rx="112" fill="url(#bg)"/>${g(1)}</svg>`,
  // 0.58: the G's outer corner stays inside the 40% circle Android keeps whatever shape it crops to.
  maskable: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${background}<rect width="512" height="512" fill="url(#bg)"/>${g(0.58)}</svg>`,
  apple: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${background}<rect width="512" height="512" fill="url(#bg)"/>${g(0.92)}</svg>`,
  // Android's status bar shows a notification's badge as a white shape: just the G, on nothing.
  badge: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${g(1.35)}</svg>`,
}

const out = [
  ['public/icons/genisys-os-192.png', svg.rounded, 192],
  ['public/icons/genisys-os-512.png', svg.rounded, 512],
  ['public/icons/genisys-os-maskable-512.png', svg.maskable, 512],
  ['public/icons/genisys-os-badge.png', svg.badge, 96],
  ['src/app/genisys-os/apple-icon.png', svg.apple, 180],
  ['src/app/login/apple-icon.png', svg.apple, 180],
]

for (const [file, source, size] of out) {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  await sharp(Buffer.from(source), { density: 72 * (size / 512) * 4 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(path)
  console.log(`wrote ${file} (${size}px)`)
}
