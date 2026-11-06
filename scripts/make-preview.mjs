#!/usr/bin/env node
/**
 * Generate the two detail-page preview banners.
 *
 * Why a generator: the display contract allows only a narrow SVG element set
 * (no patterns, no clip paths, no external references), and both language
 * variants must be pixel-identical apart from their labels. Hand-writing two
 * 1280x600 files would drift; this script keeps one composition and swaps the
 * copy, so `docs/preview.svg` and `docs/preview.zh.svg` can never diverge.
 *
 * Text is emitted line by line from explicit arrays rather than as one long
 * string: SVG has no text wrapping, so every line break is a layout decision
 * made here and verified by rasterising the result.
 *
 * It writes only those two files. Run `node scripts/preview.mjs check` after.
 *
 * Usage: node scripts/make-preview.mjs
 */

import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const W = 1280
const H = 600
const SANS = "Inter, 'Noto Sans SC', system-ui, sans-serif"
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace"

const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Copy per language. The composition is identical; only these strings differ. */
const COPY = {
  en: {
    appName: 'Sticky Wall',
    appSub: 'Ideas, before they evaporate.',
    search: 'Search notes…',
    chips: ['All', 'Pinned', 'Archived'],
    tidy: 'Tidy',
    newNote: 'New',
    zoom: '100%',
    navLabel: 'Notes',
    heroHead: 'Ship it small',
    heroBold: 'One page, one idea.',
    heroBody: ['Write the smallest thing', 'that proves it works.'],
    heroTags: ['#idea', '#today'],
    pinLabel: 'pinned',
    listHead: 'Reading list',
    listItems: ['Cut the scope', 'Ship on Friday', 'Tell one person'],
    codeHead: 'Ship notes',
    codeLines: ['pnpm build', 'then drag me'],
    checkHead: 'A quiet corner',
    checkItems: ['Draft', 'Review'],
    quoteShort: 'Tools should disappear.',
    plainHead: 'Morning pages',
    plainBody: ['Three lines', 'before coffee.'],
    tableHead: 'Sprint',
    tableCols: ['Plan', 'Days'],
    tableRow: ['Write', '2'],
    calmHead: 'Slow is smooth',
    calmBody: ['Nothing here', 'is urgent.'],
    dragCue: 'drag',
    days: '3d',
  },
  zh: {
    appName: '便签墙',
    appSub: '灵感还没溜走的时候。',
    search: '搜索便签…',
    chips: ['全部', '置顶', '归档'],
    tidy: '整理',
    newNote: '新建',
    zoom: '100%',
    navLabel: '便签墙',
    heroHead: '先做小一点',
    heroBold: '一页纸，一个想法。',
    heroBody: ['写下能证明它成立', '的最小版本。'],
    heroTags: ['#灵感', '#今天'],
    pinLabel: '已置顶',
    listHead: '待读清单',
    listItems: ['砍掉范围', '周五发布', '告诉一个人'],
    codeHead: '发布便签',
    codeLines: ['pnpm build', '然后把我拖走'],
    checkHead: '安静的角落',
    checkItems: ['起草', '复看'],
    quoteShort: '工具应该消失。',
    plainHead: '晨间三行',
    plainBody: ['咖啡之前', '先写三行。'],
    tableHead: '本周',
    tableCols: ['计划', '天'],
    tableRow: ['写作', '2'],
    calmHead: '慢就是稳',
    calmBody: ['这里没有', '什么急事。'],
    dragCue: '拖动',
    days: '3 天',
  },
}

/** The six note palettes, as the plugin's own light-theme values. */
const PALETTE = {
  yellow: { bg: '#fdf7dc', edge: '#ecdc9e', ink: '#4a3d12', accent: '#e0b53a', accentInk: '#8a6a0d' },
  pink: { bg: '#fde9ef', edge: '#f2c9d6', ink: '#5a2437', accent: '#e78aa8', accentInk: '#a33d63' },
  green: { bg: '#e7f6ea', edge: '#c3e5cd', ink: '#1d3f27', accent: '#55b874', accentInk: '#2c7a47' },
  blue: { bg: '#e6f1fd', edge: '#c2daf1', ink: '#1b3550', accent: '#5b9de0', accentInk: '#2b6599' },
  purple: { bg: '#efe9fd', edge: '#d6c9f2', ink: '#36264f', accent: '#9b81e0', accentInk: '#5f3fa8' },
  orange: { bg: '#fdeee0', edge: '#f1d3b4', ink: '#4f2d12', accent: '#e79a4e', accentInk: '#a45c16' },
}

