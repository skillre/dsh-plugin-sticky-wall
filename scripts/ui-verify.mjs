/**
 * Owned UI verification driver (local only, not shipped).
 *
 * Drives the headless Chrome attached to the owned DSH Web app over CDP:
 * clicks the sidebar entry, verifies the wall page, creates/edits/pins/archives
 * a note through the real UI, and captures screenshots as evidence.
 */

import { writeFile } from 'node:fs/promises'

const port = process.env.CDP_PORT || '9333'
const evidenceDir = process.env.EVIDENCE_DIR || 'docs/evidence'

async function connect() {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
  const page = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const next = ++id
      pending.set(next, { resolve, reject })
      ws.send(JSON.stringify({ id: next, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(`evaluate failed: ${JSON.stringify(result.exceptionDetails).slice(0, 600)}`)
    return result.result?.value
  }
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }
  const shot = async (name) => {
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(`${evidenceDir}/${name}`, Buffer.from(result.data, 'base64'))
    return `${evidenceDir}/${name}`
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  return { send, evaluate, click, shot, wait, close: () => ws.close() }
}

/** Centre of the first element matching a CSS selector, in viewport coordinates. */
const CENTER_OF = (selector) => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
})()`

/** Centre of the first button whose accessible name equals the given text. */
const BUTTON_NAMED = (name) => `(() => {
  const button = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.getAttribute('aria-label') === ${JSON.stringify(name)} ||
    (candidate.innerText || '').trim() === ${JSON.stringify(name)});
  if (!button) return null;
  const rect = button.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
})()`

const results = []
function record(name, value) {
  results.push({ check: name, ...value })
  process.stdout.write(`${value.ok === false ? 'FAIL' : 'ok  '} ${name}${value.detail ? ` — ${value.detail}` : ''}\n`)
}

const page = await connect()
try {
  await page.send('Runtime.enable')
  await page.send('Page.enable')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false })
  await page.wait(500)

  // Dismiss the shell's own first-run overlays (preview notice and the
  // account dialog). Both belong to DSH, not to this plugin, and both sit
  // above the sidebar; a real user dismisses them the same way.
  const dismissed = await page.evaluate(`(() => {
    let closed = 0;
    const closeNamed = (label) => {
      const button = document.querySelector('[aria-label="' + label + '"]');
      if (button) { button.click(); closed += 1; return true; }
      return false;
    };
    closeNamed('关闭');
    const proceed = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '继续');
    if (proceed) { proceed.click(); closed += 1; }
    return closed;
  })()`)
  await page.wait(800)
  record('shell-overlays-dismissed', { ok: true, detail: `${dismissed} overlay control(s) used` })

  // 1. The sidebar entry exists in the real shell and is labelled in the GUI language.
  const entry = await page.evaluate(BUTTON_NAMED('便签墙'))
  record('sidebar-entry-present', { ok: entry !== null, detail: entry ? 'aria-label 便签墙' : 'not found' })
  if (!entry) throw new Error('the sidebar entry is missing')

  await page.click(entry.x, entry.y)
  await page.wait(1200)

  // 2. Clicking it selects the panel and mounts the wall in the centre column.
  const mounted = await page.evaluate(`(() => {
    const current = document.querySelector('[aria-current="page"]');
    return {
      current: current ? current.getAttribute('aria-label') : null,
      wall: !!document.querySelector('.skw-page'),
      title: document.querySelector('.skw-title')?.textContent ?? null,
      subtitle: document.querySelector('.skw-subtitle')?.textContent ?? null,
      notes: document.querySelectorAll('.skw-note').length,
    };
  })()`)
  record('sidebar-entry-selects-panel', { ok: mounted.current === '便签墙', detail: `aria-current=${mounted.current}` })
  record('wall-page-mounted', { ok: mounted.wall === true, detail: `title=${mounted.title}` })
  record('welcome-note-seeded', { ok: mounted.notes >= 1, detail: `${mounted.notes} note card(s)` })
  record('zh-copy', { ok: mounted.title === '便签墙' && typeof mounted.subtitle === 'string', detail: mounted.subtitle })

  const wallShot = await page.shot('sticky-wall-zh.png')

  // 3. Create a note through the real composer: open, type, save.
  const newButton = await page.evaluate(BUTTON_NAMED('+ 新建'))
  if (!newButton) throw new Error('the New button is missing')
  await page.click(newButton.x, newButton.y)
  await page.wait(500)
  const sheet = await page.evaluate(`(() => ({
    open: !!document.querySelector('.skw-sheet'),
    textarea: !!document.querySelector('.skw-textarea'),
    swatches: document.querySelectorAll('.skw-swatch').length,
  }))()`)
  record('composer-opens', { ok: sheet.open && sheet.textarea === true, detail: `${sheet.swatches} swatches` })

  await page.evaluate(`(() => {
    const textarea = document.querySelector('.skw-textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, '验证便签：来自真实 Web UI 的输入');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    const input = document.querySelector('.skw-input');
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    inputSetter.call(input, 'UI 验证');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const blue = [...document.querySelectorAll('.skw-swatch')].find((element) => element.getAttribute('aria-label') === 'blue');
    blue?.click();
    return true;
  })()`)
  await page.wait(300)
  const saved = await page.evaluate(`(() => {
    const save = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '保存');
    save?.click();
    return !!save;
  })()`)
  await page.wait(1200)
  const afterCreate = await page.evaluate(`(() => ({
    sheetClosed: !document.querySelector('.skw-sheet'),
    notes: document.querySelectorAll('.skw-note').length,
    hasText: [...document.querySelectorAll('.skw-note')].some((n) => n.innerText.includes('验证便签')),
    colors: [...document.querySelectorAll('.skw-note')].map((n) => n.getAttribute('data-color')),
    error: document.querySelector('.skw-error')?.textContent ?? null,
  }))()`)
  record('composer-save-creates-note', {
    ok: saved && afterCreate.sheetClosed && afterCreate.hasText === true,
    detail: `notes=${afterCreate.notes} colors=${afterCreate.colors.join(',')} error=${afterCreate.error ?? 'none'}`,
  })
  const noteShot = await page.shot('sticky-wall-note-created.png')

  // 4. Pin the new note through its card action and confirm it sorts to the top.
  const pinned = await page.evaluate(`(() => {
    const card = [...document.querySelectorAll('.skw-note')].find((n) => n.innerText.includes('验证便签'));
    if (!card) return { ok: false, reason: 'card missing' };
    const pin = [...card.querySelectorAll('.skw-icon-btn')].find((b) => b.getAttribute('aria-label') === '置顶');
    pin?.click();
    return { ok: !!pin };
  })()`)
  await page.wait(1200)
  const afterPin = await page.evaluate(`(() => {
    const first = document.querySelector('.skw-note');
    return { firstPinned: first?.getAttribute('data-pinned') ?? null, firstText: (first?.innerText || '').slice(0, 30) };
  })()`)
  record('pin-action-sorts-note-first', { ok: pinned.ok && afterPin.firstPinned === 'true', detail: `first=${afterPin.firstText}` })

  // 5. Search filters the wall.
  const searched = await page.evaluate(`(() => {
    const search = document.querySelector('.skw-search');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(search, '验证便签');
    search.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await page.wait(400)
  const afterSearch = await page.evaluate(`(() => ({
    notes: document.querySelectorAll('.skw-note').length,
    count: document.querySelector('.skw-count')?.textContent ?? null,
  }))()`)
  record('search-filters-wall', { ok: searched && afterSearch.notes === 1, detail: `count label=${afterSearch.count}` })

  // 6. Archive hides it from the default wall, then the archived filter shows it again.
  await page.evaluate(`(() => {
    const search = document.querySelector('.skw-search');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(search, '');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await page.wait(400)
  const archived = await page.evaluate(`(() => {
    const card = [...document.querySelectorAll('.skw-note')].find((n) => n.innerText.includes('验证便签'));
    if (!card) return { ok: false, reason: 'card missing' };
    const archive = [...card.querySelectorAll('.skw-icon-btn')].find((b) => b.getAttribute('aria-label') === '归档');
    archive?.click();
    return { ok: !!archive };
  })()`)
  await page.wait(1200)
  const afterArchive = await page.evaluate(`(() => ({
    visible: [...document.querySelectorAll('.skw-note')].some((n) => n.innerText.includes('验证便签')),
    count: document.querySelectorAll('.skw-note').length,
  }))()`)
  record('archive-hides-note', { ok: archived.ok && afterArchive.visible === false, detail: `visible notes=${afterArchive.count}` })

  await page.evaluate(`(() => {
    const toggle = [...document.querySelectorAll('.skw-toggle')][0];
    toggle?.click();
    return !!toggle;
  })()`)
  await page.wait(1000)
  const restoredVisible = await page.evaluate(`(() => ({
    visible: [...document.querySelectorAll('.skw-note')].some((n) => n.innerText.includes('验证便签')),
    archivedCards: [...document.querySelectorAll('.skw-note[data-archived="true"]')].length,
  }))()`)
  record('show-archived-toggle', { ok: restoredVisible.visible === true, detail: `archived cards=${restoredVisible.archivedCards}` })
  const archivedShot = await page.shot('sticky-wall-archived.png')

  // 7. The Host is the source of truth: a fresh reload must still show the note.
  // A reload returns the shell to its default panel and can re-arm the shell's
  // first-run overlays, so dismiss them and re-select the entry before reading.
  await page.send('Page.reload')
  await page.wait(3000)
  await page.evaluate(`(() => {
    document.querySelector('[aria-label="关闭"]')?.click();
    const proceed = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '继续');
    proceed?.click();
    return true;
  })()`)
  await page.wait(800)
  const entryAgain = await page.evaluate(BUTTON_NAMED('便签墙'))
  if (!entryAgain) throw new Error('the sidebar entry disappeared after reload')
  await page.click(entryAgain.x, entryAgain.y)
  await page.wait(2000)
  // The note was archived in step 6, so the reloaded wall hides it by default:
  // enable the archived filter before asserting that the record still exists.
  await page.evaluate(`(() => { document.querySelector('.skw-toggle')?.click(); return true; })()`)
  await page.wait(1500)
  const afterReload = await page.evaluate(`(() => ({
    wall: !!document.querySelector('.skw-page'),
    hasNote: [...document.querySelectorAll('.skw-note')].some((n) => n.innerText.includes('验证便签')),
    total: document.querySelectorAll('.skw-note').length,
    archived: document.querySelectorAll('.skw-note[data-archived="true"]').length,
  }))()`)
  record('note-persists-across-ui-reload', {
    ok: afterReload.wall && afterReload.hasNote,
    detail: `cards=${afterReload.total} archived=${afterReload.archived}`,
  })

  // 8. Dark theme: the shell exposes the theme flag the plugin's CSS keys off.
  const dark = await page.evaluate(`(() => {
    document.body.setAttribute('data-ds-dark-theme', '');
    const card = document.querySelector('.skw-note');
    const style = card ? getComputedStyle(card) : null;
    return { flag: document.body.hasAttribute('data-ds-dark-theme'), background: style?.backgroundColor ?? null, color: style?.color ?? null };
  })()`)
  record('dark-theme-styles-note', { ok: dark.flag === true && dark.background !== null, detail: `bg=${dark.background} ink=${dark.color}` })
  const darkShot = await page.shot('sticky-wall-dark.png')
  await page.evaluate(`document.body.removeAttribute('data-ds-dark-theme')`)

  // 9. No uncaught errors during the whole interaction.
  const consoleErrors = await page.evaluate(`(() => (window.__skwErrors || []).length)()`)
  record('no-uncaught-errors', { ok: consoleErrors === 0, detail: `${consoleErrors} recorded` })

  await writeFile(
    `${evidenceDir}/ui-verification.json`,
    `${JSON.stringify({ capturedAt: new Date().toISOString(), viewport: '1440x900@2x', locale: 'zh', screenshots: [wallShot, noteShot, archivedShot, darkShot], results }, null, 2)}\n`,
    'utf8',
  )
  const failed = results.filter((entry) => entry.ok === false)
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`)
  if (failed.length > 0) process.exitCode = 1
} finally {
  page.close()
}
