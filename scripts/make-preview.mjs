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
    centreHello: 'Good evening — collect the loose pieces.',
    centreTally: '14 notes · 1 archived',
    capture: 'Jot an idea, or paste a link',
    views: ['Canvas', 'Grid', 'List'],
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
    centreHello: '晚上好，收一下今天的碎片。',
    centreTally: '14 张便签 · 1 张已归档',
    capture: '记下一个灵感，或粘贴一个链接',
    views: ['画布', '网格', '列表'],
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

/** The floating dock along the bottom of the canvas. */
function dock(t) {
  const y = 546
  const left = 268
  const width = 744
  // Search field on the left, then the chips, then the quiet actions, then "+".
  const searchWidth = 150
  let cursor = left + 14 + searchWidth + 12
  const chipMarkup = t.chips
    .map((label, index) => {
      const w = Math.max(46, label.length * 12 + 18)
      const x = cursor
      cursor += w + 5
      return `
    <rect x="${x}" y="${y}" width="${w}" height="26" rx="13" fill="#ffffff" fill-opacity="${index === 0 ? '0.92' : '0.06'}"/>
    <text x="${x + w / 2}" y="${y + 18}" font-size="11.5" font-weight="${index === 0 ? '600' : '500'}" fill="${index === 0 ? '#14161b' : '#ffffff'}" fill-opacity="${index === 0 ? '1' : '0.6'}" text-anchor="middle" font-family="${SANS}">${esc(label)}</text>`
    })
    .join('')
  cursor += 6
  const divider = cursor
  cursor += 12
  const viewMarkup = t.views
    .map((label, index) => {
      const w = Math.max(44, label.length * 12 + 16)
      const x = cursor
      cursor += w + 5
      return `
    <rect x="${x}" y="${y}" width="${w}" height="26" rx="13" fill="#ffffff" fill-opacity="${index === 0 ? '0.92' : '0.06'}"/>
    <text x="${x + w / 2}" y="${y + 18}" font-size="11.5" font-weight="${index === 0 ? '600' : '500'}" fill="${index === 0 ? '#14161b' : '#ffffff'}" fill-opacity="${index === 0 ? '1' : '0.6'}" text-anchor="middle" font-family="${SANS}">${esc(label)}</text>`
    })
    .join('')
  return `
  <rect x="${left}" y="${y - 9}" width="${width}" height="44" rx="15" fill="#0f1115" fill-opacity="0.9" stroke="#ffffff" stroke-opacity="0.13" stroke-width="1"/>
  <rect x="${left + 14}" y="${y - 2}" width="${searchWidth}" height="30" rx="9" fill="#ffffff" fill-opacity="0.06" stroke="#ffffff" stroke-opacity="0.1" stroke-width="1"/>
  <circle cx="${left + 30}" cy="${y + 10}" r="5.2" fill="none" stroke="#ffffff" stroke-opacity="0.42" stroke-width="1.5"/>
  <path d="M${left + 34} ${y + 14} l3.6 3.6" stroke="#ffffff" stroke-opacity="0.42" stroke-width="1.5" stroke-linecap="round"/>
  <text x="${left + 44}" y="${y + 18}" font-size="11.5" fill="#ffffff" fill-opacity="0.34" font-family="${SANS}">${esc(t.search)}</text>
  ${chipMarkup}
  <line x1="${divider}" y1="${y + 3}" x2="${divider}" y2="${y + 23}" stroke="#ffffff" stroke-opacity="0.13" stroke-width="1"/>
  ${viewMarkup}
  <text x="${cursor + 8}" y="${y + 18}" font-size="11" fill="#ffffff" fill-opacity="0.36" font-family="${SANS}">${esc(t.zoom)}</text>
  <text x="${cursor + 46}" y="${y + 18}" font-size="11" fill="#ffffff" fill-opacity="0.36" font-family="${SANS}">${esc(t.tidy)}</text>
  <circle cx="${left + width - 26}" cy="${y + 13}" r="14" fill="#4d7cfe"/>
  <path d="M${left + width - 26} ${y + 6.5} v13 M${left + width - 32.5} ${y + 13} h13" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round"/>`
}