let LANG = 'en'

/** Emit one `<text>` per line, stacked by `lineHeight`. */
function lines(x, y, list, { size = 12.5, lh = 19, fill, opacity = 0.86, weight = 500, anchor = 'start', mono = false, italic = false } = {}) {
  return list
    .map(
      (line, index) => `
    <text x="${x}" y="${y + index * lh}" font-size="${size}" font-weight="${weight}"${italic ? ' font-style="italic"' : ''} fill="${fill}" fill-opacity="${opacity}" text-anchor="${anchor}" font-family="${mono ? MONO : SANS}">${esc(line)}</text>`,
    )
    .join('')
}

/** A rounded pill with centred text. */
function pill(x, y, w, h, fill, label, ink, { stroke, size = 11.5, weight = 500 } = {}) {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"${stroke === undefined ? '' : ` stroke="${stroke}" stroke-width="1"`}/>
    <text x="${x + w / 2}" y="${y + h / 2 + size * 0.35}" font-size="${size}" font-weight="${weight}" fill="${ink}" text-anchor="middle" font-family="${SANS}">${esc(label)}</text>`
}

/** Small filled dot. */
const dot = (cx, cy, r, fill, opacity = 1) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" fill-opacity="${opacity}"/>`

/** One card, with its rotation and drop shadow applied to the whole group. */
function card({ x, y, w, h, rotate, color, body }) {
  const p = PALETTE[color]
  return `
  <g transform="translate(${x} ${y}) rotate(${rotate} ${w / 2} ${h / 2})">
    <rect x="0" y="0" width="${w}" height="${h}" rx="14" fill="${p.bg}" stroke="${p.edge}" stroke-width="1.5" filter="url(#cardShadow)"/>
    ${body(p, w, h)}
  </g>`
}

/** Hero: heading, bold line, wrapped body, two tag pills, a pin rail and star. */
function bodyHero(p, w) {
  const t = COPY[LANG]
  return `
    <rect x="0" y="16" width="3" height="72" rx="1.5" fill="${p.accent}"/>
    ${dot(20, 24, 4, p.accent)}
    <text x="${w - 16}" y="28" font-size="10.5" font-weight="600" fill="${p.ink}" fill-opacity="0.5" text-anchor="end" font-family="${SANS}">★ ${esc(t.pinLabel)}</text>
    <text x="18" y="52" font-size="17" font-weight="700" fill="${p.ink}" font-family="${SANS}">${esc(t.heroHead)}</text>
    <text x="18" y="78" font-size="13" font-weight="650" fill="${p.ink}" font-family="${SANS}">${esc(t.heroBold)}</text>
    ${lines(18, 100, t.heroBody, { fill: p.ink, size: 12, lh: 17, opacity: 0.8, weight: 400 })}
    ${pill(18, 138, 52, 21, p.accent, t.heroTags[0], p.accentInk)}
    ${pill(76, 138, 52, 21, p.accent, t.heroTags[1], p.accentInk)}`
}

/** Bullet list with an accent bullet dot per item. */
function bodyList(p, w, h) {
  const t = COPY[LANG]
  return `
    <text x="18" y="36" font-size="15" font-weight="650" fill="${p.ink}" font-family="${SANS}">${esc(t.listHead)}</text>
    ${t.listItems
      .map(
        (item, index) => `
    ${dot(22, 62 + index * 27, 3.2, p.accent)}
    <text x="34" y="${66 + index * 27}" font-size="12.5" fill="${p.ink}" fill-opacity="0.86" font-family="${SANS}">${esc(item)}</text>`,
      )
      .join('')}
    <text x="${w - 16}" y="${h - 14}" font-size="10.5" fill="${p.ink}" fill-opacity="0.42" text-anchor="end" font-family="${SANS}">${esc(t.days)}</text>`
}

/** Fenced code block: a tinted well with monospace lines. */
function bodyCode(p, w, h) {
  const t = COPY[LANG]
  return `
    <text x="18" y="34" font-size="15" font-weight="650" fill="${p.ink}" font-family="${SANS}">${esc(t.codeHead)}</text>
    <text x="${w - 16}" y="34" font-size="10.5" fill="${p.ink}" fill-opacity="0.42" text-anchor="end" font-family="${SANS}">${esc(t.days)}</text>
    <rect x="14" y="48" width="${w - 28}" height="56" rx="8" fill="${p.ink}" fill-opacity="0.09" stroke="${p.ink}" stroke-opacity="0.16" stroke-width="1"/>
    ${lines(26, 70, t.codeLines, { fill: p.ink, size: 11.5, lh: 20, opacity: 0.88, weight: 500, mono: true })}`
}

/** Checkbox list; the first item is ticked. */
function bodyCheck(p, w, h) {
  const t = COPY[LANG]
  return `
    <text x="18" y="36" font-size="15" font-weight="650" fill="${p.ink}" font-family="${SANS}">${esc(t.checkHead)}</text>
    ${t.checkItems
      .map(
        (item, index) => `
    <rect x="18" y="${54 + index * 30}" width="13" height="13" rx="3" fill="${index === 0 ? p.accent : 'none'}" stroke="${index === 0 ? 'none' : p.ink}" stroke-opacity="0.4" stroke-width="1.2"/>
    ${
      index === 0
        ? `<path d="M21 ${60 + index * 30} l2.6 2.6 l4.6 -5.2" stroke="${p.accentInk}" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
        : ''
    }
    <text x="40" y="${65 + index * 30}" font-size="12.5" fill="${p.ink}" fill-opacity="${index === 0 ? 0.55 : 0.86}" font-family="${SANS}">${esc(item)}</text>`,
      )
      .join('')}
    <text x="${w - 16}" y="${h - 14}" font-size="10.5" fill="${p.ink}" fill-opacity="0.42" text-anchor="end" font-family="${SANS}">${esc(t.days)}</text>`
}

/** Block quote: one short line behind an accent rail. */
function bodyQuote(p, w, h) {
  const t = COPY[LANG]
  return `
    <rect x="16" y="20" width="2.5" height="${h - 40}" rx="1.25" fill="${p.accent}"/>
    <text x="30" y="${h / 2 + 5}" font-size="12.5" font-style="italic" fill="${p.ink}" fill-opacity="0.84" font-family="${SANS}">${esc(t.quoteShort)}</text>`
}

/** A heading plus a short wrapped paragraph. */
function bodyPlain(p, w) {
  const t = COPY[LANG]
  return `
    <text x="18" y="36" font-size="15" font-weight="650" fill="${p.ink}" font-family="${SANS}">${esc(t.plainHead)}</text>
    ${lines(18, 60, t.plainBody, { fill: p.ink, size: 12.5, lh: 19, opacity: 0.84, weight: 400 })}`
}

/** A tiny two-column pipe table with a header rule. */
function bodyTable(p, w) {
  const t = COPY[LANG]
  const colX = [18, 92]
  return `
    <text x="18" y="34" font-size="15" font-weight="650" fill="${p.ink}" font-family="${SANS}">${esc(t.tableHead)}</text>
    <text x="${colX[0]}" y="64" font-size="11.5" font-weight="650" fill="${p.ink}" fill-opacity="0.9" font-family="${SANS}">${esc(t.tableCols[0])}</text>
    <text x="${colX[1]}" y="64" font-size="11.5" font-weight="650" fill="${p.ink}" fill-opacity="0.9" font-family="${SANS}">${esc(t.tableCols[1])}</text>
    <line x1="16" y1="72" x2="${w - 16}" y2="72" stroke="${p.ink}" stroke-opacity="0.3" stroke-width="1"/>
    <text x="${colX[0]}" y="92" font-size="11.5" fill="${p.ink}" fill-opacity="0.78" font-family="${SANS}">${esc(t.tableRow[0])}</text>
    <text x="${colX[1]}" y="92" font-size="11.5" fill="${p.ink}" fill-opacity="0.78" font-family="${SANS}">${esc(t.tableRow[1])}</text>`
}

/** A heading with an italic closing line — the "calm" note. */
function bodyCalm(p, w, h) {
  const t = COPY[LANG]
  return `
    <text x="18" y="36" font-size="15" font-weight="650" fill="${p.ink}" font-family="${SANS}">${esc(t.calmHead)}</text>
    ${lines(18, 62, t.calmBody, { fill: p.ink, size: 12.5, lh: 19, opacity: 0.8, weight: 400 })}
    <text x="${w - 16}" y="${h - 14}" font-size="10.5" fill="${p.ink}" fill-opacity="0.42" text-anchor="end" font-family="${SANS}">${esc(t.days)}</text>`
}

/** The sidebar strip: brand mark, the plugin's own glyph, and two quiet rows. */
function sidebar(t) {
  return `
  <rect x="28" y="34" width="72" height="${H - 68}" rx="16" fill="#ffffff" fill-opacity="0.05" stroke="#ffffff" stroke-opacity="0.09" stroke-width="1"/>
  ${dot(64, 66, 10, '#4d7cfe')}
  <g transform="translate(56 56)" fill="none" stroke="#ffffff" stroke-opacity="0.95" stroke-width="1.4" stroke-linecap="round">
    <rect x="1" y="5" width="13" height="13" rx="2.4"/>
    <path d="M5.4 2.6h9a2.4 2.4 0 0 1 2.4 2.4v9"/>
  </g>
  <text x="64" y="94" font-size="10.5" fill="#ffffff" fill-opacity="0.58" text-anchor="middle" font-family="${SANS}">${esc(t.navLabel)}</text>
  ${[0, 1, 2]
    .map(
      (index) => `
  <rect x="44" y="${124 + index * 34}" width="40" height="26" rx="8" fill="#ffffff" fill-opacity="${index === 0 ? '0.15' : '0.05'}"/>`,
    )
    .join('')}`
}

/** Top toolbar: title, subtitle, search field, filter chips, tidy and new. */
function toolbar(t) {
  return `
  <text x="128" y="72" font-size="19" font-weight="700" fill="#ffffff" fill-opacity="0.95" font-family="${SANS}">${esc(t.appName)}</text>
  <text x="128" y="94" font-size="11.5" fill="#ffffff" fill-opacity="0.44" font-family="${SANS}">${esc(t.appSub)}</text>
  <rect x="128" y="112" width="296" height="34" rx="10" fill="#ffffff" fill-opacity="0.07" stroke="#ffffff" stroke-opacity="0.12" stroke-width="1"/>
  <circle cx="148" cy="127" r="5.5" fill="none" stroke="#ffffff" stroke-opacity="0.42" stroke-width="1.6"/>
  <path d="M152.4 131.4l4.4 4.4" stroke="#ffffff" stroke-opacity="0.42" stroke-width="1.6" stroke-linecap="round"/>
  <text x="166" y="133" font-size="12" fill="#ffffff" fill-opacity="0.36" font-family="${SANS}">${esc(t.search)}</text>
  ${t.chips
    .map(
      (label, index) => `
  <rect x="${436 + index * 76}" y="112" width="68" height="34" rx="17" fill="#ffffff" fill-opacity="${index === 0 ? '0.92' : '0.07'}"${index === 0 ? '' : ' stroke="#ffffff" stroke-opacity="0.12" stroke-width="1"'}/>
  <text x="${436 + index * 76 + 34}" y="134" font-size="12" font-weight="${index === 0 ? '650' : '500'}" fill="${index === 0 ? '#191b21' : '#ffffff'}" fill-opacity="${index === 0 ? '1' : '0.58'}" text-anchor="middle" font-family="${SANS}">${esc(label)}</text>`,
    )
    .join('')}
  <rect x="${W - 200}" y="112" width="72" height="34" rx="10" fill="#ffffff" fill-opacity="0.07" stroke="#ffffff" stroke-opacity="0.12" stroke-width="1"/>
  <text x="${W - 164}" y="134" font-size="12" font-weight="500" fill="#ffffff" fill-opacity="0.68" text-anchor="middle" font-family="${SANS}">${esc(t.tidy)}</text>
  <rect x="${W - 118}" y="112" width="90" height="34" rx="10" fill="#4d7cfe"/>
  <text x="${W - 73}" y="134" font-size="12" font-weight="600" fill="#ffffff" text-anchor="middle" font-family="${SANS}">+ ${esc(t.newNote)}</text>`
}

/** Floating zoom control at the canvas' bottom-left. */
function zoomPill(t) {
  const y = H - 78
  return `
  <rect x="128" y="${y}" width="128" height="32" rx="16" fill="#ffffff" fill-opacity="0.09" stroke="#ffffff" stroke-opacity="0.14" stroke-width="1"/>
  <text x="150" y="${y + 21}" font-size="13" fill="#ffffff" fill-opacity="0.6" text-anchor="middle" font-family="${SANS}">−</text>
  <text x="192" y="${y + 20}" font-size="11" fill="#ffffff" fill-opacity="0.52" text-anchor="middle" font-family="${SANS}">${esc(t.zoom)}</text>
  <text x="234" y="${y + 21}" font-size="13" fill="#ffffff" fill-opacity="0.6" text-anchor="middle" font-family="${SANS}">+</text>`
}

/** One language's complete banner. */
function render(lang) {
  LANG = lang
  const t = COPY[lang]
  const shadow = 'cardShadow'

  // The scattered wall. Sizes and angles differ on purpose: the whole point of
  // this release is that cards are placed, not flowed into a grid.
  const cards = [
    card({ x: 168, y: 194, w: 252, h: 172, rotate: -4.5, color: 'yellow', body: bodyHero }),
    card({ x: 444, y: 176, w: 198, h: 158, rotate: 3.2, color: 'pink', body: bodyList }),
    card({ x: 668, y: 212, w: 240, h: 132, rotate: -2.4, color: 'blue', body: bodyCode }),
    card({ x: 924, y: 168, w: 184, h: 140, rotate: 4.6, color: 'green', body: bodyCheck }),
    card({ x: 296, y: 396, w: 214, h: 100, rotate: 2.8, color: 'purple', body: bodyQuote }),
    card({ x: 556, y: 386, w: 172, h: 116, rotate: -5.2, color: 'orange', body: bodyPlain }),
    card({ x: 770, y: 372, w: 186, h: 124, rotate: 1.8, color: 'yellow', body: bodyTable }),
    card({ x: 998, y: 344, w: 172, h: 128, rotate: -3.6, color: 'pink', body: bodyCalm }),
  ].join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="board" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1a1d24"/>
      <stop offset="0.55" stop-color="#14161b"/>
      <stop offset="1" stop-color="#0f1115"/>
    </linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="0.7" y2="1">
      <stop offset="0" stop-color="#4d7cfe" stop-opacity="0.15"/>
      <stop offset="1" stop-color="#4d7cfe" stop-opacity="0"/>
    </linearGradient>
    <filter id="${shadow}" x="-30%" y="-30%" width="160%" height="180%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000000" flood-opacity="0.45"/>
    </filter>
  </defs>

  <!-- The app frame: the wall is the centre column of the DSH shell. -->
  <rect x="0" y="0" width="${W}" height="${H}" fill="url(#board)"/>
  <rect x="28" y="34" width="${W - 56}" height="${H - 68}" rx="18" fill="#ffffff" fill-opacity="0.02" stroke="#ffffff" stroke-opacity="0.07" stroke-width="1"/>
  <rect x="28" y="34" width="${W - 56}" height="170" fill="url(#glow)"/>

  ${sidebar(t)}

  <!-- Paper dot grid on the canvas. Dots, not a pattern: the parser rejects patterns. -->
  <g fill="#ffffff" fill-opacity="0.05">
${Array.from({ length: 11 }, (_, row) => Array.from({ length: 22 }, (_, col) => `<circle cx="${148 + col * 50}" cy="${176 + row * 36}" r="1.6"/>`).join('')).join('\n')}
  </g>

  ${toolbar(t)}
  ${cards}

  <!-- Drag cue: the dashed drop target and a pointer on the hero card's corner. -->
  <rect x="176" y="202" width="252" height="172" rx="14" fill="none" stroke="#ffffff" stroke-opacity="0.3" stroke-width="1.4" stroke-dasharray="7 7" transform="rotate(-4.5 302 288)"/>
  <g transform="translate(404 356)">
    <path d="M0 0v20l5.2-5.2 3.6 8.4 4.2-1.8-3.6-8.2 7-.2z" fill="#ffffff" fill-opacity="0.92" stroke="#191c22" stroke-width="1.4" stroke-linejoin="round"/>
    <rect x="15" y="18" width="54" height="20" rx="10" fill="#ffffff" fill-opacity="0.14" stroke="#ffffff" stroke-opacity="0.22" stroke-width="1"/>
    <text x="42" y="32" font-size="10.5" fill="#ffffff" fill-opacity="0.78" text-anchor="middle" font-family="${SANS}">${esc(t.dragCue)}</text>
  </g>

  ${zoomPill(t)}
</svg>
`
}

await writeFile(join(root, 'docs', 'preview.svg'), render('en'), 'utf8')
await writeFile(join(root, 'docs', 'preview.zh.svg'), render('zh'), 'utf8')
process.stdout.write('wrote docs/preview.svg and docs/preview.zh.svg\n')