/** One language's complete banner. */
function render(lang) {
  LANG = lang
  const t = COPY[lang]
  const shadow = 'cardShadow'

  // The scattered wall. Sizes and angles differ on purpose: the whole point of
  // this release is that cards are placed, not flowed into a grid.
  //
  // The composition mirrors the product: a full-bleed canvas with the greeting and
  // the capture field at its MIDDLE, cards ringing that centre, and one floating
  // dock along the bottom. Cards stay inside x 140..1245 and above the dock.
  const CX = 692
  const CY = 292
  const cards = [
    // Upper band: entirely above the centre block.
    card({ x: 148, y: 122, w: 194, h: 142, rotate: -3.4, color: 'yellow', body: bodyHero }),
    card({ x: 372, y: 136, w: 154, h: 92, rotate: 2.6, color: 'purple', body: bodyQuote }),
    card({ x: 560, y: 120, w: 158, h: 104, rotate: -2.2, color: 'green', body: bodyCheck }),
    card({ x: 768, y: 128, w: 146, h: 100, rotate: 3.1, color: 'orange', body: bodyPlain }),
    card({ x: 958, y: 120, w: 172, h: 130, rotate: -2.8, color: 'pink', body: bodyList }),
    // Lower band: below the centre block and above the dock.
    card({ x: 172, y: 418, w: 158, h: 104, rotate: -1.8, color: 'yellow', body: bodyTable }),
    card({ x: 368, y: 424, w: 148, h: 96, rotate: 2.2, color: 'pink', body: bodyCalm }),
    card({ x: 556, y: 420, w: 178, h: 108, rotate: -2.4, color: 'blue', body: bodyCode }),
    card({ x: 776, y: 424, w: 158, h: 100, rotate: 1.6, color: 'green', body: bodyCheck }),
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
    <!-- The halo the real canvas paints at the wall's middle. -->
    <radialGradient id="centre">
      <stop offset="0" stop-color="#4d7cfe" stop-opacity="0.16"/>
      <stop offset="0.7" stop-color="#4d7cfe" stop-opacity="0"/>
    </radialGradient>
    <filter id="${shadow}" x="-30%" y="-30%" width="160%" height="180%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000000" flood-opacity="0.45"/>
    </filter>
  </defs>

  <!-- The app frame: the wall is the centre column of the DSH shell. -->
  <rect x="0" y="0" width="${W}" height="${H}" fill="url(#board)"/>
  <rect x="28" y="34" width="${W - 56}" height="${H - 68}" rx="18" fill="#ffffff" fill-opacity="0.02" stroke="#ffffff" stroke-opacity="0.07" stroke-width="1"/>
  <rect x="28" y="34" width="${W - 56}" height="170" fill="url(#glow)"/>

  ${sidebar(t)}
  <text x="140" y="74" font-size="17" font-weight="700" fill="#ffffff" fill-opacity="0.92" font-family="${SANS}">${esc(t.appName)}</text>
  <text x="140" y="94" font-size="11" fill="#ffffff" fill-opacity="0.38" font-family="${SANS}">${esc(t.appSub)}</text>

  <!-- Paper dot grid on the canvas. Dots, not a pattern: the parser rejects patterns. -->
  <g fill="#ffffff" fill-opacity="0.05">
${Array.from({ length: 11 }, (_, row) => Array.from({ length: 26 }, (_, col) => `<circle cx="${140 + col * 44}" cy="${182 + row * 34}" r="1.6"/>`).join('')).join('\n')}
  </g>

  <circle cx="${CX}" cy="${CY}" r="250" fill="url(#centre)"/>
  <text x="${CX}" y="${CY - 34}" font-size="21" font-weight="700" fill="#ffffff" fill-opacity="0.95" text-anchor="middle" font-family="${SANS}">${esc(t.centreHello)}</text>
  <text x="${CX}" y="${CY - 8}" font-size="12.5" fill="#ffffff" fill-opacity="0.45" text-anchor="middle" font-family="${SANS}">${esc(t.centreTally)}</text>
  <rect x="${CX - 250}" y="${CY + 12}" width="500" height="46" rx="14" fill="#ffffff" fill-opacity="0.07" stroke="#ffffff" stroke-opacity="0.16" stroke-width="1"/>
  <text x="${CX - 226}" y="${CY + 41}" font-size="13" fill="#ffffff" fill-opacity="0.42" font-family="${SANS}">${esc(t.capture)}</text>
  <rect x="${CX + 214}" y="${CY + 20}" width="30" height="30" rx="9" fill="#4d7cfe"/>
  <text x="${CX + 229}" y="${CY + 40}" font-size="13" fill="#ffffff" text-anchor="middle" font-family="${SANS}">↵</text>
  ${cards}

  <!-- Drag cue: the dashed drop target and a pointer on the hero card's corner. -->
  <rect x="156" y="130" width="194" height="142" rx="14" fill="none" stroke="#ffffff" stroke-opacity="0.3" stroke-width="1.4" stroke-dasharray="7 7" transform="rotate(-3.4 253 201)"/>
  <g transform="translate(316 268)">
    <path d="M0 0v20l5.2-5.2 3.6 8.4 4.2-1.8-3.6-8.2 7-.2z" fill="#ffffff" fill-opacity="0.92" stroke="#191c22" stroke-width="1.4" stroke-linejoin="round"/>
    <rect x="15" y="18" width="54" height="20" rx="10" fill="#ffffff" fill-opacity="0.14" stroke="#ffffff" stroke-opacity="0.22" stroke-width="1"/>
    <text x="42" y="32" font-size="10.5" fill="#ffffff" fill-opacity="0.78" text-anchor="middle" font-family="${SANS}">${esc(t.dragCue)}</text>
  </g>

  ${dock(t)}
</svg>
`
}

await writeFile(join(root, 'docs', 'preview.svg'), render('en'), 'utf8')
await writeFile(join(root, 'docs', 'preview.zh.svg'), render('zh'), 'utf8')
process.stdout.write('wrote docs/preview.svg and docs/preview.zh.svg\n')
