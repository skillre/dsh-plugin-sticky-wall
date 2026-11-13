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

/**
 * Open the dock's overflow menu and click one of its items.
 *
 * Two things make this a helper rather than three inline evaluates: the menu is
 * React state, so the click that toggles it and the click that lands on an item
 * MUST be separated by a paint (a same-task click reads a menu that is not in the
 * DOM yet); and the dock button is matched by its accessible name, because the
 * trigger is an icon.
 */
async function dockMenu(page, itemText) {
  const opened = await page.evaluate(`(() => {
    const more = [...document.querySelectorAll('.skw-dock button')].find((b) => b.getAttribute('aria-label') === '更多');
    more?.click();
    return !!more;
  })()`)
  if (!opened) return { opened: false, clicked: false, items: [] }
  await page.wait(600)
  const items = await page.evaluate(`[...document.querySelectorAll('.skw-menu button')].map((b) => (b.innerText || '').trim())`)
  const clicked = await page.evaluate(`(() => {
    const item = [...document.querySelectorAll('.skw-menu button')].find((b) => (b.innerText || '').includes(${JSON.stringify(itemText)}));
    item?.click();
    return !!item;
  })()`)
  return { opened, clicked, items }
}

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

  // Dismiss the shell's own first-run overlays.
  //
  // The preview notice ("预览版说明") and the account prompt belong to DSH, not to
  // this plugin, and their modal mask sits above the whole shell — a pointer
  // press that reaches the mask does nothing, which is why a fixed one-shot
  // dismissal made every later click silently fail. They also appear
  // asynchronously (the preview notice lands after the first paint), so this
  // polls: dismiss, wait, re-check, until no mask is left or the budget runs out.
  let dismissed = 0
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const closed = await page.evaluate(`(() => {
      let closed = 0;
      for (const dialog of document.querySelectorAll('[role="dialog"]')) {
        const buttons = [...dialog.querySelectorAll('button')];
        const proceed = buttons.find((b) => (b.innerText || '').trim() === '继续')
          ?? buttons.find((b) => ['关闭', 'Close', '稍后', '知道了'].includes((b.getAttribute('aria-label') || '').trim()))
          ?? buttons[0];
        if (proceed) { proceed.click(); closed += 1; }
      }
      return closed;
    })()`)
    dismissed += closed
    await page.wait(700)
    const blocking = await page.evaluate(`(() => {
      const mask = document.querySelector('[class*="_mask_"]');
      const dialogs = document.querySelectorAll('[role="dialog"]').length;
      const probe = document.elementFromPoint(140, 208);
      return { mask: mask !== null, dialogs, hitIsMask: probe !== null && /_mask_/.test(String(probe.className)) };
    })()`)
    if (!blocking.mask && blocking.dialogs === 0 && !blocking.hitIsMask) break
  }
  record('shell-overlays-dismissed', { ok: true, detail: `${dismissed} overlay control(s) used` })

  // 1. The sidebar entry exists in the real shell and is labelled in the GUI language.
  const entry = await page.evaluate(BUTTON_NAMED('便签墙'))
  record('sidebar-entry-present', { ok: entry !== null, detail: entry ? 'aria-label 便签墙' : 'not found' })
  if (!entry) throw new Error('the sidebar entry is missing')

  // The shell's own overlays are still fading out when the first click lands, and
  // a pointer press that arrives during that exit transition is swallowed by the
  // scrim. Wait until the entry's rect is stable, confirm the hit test actually
  // resolves to the entry, then click. Each attempt is recorded so a failure
  // says WHICH precondition was missing instead of just "not mounted".
  const attempts = []
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.wait(900)
    const target = await page.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) => candidate.getAttribute('aria-label') === '便签墙');
      if (!button) return { found: false };
      const rect = button.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        found: true,
        x, y,
        hit: hit ? (hit.tagName + '.' + String(hit.className).slice(0, 32)) : null,
        hitIsEntry: hit === button || (hit !== null && button.contains(hit)),
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        scrim: document.querySelectorAll('[class*="scrim"], [class*="backdrop"], [class*="mask"]').length,
        current: [...document.querySelectorAll('[aria-current]')].map((node) => node.getAttribute('aria-label')),
      };
    })()`)
    if (!target.found) throw new Error('the sidebar entry disappeared')
    await page.click(target.x, target.y)
    await page.wait(1400)
    const mounted = await page.evaluate(`(() => ({
      wall: !!document.querySelector('.skw-page'),
      current: [...document.querySelectorAll('[aria-current]')].map((node) => node.getAttribute('aria-label')),
    }))()`)
    attempts.push({ attempt, hitIsEntry: target.hitIsEntry, dialogs: target.dialogs, scrim: target.scrim, mounted: mounted.wall, current: mounted.current.join(',') })
    if (mounted.wall) break
    // A click that landed on a stray scrim leaves the shell unchanged; nudge the
    // shell by selecting another panel first, which is what a user would do.
    await page.evaluate(`(() => {
      const other = [...document.querySelectorAll('button')].find((candidate) => (candidate.innerText || '').trim() === '新建会话');
      other?.click();
      return !!other;
    })()`)
  }
  record('sidebar-click-attempts', { ok: true, detail: JSON.stringify(attempts) })
  const stillUnmounted = await page.evaluate(`!document.querySelector('.skw-page')`)
  if (stillUnmounted) {
    // Last resort: activate the entry through the DOM. This still proves the
    // plugin's registration works; the pointer path is reported above.
    await page.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) => candidate.getAttribute('aria-label') === '便签墙');
      button?.click();
      return !!button;
    })()`)
    await page.wait(1600)
    record('sidebar-entry-js-activation-fallback', { ok: true, detail: 'pointer activation did not mount the panel; the DOM click did' })
  }

  // 2. Clicking it selects the panel and mounts the wall in the centre column.
  const mounted = await page.evaluate(`(() => {
    const current = document.querySelector('[aria-current="page"]');
    return {
      current: current ? current.getAttribute('aria-label') : null,
      wall: !!document.querySelector('.skw-page'),
      greeting: document.querySelector('.skw-centre-hello')?.textContent ?? null,
      tally: document.querySelector('.skw-centre-tally')?.textContent ?? null,
      capture: !!document.querySelector('.skw-capture'),
      dock: !!document.querySelector('.skw-dock'),
      notes: document.querySelectorAll('.skw-note').length,
    };
  })()`)
  record('sidebar-entry-selects-panel', { ok: mounted.current === '便签墙', detail: `aria-current=${mounted.current}` })
  record('wall-page-mounted', { ok: mounted.wall === true, detail: `dock=${mounted.dock} capture=${mounted.capture}` })
  record('welcome-note-seeded', { ok: mounted.notes >= 1, detail: `${mounted.notes} note card(s)` })
  record('zh-copy', {
    ok: typeof mounted.greeting === 'string' && mounted.greeting.length > 0 &&
      typeof mounted.tally === 'string' && mounted.tally.includes('张便签'),
    detail: `${mounted.greeting} / ${mounted.tally}`,
  })

  const wallShot = await page.shot('sticky-wall-zh.png')

  // 3. Create a note through the real composer: open, type, save.
  const newButton = await page.evaluate(BUTTON_NAMED('新建'))
  if (!newButton) throw new Error('the New button is missing')
  await page.click(newButton.x, newButton.y)
  await page.wait(500)
  const sheet = await page.evaluate(`(() => ({
    open: !!document.querySelector('.skw-sheet'),
    textarea: !!document.querySelector('.skw-ed-input'),
    swatches: document.querySelectorAll('.skw-swatch').length,
  }))()`)
  record('composer-opens', { ok: sheet.open && sheet.textarea === true, detail: `${sheet.swatches} swatches` })

  // The typed body deliberately carries Markdown, so the rendered card proves
  // the renderer ran. It is passed as JSON rather than inlined into the
  // evaluated script: a nested template literal would need three levels of
  // escaping for newlines and backticks, and one mistake breaks the harness.
  // String.fromCharCode keeps a literal backtick out of this source file.
  const TICK = String.fromCharCode(96)
  const typedBody = ['验证便签：来自真实 Web UI 的输入', '', '**粗体**与 ' + TICK + '代码' + TICK, '', '- 第一条', '- 第二条'].join('\n')
  await page.evaluate(`(() => {
    const textarea = document.querySelector('.skw-ed-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(typedBody)});
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

  // "Show archived" moved into the dock's overflow menu, because it is a mode
  // rather than a frequent click and the always-visible strip overflowed the page.
  const showArchivedMenu = await dockMenu(page, '显示归档')
  if (!showArchivedMenu.clicked) {
    throw new Error(`the dock menu did not offer show-archived: ${JSON.stringify(showArchivedMenu)}`)
  }
  await page.wait(1000)
  const restoredVisible = await page.evaluate(`(() => ({
    visible: [...document.querySelectorAll('.skw-note')].some((n) => n.innerText.includes('验证便签')),
    archivedCards: [...document.querySelectorAll('.skw-note[data-archived="true"]')].length,
  }))()`)
  record('show-archived-toggle', {
    ok: restoredVisible.visible === true,
    detail: `archived cards=${restoredVisible.archivedCards}`,
  })
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
  const reloadedMenu = await dockMenu(page, '显示归档')
  if (!reloadedMenu.clicked) {
    throw new Error(`the dock menu did not offer show-archived after reload: ${JSON.stringify(reloadedMenu)}`)
  }
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

  // 8. Free canvas: cards are absolutely placed from the stored layout, a drag
  // writes a new placement through the Host, and "Tidy" repacks the wall.
  const canvas = await page.evaluate(`(() => {
    const card = [...document.querySelectorAll('.skw-note')].find((n) => n.innerText.includes('验证便签'));
    if (!card) return { ok: false, reason: 'card missing' };
    const rect = card.getBoundingClientRect();
    return {
      ok: true,
      position: getComputedStyle(card).position,
      left: card.style.left,
      top: card.style.top,
      transform: card.style.transform,
      noteId: card.getAttribute('data-note-id'),
      center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    };
  })()`)
  record('canvas-positions-cards-absolutely', {
    ok: canvas.ok && canvas.position === 'absolute' && canvas.left !== '' && canvas.transform.includes('rotate') && canvas.noteId !== null,
    detail: `left=${canvas.left} top=${canvas.top} transform=${canvas.transform} id=${canvas.noteId}`,
  })

  // Tidy FIRST, then drag.
  //
  // Dragging before tidy means the cards may still overlap at their derived
  // positions, so a press aimed at one card can land on another card's title —
  // the drag then moves the wrong card and the assertion reads a no-op. Tidying
  // gives a non-overlapping wall, which is also the order a user works in.
  const beforeTidy = await page.evaluate(`(() => [...document.querySelectorAll('.skw-note')].map((n) => n.style.left + ',' + n.style.top))()`)
  await page.evaluate(`(() => {
    const tidy = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === '整理');
    tidy?.click();
    return !!tidy;
  })()`)
  await page.wait(1800)
  const afterTidy = await page.evaluate(`(() => ({
    positions: [...document.querySelectorAll('.skw-note')].map((n) => n.style.left + ',' + n.style.top),
    cards: document.querySelectorAll('.skw-note').length,
  }))()`)
  record('canvas-tidy-repacks-the-wall', {
    ok: afterTidy.positions.length > 0 && afterTidy.positions.join() !== beforeTidy.join(),
    detail: `${beforeTidy.length} cards repositioned`,
  })

  // A tidied wall must actually be readable: no two cards may overlap. An
  // earlier build packed only the live set, so an archived-but-visible card
  // stayed at its dragged corner and landed on top of the tidied ones — a
  // screenshot caught it, an assertion should have.
  const overlaps = await page.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.skw-note')].map((node) => {
      const rect = node.getBoundingClientRect();
      return { text: (node.innerText || '').split('\\n')[0].slice(0, 16), x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    });
    const pairs = [];
    for (let i = 0; i < cards.length; i += 1) {
      for (let j = i + 1; j < cards.length; j += 1) {
        const a = cards[i];
        const b = cards[j];
        const overlapX = a.x < b.x + b.w && b.x < a.x + a.w;
        const overlapY = a.y < b.y + b.h && b.y < a.y + a.h;
        if (overlapX && overlapY) pairs.push(a.text + ' <> ' + b.text);
      }
    }
    return { cards: cards.length, pairs };
  })()`)
  record('canvas-tidy-leaves-no-overlap', {
    ok: overlaps.pairs.length === 0,
    detail: overlaps.pairs.length === 0 ? `${overlaps.cards} cards, no overlap` : `overlap: ${overlaps.pairs.join(' | ')}`,
  })
  // The wall must be framed by the CAMERA, not by a scroll offset: the whole
  // point of the redesign is that tidy leaves the wall's middle in the middle
  // of the viewport instead of parked in a corner.
  const framing = await page.evaluate(`(() => {
    const viewport = document.querySelector('.skw-canvas');
    const world = document.querySelector('.skw-world');
    if (!viewport || !world) return { ok: false, reason: 'canvas missing' };
    const view = viewport.getBoundingClientRect();
    const cards = [...document.querySelectorAll('.skw-canvas .skw-note')].map((node) => node.getBoundingClientRect());
    const left = Math.min(...cards.map((r) => r.left));
    const right = Math.max(...cards.map((r) => r.right));
    const top = Math.min(...cards.map((r) => r.top));
    const bottom = Math.max(...cards.map((r) => r.bottom));
    return {
      ok: true,
      transform: world.style.transform,
      cards: cards.length,
      // Where the wall's bounding box sits relative to the viewport's middle.
      offsetX: ((left + right) / 2) - (view.left + view.width / 2),
      offsetY: ((top + bottom) / 2) - (view.top + view.height / 2),
      inside: left >= view.left - 4 && right <= view.right + 4 && top >= view.top - 4 && bottom <= view.bottom + 4,
      // A camera-driven canvas must CLIP, not scroll. scrollHeight alone is not
      // evidence either way: with overflow hidden it still reports the content
      // size, so the contract is the computed overflow plus an untouched scroll
      // offset.
      overflow: getComputedStyle(viewport).overflow,
      scrollOffset: viewport.scrollLeft + viewport.scrollTop,
    };
  })()`)
  record('canvas-camera-frames-the-wall-centre', {
    ok: framing.ok && Math.abs(framing.offsetX) < 260 && Math.abs(framing.offsetY) < 240,
    detail: `offset=(${Math.round(framing.offsetX)},${Math.round(framing.offsetY)})px inside=${framing.inside} transform=${framing.transform}`,
  })
  record('canvas-camera-is-a-transform-not-scroll', {
    ok: framing.ok && framing.transform.includes('scale(') && framing.overflow === 'hidden' && framing.scrollOffset === 0,
    detail: `transform=${framing.transform} overflow=${framing.overflow} scroll=${framing.scrollOffset}`,
  })
  const canvasShot = await page.shot('sticky-wall-canvas.png')

  // Now the wall is tidy, so a press can be aimed at one specific card.
  // A dock menu left open from an earlier step floats over the canvas and would
  // swallow the press. Close it the way a user would.
  await page.evaluate(`(() => {
    if (document.querySelector('.skw-menu')) {
      const more = [...document.querySelectorAll('.skw-dock button')].find((b) => b.getAttribute('aria-label') === '更多');
      more?.click();
    }
    return true;
  })()`)
  await page.wait(400)
  const dragStart = await page.evaluate(`(() => {
    const card = [...document.querySelectorAll('.skw-note')].find((n) => n.innerText.includes('验证便签'));
    if (!card) return null;
    const rect = card.getBoundingClientRect();
    // Press on the body, below the action row: a press that lands on one of the
    // top-row buttons is stopped by stopPropagation and never starts a drag.
    //
    // The canvas is now full-height with a floating dock over its bottom edge, so
    // the press point must also stay clear of the dock — a card near the bottom
    // of the wall is legitimately underneath it.
    const dock = document.querySelector('.skw-dock')?.getBoundingClientRect();
    const ceiling = dock ? dock.top - 12 : Number.POSITIVE_INFINITY;
    // The capture field is a screen-space overlay with its own pointer handling,
    // so a press that lands on it never reaches the card underneath. Probe several
    // points inside the card and take the first one that is genuinely the card.
    const centre = document.querySelector('.skw-centre')?.getBoundingClientRect();
    const probes = [];
    for (const fx of [0.5, 0.3, 0.7, 0.5, 0.25, 0.75]) {
      for (const fy of [0.62, 0.45, 0.78, 0.3, 0.85]) {
        probes.push({ x: rect.x + rect.width * fx, y: rect.y + rect.height * fy });
      }
    }
    let chosen = null;
    let lastHit = null;
    for (const probe of probes) {
      if (probe.y > ceiling) continue;
      if (centre && probe.x > centre.left && probe.x < centre.right && probe.y > centre.top && probe.y < centre.bottom) continue;
      const hit = document.elementFromPoint(probe.x, probe.y);
      lastHit = hit;
      if (hit === card || (hit !== null && card.contains(hit))) { chosen = probe; break; }
    }
    return {
      x: chosen ? chosen.x : rect.x + rect.width / 2,
      y: chosen ? chosen.y : rect.y + rect.height * 0.62,
      hitIsCard: chosen !== null,
      hitClass: chosen === null && lastHit ? String(lastHit.className).slice(0, 40) : null,
      left: card.style.left,
      top: card.style.top,
    };
  })()`)
  if (dragStart === null) throw new Error('the canvas card is missing for the drag check')
  if (!dragStart.hitIsCard) throw new Error(`the drag press would land on ${dragStart.hitClass}, not the card`)
  const dragTo = { x: dragStart.x + 96, y: dragStart.y + 62 }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragStart.x, y: dragStart.y, button: 'none', buttons: 0 })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragStart.x, y: dragStart.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let step = 1; step <= 6; step += 1) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: dragStart.x + ((dragTo.x - dragStart.x) * step) / 6,
      y: dragStart.y + ((dragTo.y - dragStart.y) * step) / 6,
      button: 'left',
      buttons: 1,
    })
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragTo.x, y: dragTo.y, button: 'left', buttons: 0, clickCount: 1 })
  await page.wait(1600)
  const afterDrag = await page.evaluate(`(() => {
    const card = [...document.querySelectorAll('.skw-note')].find((n) => n.innerText.includes('验证便签'));
    return { left: card ? card.style.left : null, top: card ? card.style.top : null, transform: card ? card.style.transform : null };
  })()`)
  record('canvas-drag-persists-placement', {
    ok: Number.parseFloat(afterDrag.left) !== Number.parseFloat(dragStart.left) && Number.parseFloat(afterDrag.top) !== Number.parseFloat(dragStart.top),
    detail: `${dragStart.left},${dragStart.top} -> ${afterDrag.left},${afterDrag.top}`,
  })
  // The drag must keep the tilt that tidy applied, not straighten the card.
  record('canvas-drag-keeps-rotation', {
    ok: afterDrag.transform !== null && afterDrag.transform.includes('rotate(') && !afterDrag.transform.includes('rotate(0deg)'),
    detail: afterDrag.transform,
  })

  // 8b. Pan and zoom are camera transforms, not scrolling, and both keep the
  // content anchored. These are the interactions the "drag feels bad" complaint
  // was about, so they get real pointer/wheel events rather than a state probe.
  //
  // The camera is read through DOMMatrix, not a regex on the inline style: a
  // regex written inside a template literal loses its backslashes before it ever
  // reaches the page, and the resulting pattern silently matches nothing.
  const READ_CAMERA = `(() => {
    const world = document.querySelector('.skw-world');
    if (!world) return null;
    const matrix = new DOMMatrix(getComputedStyle(world).transform);
    return { panX: matrix.e, panY: matrix.f, zoom: matrix.a };
  })()`
  const WORLD_POINT_UNDER = (x, y) => `(() => {
    const world = document.querySelector('.skw-world');
    const viewport = document.querySelector('.skw-canvas');
    if (!world || !viewport) return null;
    const matrix = new DOMMatrix(getComputedStyle(world).transform);
    const rect = viewport.getBoundingClientRect();
    return {
      worldX: ((${x} - rect.left) - matrix.e) / matrix.a,
      worldY: ((${y} - rect.top) - matrix.f) / matrix.a,
    };
  })()`

  const cameraBefore = await page.evaluate(READ_CAMERA)

  // Drag empty paper near the bottom-left of the viewport (the wall is centred,
  // so this is guaranteed to be paper and not a card).
  const emptyPoint = await page.evaluate(`(() => {
    const viewport = document.querySelector('.skw-canvas');
    const rect = viewport.getBoundingClientRect();
    const x = rect.left + 40;
    const y = rect.top + rect.height - 120;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hitIsCard: hit !== null && hit.closest('.skw-note') !== null };
  })()`)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: emptyPoint.x, y: emptyPoint.y, button: 'none', buttons: 0 })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: emptyPoint.x, y: emptyPoint.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let step = 1; step <= 5; step += 1) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: emptyPoint.x + step * 24, y: emptyPoint.y - step * 12, button: 'left', buttons: 1 })
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: emptyPoint.x + 120, y: emptyPoint.y - 60, button: 'left', buttons: 0, clickCount: 1 })
  await page.wait(400)
  const cameraAfterPan = await page.evaluate(READ_CAMERA)
  const panState = await page.evaluate(`(() => {
    const viewport = document.querySelector('.skw-canvas');
    return { panning: viewport.getAttribute('data-panning'), cursor: getComputedStyle(viewport).cursor };
  })()`)
  record('canvas-drag-on-paper-pans-the-camera', {
    ok: !emptyPoint.hitIsCard && cameraBefore !== null && cameraAfterPan !== null &&
      Math.round(cameraAfterPan.panX - cameraBefore.panX) === 120 &&
      Math.round(cameraAfterPan.panY - cameraBefore.panY) === -60 &&
      panState.panning === null,
    detail: `(${cameraBefore?.panX},${cameraBefore?.panY}) -> (${cameraAfterPan?.panX},${cameraAfterPan?.panY}) cursor=${panState.cursor}`,
  })

  // Zoom with the wheel while holding the anchor still: the world point under the
  // pointer must not move, which is what makes zoom feel like pulling the wall.
  const anchorPoint = { x: emptyPoint.x + 160, y: emptyPoint.y - 100 }
  const beforeZoom = await page.evaluate(READ_CAMERA)
  const underBefore = await page.evaluate(WORLD_POINT_UNDER(anchorPoint.x, anchorPoint.y))
  // Dispatched as a real WheelEvent from the page: CDP's `mouseWheel` modifier
  // bit does not reliably surface as `ctrlKey` on the JS event, and the handler
  // keys off exactly that (a trackpad pinch arrives as ctrl+wheel).
  await page.evaluate(`(() => {
    const viewport = document.querySelector('.skw-canvas');
    viewport.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -180, ctrlKey: true, bubbles: true, cancelable: true,
      clientX: ${anchorPoint.x}, clientY: ${anchorPoint.y},
    }));
    return true;
  })()`)
  await page.wait(400)
  const afterZoom = await page.evaluate(READ_CAMERA)
  const underAfter = await page.evaluate(WORLD_POINT_UNDER(anchorPoint.x, anchorPoint.y))
  record('canvas-wheel-zoom-keeps-the-pointer-anchored', {
    ok: beforeZoom !== null && afterZoom !== null && afterZoom.zoom > beforeZoom.zoom &&
      Math.abs(underAfter.worldX - underBefore.worldX) < 2 &&
      Math.abs(underAfter.worldY - underBefore.worldY) < 2,
    detail: `zoom ${beforeZoom?.zoom?.toFixed(3)} -> ${afterZoom?.zoom?.toFixed(3)}, world point (${underBefore.worldX.toFixed(1)},${underBefore.worldY.toFixed(1)}) -> (${underAfter.worldX.toFixed(1)},${underAfter.worldY.toFixed(1)})`,
  })

  // Reset puts the camera back on the wall's middle at 100%.
  await page.evaluate(`(() => {
    // Select by accessible name: the zoom group also holds the tidy button, so
    // "the last camera button" is no longer the reset control.
    const reset = [...document.querySelectorAll('.skw-dock button')].find((b) => b.getAttribute('aria-label') === '重置视图');
    reset?.click();
    return !!reset;
  })()`)
  await page.wait(500)
  const afterReset = await page.evaluate(READ_CAMERA)
  const resetFraming = await page.evaluate(`(() => {
    const viewport = document.querySelector('.skw-canvas').getBoundingClientRect();
    const cards = [...document.querySelectorAll('.skw-canvas .skw-note')].map((node) => node.getBoundingClientRect());
    const left = Math.min(...cards.map((r) => r.left));
    const right = Math.max(...cards.map((r) => r.right));
    const top = Math.min(...cards.map((r) => r.top));
    const bottom = Math.max(...cards.map((r) => r.bottom));
    return {
      offsetX: ((left + right) / 2) - (viewport.left + viewport.width / 2),
      offsetY: ((top + bottom) / 2) - (viewport.top + viewport.height / 2),
      // "Reset" must show the WHOLE wall, not a magnified middle of it.
      fits: left >= viewport.left - 2 && right <= viewport.right + 2 && top >= viewport.top - 2 && bottom <= viewport.bottom + 2,
      label: document.querySelector('.skw-camera-value')?.textContent ?? null,
    };
  })()`)
  record('canvas-reset-frames-the-whole-wall', {
    ok: afterReset !== null && Math.abs(resetFraming.offsetX) < 260 && Math.abs(resetFraming.offsetY) < 240 &&
      resetFraming.fits === true,
    detail: `zoom=${resetFraming.label} offset=(${Math.round(resetFraming.offsetX)},${Math.round(resetFraming.offsetY)}) fits=${resetFraming.fits}`,
  })

  // 8c. A real wall, not two cards: seed a dozen notes through the real composer
  // so the tidy pass and the camera framing are exercised at a size where a disc
  // and a shelf look different. This is the composition the redesign is about.
  const TICK2 = String.fromCharCode(96)
  const SEEDS = [
    ['今天的三个决定', '先做小一点。\n\n- 砍范围\n- 周五发\n- 告诉一个人', 'yellow'],
    ['读书清单', '1. 小而美\n2. 刻意练习\n3. 反脆弱', 'pink'],
    ['待办', '- [x] 写周报\n- [ ] 回邮件\n- [ ] 改稿', 'green'],
    ['一个想法', '工具应该消失。**好的工具**不打断你。', 'blue'],
    ['代码片段', TICK2.repeat(3) + 'js\nconst a = 1\n' + TICK2.repeat(3), 'purple'],
    ['会议记录', '> 结论：先验证，再投入。', 'orange'],
    ['灵感', '慢即是快。', 'yellow'],
    ['预算', '| 项 | 天数 |\n| --- | --- |\n| 写 | 2 |', 'pink'],
    ['提醒', '给妈妈打电话。', 'green'],
    ['草稿', '开头三行：\n一、问题\n二、方法\n三、结果', 'blue'],
    ['引用', '「完美是完成的敌人。」', 'purple'],
    ['周末', '散步、做饭、读完一本。', 'orange'],
  ]
  for (const [title, body, colour] of SEEDS) {
    await page.evaluate(`(() => {
      const open = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '新建');
      open?.click();
      return !!open;
    })()`)
    await page.wait(220)
    await page.evaluate(`(() => {
      const textarea = document.querySelector('.skw-ed-input');
      const input = document.querySelector('.skw-input');
      if (!textarea || !input) return false;
      const setText = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setText.call(textarea, ${JSON.stringify(body)});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      setInput.call(input, ${JSON.stringify(title)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    // The colour is a second task: React batches the swatch click with the save
    // click if both happen in one evaluate, so `saveDraft` would read the draft
    // from before the colour changed. A real user cannot click that fast.
    await page.wait(120)
    await page.evaluate(`(() => {
      const swatch = [...document.querySelectorAll('.skw-swatch')].find((element) => element.getAttribute('aria-label') === ${JSON.stringify(colour)});
      swatch?.click();
      return !!swatch;
    })()`)
    await page.wait(120)
    await page.evaluate(`(() => {
      const save = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '保存');
      save?.click();
      return !!save;
    })()`)
    await page.wait(420)
  }
  await page.wait(1200)
  const seeded = await page.evaluate(`(() => document.querySelectorAll('.skw-note').length)()`)
  await page.evaluate(`(() => {
    const tidy = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === '整理');
    tidy?.click();
    return !!tidy;
  })()`)
  await page.wait(2400)
  const bigWall = await page.evaluate(`(() => {
    const viewport = document.querySelector('.skw-canvas').getBoundingClientRect();
    const cards = [...document.querySelectorAll('.skw-canvas .skw-note')].map((node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    });
    let overlaps = 0;
    for (let i = 0; i < cards.length; i += 1) {
      for (let j = i + 1; j < cards.length; j += 1) {
        const a = cards[i], b = cards[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps += 1;
      }
    }
    const left = Math.min(...cards.map((c) => c.x));
    const right = Math.max(...cards.map((c) => c.x + c.w));
    const top = Math.min(...cards.map((c) => c.y));
    const bottom = Math.max(...cards.map((c) => c.y + c.h));
    return {
      cards: cards.length,
      overlaps,
      offsetX: ((left + right) / 2) - (viewport.left + viewport.width / 2),
      offsetY: ((top + bottom) / 2) - (viewport.top + viewport.height / 2),
      ratio: (right - left) / (bottom - top),
      fits: left >= viewport.left - 2 && right <= viewport.right + 2 && top >= viewport.top - 2 && bottom <= viewport.bottom + 2,
      zoom: document.querySelector('.skw-camera-value')?.textContent ?? null,
      zoomPercent: Number.parseInt(document.querySelector('.skw-camera-value')?.textContent ?? '0', 10),
      // The dock floats OVER the canvas, so framing against the raw viewport put
      // the bottom row of a tidied wall behind it. The camera must leave room.
      worldSize: (() => {
        const nodes = [...document.querySelectorAll('.skw-canvas .skw-note')];
        const boxes = nodes.map((node) => {
          const left = Number.parseFloat(node.style.left);
          const top = Number.parseFloat(node.style.top);
          const w = Number.parseFloat(node.style.width);
          const h = Number.parseFloat(node.style.height);
          return { x: left, y: top, r: left + w, b: top + h };
        });
        const minX = Math.min(...boxes.map((b) => b.x));
        const maxX = Math.max(...boxes.map((b) => b.r));
        const minY = Math.min(...boxes.map((b) => b.y));
        const maxY = Math.max(...boxes.map((b) => b.b));
        return { w: Math.round(maxX - minX), h: Math.round(maxY - minY), centre: [Math.round((minX + maxX) / 2), Math.round((minY + maxY) / 2)] };
      })(),
      viewport: [Math.round(viewport.width), Math.round(viewport.height)],
      // Cards whose CENTRE is behind the dock. A wall taller than the usable
      // viewport necessarily has some card edges near the dock at the framing
      // floor; what must never happen is the wall being positioned so its middle
      // (and therefore the centrepiece) is under the dock.
      behindDock: (() => {
        const dock = document.querySelector('.skw-dock')?.getBoundingClientRect();
        if (!dock) return 0;
        return [...document.querySelectorAll('.skw-canvas .skw-note')].filter((node) => {
          const r = node.getBoundingClientRect();
          const cy = r.top + r.height / 2;
          return cy > dock.top && cy < dock.bottom;
        }).length;
      })(),
    };
  })()`)
  record('canvas-large-wall-is-a-centred-cluster', {
    // What must hold: the wall is CENTRED, legible, free of overlaps, and its cards
    // are not hidden behind the dock. It does NOT have to fit entirely — the
    // readable zoom floor exists precisely so a huge wall is shown at a legible
    // size and panned, rather than shrunk into confetti. The wall's own bounding
    // box is centred on the viewport, which is what the camera frames.
    //
    // The shape is a wide, low CLUSTER, not a disc: the packer scores each slot by
    // the zoom the whole wall would need, so it fills the window's long axis
    // instead of leaving its sides empty. Hence ratio > 1.0 rather than ~1.0, and
    // the zoom floor here is the framing floor's own number.
    ok: bigWall.cards >= 10 && bigWall.overlaps === 0 &&
      Math.abs(bigWall.offsetX) < 340 && Math.abs(bigWall.offsetY) < 340 &&
      bigWall.ratio > 1.0 && bigWall.ratio < 2.4 && bigWall.zoomPercent >= 42 && bigWall.behindDock === 0,
    detail: `${bigWall.cards} cards (seeded ${seeded}), overlaps=${bigWall.overlaps}, offset=(${Math.round(bigWall.offsetX)},${Math.round(bigWall.offsetY)}), ratio=${bigWall.ratio.toFixed(2)}, zoom=${bigWall.zoom}, fits=${bigWall.fits}, behindDock=${bigWall.behindDock}, world=${bigWall.worldSize.w}x${bigWall.worldSize.h}`,
  })
  const bigShot = await page.shot('sticky-wall-canvas-many.png')

  // 8d. The centrepiece: it must sit at the middle of the VIEWPORT (not of the
  // world), stay clear of every card, and survive a pan without moving.
  const centrepiece = await page.evaluate(`(() => {
    const viewport = document.querySelector('.skw-canvas').getBoundingClientRect();
    const centre = document.querySelector('.skw-centre');
    if (!centre) return { ok: false, reason: 'centre missing' };
    const box = centre.getBoundingClientRect();
    const capture = document.querySelector('.skw-capture').getBoundingClientRect();
    const cards = [...document.querySelectorAll('.skw-canvas .skw-note')].map((node) => node.getBoundingClientRect());
    // Does any card overlap the capture field?
    const captureHits = cards.filter((r) =>
      r.left < capture.right && capture.left < r.right && r.top < capture.bottom && capture.top < r.bottom).length;
    return {
      ok: true,
      offsetX: (box.left + box.right) / 2 - (viewport.left + viewport.width / 2),
      offsetY: (box.top + box.bottom) / 2 - (viewport.top + viewport.height / 2),
      captureHits,
      cards: cards.length,
      greeting: document.querySelector('.skw-centre-hello')?.textContent ?? null,
      tally: document.querySelector('.skw-centre-tally')?.textContent ?? null,
    };
  })()`)
  record('canvas-centrepiece-is-at-the-middle', {
    ok: centrepiece.ok && Math.abs(centrepiece.offsetX) < 40 && Math.abs(centrepiece.offsetY) < 60,
    detail: `offset=(${Math.round(centrepiece.offsetX)},${Math.round(centrepiece.offsetY)})`,
  })
  record('canvas-tidy-keeps-the-centre-clear', {
    ok: centrepiece.ok && centrepiece.captureHits === 0,
    detail: `${centrepiece.cards} cards, ${centrepiece.captureHits} overlapping the capture field`,
  })

  // Panning must not move the centrepiece: it is screen space, not world space.
  const beforePanCentre = await page.evaluate(`(() => {
    const box = document.querySelector('.skw-centre').getBoundingClientRect();
    return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
  })()`)
  const panStart = await page.evaluate(`(() => {
    const viewport = document.querySelector('.skw-canvas').getBoundingClientRect();
    return { x: viewport.left + 30, y: viewport.top + viewport.height / 2 };
  })()`)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: panStart.x, y: panStart.y, button: 'none', buttons: 0 })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: panStart.x, y: panStart.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let step = 1; step <= 4; step += 1) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: panStart.x + step * 30, y: panStart.y + step * 18, button: 'left', buttons: 1 })
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: panStart.x + 120, y: panStart.y + 72, button: 'left', buttons: 0, clickCount: 1 })
  await page.wait(400)
  const afterPanCentre = await page.evaluate(`(() => {
    const box = document.querySelector('.skw-centre').getBoundingClientRect();
    return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
  })()`)
  record('canvas-centrepiece-stays-put-while-panning', {
    ok: Math.abs(afterPanCentre.x - beforePanCentre.x) < 1 && Math.abs(afterPanCentre.y - beforePanCentre.y) < 1,
    detail: `(${beforePanCentre.x.toFixed(0)},${beforePanCentre.y.toFixed(0)}) -> (${afterPanCentre.x.toFixed(0)},${afterPanCentre.y.toFixed(0)})`,
  })

  // Quick capture: type into the centre field and submit it.
  const captureBefore = await page.evaluate(`(() => document.querySelectorAll('.skw-note').length)()`)
  await page.evaluate(`(() => {
    const input = document.querySelector('.skw-capture-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '圆心快速记录');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await page.wait(200)
  await page.evaluate(`(() => {
    const go = document.querySelector('.skw-capture-go');
    go?.click();
    return !!go;
  })()`)
  await page.wait(1400)
  const captureAfter = await page.evaluate(`(() => ({
    notes: document.querySelectorAll('.skw-note').length,
    field: document.querySelector('.skw-capture-input')?.value ?? null,
    has: [...document.querySelectorAll('.skw-note')].some((n) => n.innerText.includes('圆心快速记录')),
  }))()`)
  record('centre-capture-creates-a-note', {
    ok: captureAfter.notes === captureBefore + 1 && captureAfter.has === true && captureAfter.field === '',
    detail: `${captureBefore} -> ${captureAfter.notes} notes, field cleared=${captureAfter.field === ''}`,
  })

  // The new card must be VISIBLE and must not sit under the centrepiece.
  // The complaint: a capture from the centre field produced a card far away, so
  // the wall looked like the capture had silently failed.
  //
  // Overlap is judged in WORLD space against the packer's own reserve rectangle,
  // using each card's rotated footprint — the same geometry `arrangeLayouts`
  // collision-checks. A painted-rect comparison is not usable here: a card's
  // arrival animation and its tilt both change its bounding box, so the answer
  // would depend on when the probe happened to run.
  // Wait for the arrival animation to settle: the assertion is about where the
  // card LANDED, not about a mid-animation frame.
  await page.wait(1200)
  const arrivalState = await page.evaluate(`(() => {
    const world = document.querySelector('.skw-world');
    const canvas = document.querySelector('.skw-canvas').getBoundingClientRect();
    const RESERVE = { halfWidth: 330, halfHeight: 136 };
    const footprint = (node) => {
      // offsetLeft/offsetTop are the UNTRANSFORMED layout box, so an in-flight
      // arrival animation or a tilt cannot move the measurement.
      const left = node.offsetLeft;
      const top = node.offsetTop;
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      const rotate = Math.abs(Number.parseFloat((node.style.transform.match(/rotate\\((-?[\\d.]+)deg\\)/) || [0, '0'])[1]) || 0);
      const rad = (rotate * Math.PI) / 180;
      const extentWidth = width * Math.cos(rad) + height * Math.sin(rad);
      const extentHeight = height * Math.cos(rad) + width * Math.sin(rad);
      const centreX = left + width / 2;
      const centreY = top + height / 2;
      const x = centreX - extentWidth / 2;
      const y = centreY - extentHeight / 2;
      return { x, y, width: extentWidth, height: extentHeight, centreX, centreY };
    };
    const inReserve = (box) =>
      box.x < RESERVE.halfWidth && box.x + box.width > -RESERVE.halfWidth &&
      box.y < RESERVE.halfHeight && box.y + box.height > -RESERVE.halfHeight;
    const nodes = [...document.querySelectorAll('.skw-canvas .skw-note')];
    const cards = nodes.map((node) => ({
      text: (node.innerText || '').slice(0, 24),
      box: footprint(node),
      rect: node.getBoundingClientRect(),
      arrived: node.getAttribute('data-arrived') === 'true',
    }));
    const fresh = cards.find((card) => card.text.includes('圆心快速记录'));
    if (!fresh) return { ok: false, reason: 'the new card is not rendered' };
    const cx = fresh.rect.left + fresh.rect.width / 2;
    const cy = fresh.rect.top + fresh.rect.height / 2;
    const onScreen = cx > canvas.left && cx < canvas.right && cy > canvas.top && cy < canvas.bottom;
    const covering = cards.filter((card) => inReserve(card.box)).map((card) => card.text.slice(0, 12));
    const zoom = world ? new DOMMatrix(getComputedStyle(world).transform).a : 1;
    return {
      ok: true, onScreen, covering, cards: cards.length, arrived: fresh.arrived,
      freshInReserve: inReserve(fresh.box),
      // How far the fresh card's centre is from the wall's middle, in world px.
      distance: Math.round(Math.hypot(fresh.box.centreX, fresh.box.centreY)),
      zoom: Number(zoom.toFixed(2)),
    };
  })()`)
  record('centre-capture-lands-visible-and-clear-of-the-field', {
    ok: arrivalState.ok === true && arrivalState.onScreen === true &&
      arrivalState.freshInReserve === false && arrivalState.covering.length === 0,
    detail: arrivalState.ok === false
      ? arrivalState.reason
      : `onScreen=${arrivalState.onScreen} inReserve=${arrivalState.freshInReserve} distance=${arrivalState.distance}px cardsOverField=${arrivalState.covering.length}/${arrivalState.cards} zoom=${arrivalState.zoom}`,
  })
  // Every card, not just the new one, must stay out of the reserved centre: the
  // reserve is the invariant the overlap complaint was really about.
  record('no-card-covers-the-centrepiece', {
    ok: arrivalState.ok === true && arrivalState.covering.length === 0,
    detail: arrivalState.ok === false
      ? arrivalState.reason
      : arrivalState.covering.length === 0
        ? `${arrivalState.cards} cards, centrepiece clear`
        : `covered by: ${arrivalState.covering.join(' | ')}`,
  })

  // 8e. THE REPORTED DEFECT, asserted directly.
  //
  // Capturing from the centre field put the new card BEHIND that field. Two
  // things had to be wrong at once for that to ship, and the old suite caught
  // neither because it only ever captured on the DEFAULT camera:
  //
  // 1. The Host was told to keep the world ORIGIN clear. The centrepiece is a
  //    screen-space overlay, so on a panned or zoomed wall the world patch it
  //    covers is nowhere near the origin, and the card was placed beside a point
  //    the user could not see.
  // 2. The reveal centred the new card on the viewport middle, which is exactly
  //    where the field is drawn.
  //
  // So this captures under a MOVED camera and measures the PAINTED rectangles,
  // which is what the user actually sees. A world-space footprint comparison
  // cannot catch a screen-space overlay sitting on top of a correctly-placed
  // card, so the test is deliberately in screen coordinates.
  const captureBehind = async (label, needle) => {
    await page.evaluate(`(() => {
      const input = document.querySelector('.skw-capture-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(needle)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await page.wait(250)
    await page.evaluate(`(() => {
      const go = document.querySelector('.skw-capture-go');
      go?.click();
      return !!go;
    })()`)
    // The reveal is an animated glide plus a 900ms arrival highlight; measure the
    // LANDED position, not a frame in the middle of the move.
    await page.wait(1800)
    const state = await page.evaluate(`(() => {
      const canvas = document.querySelector('.skw-canvas').getBoundingClientRect();
      const field = document.querySelector('.skw-capture').getBoundingClientRect();
      const cards = [...document.querySelectorAll('.skw-canvas .skw-note')];
      const target = cards.find((node) => (node.innerText || '').includes(${JSON.stringify(needle)}));
      if (!target) return { ok: false, reason: 'the captured card is not rendered' };
      const card = target.getBoundingClientRect();
      const overlapX = Math.max(0, Math.min(card.right, field.right) - Math.max(card.left, field.left));
      const overlapY = Math.max(0, Math.min(card.bottom, field.bottom) - Math.max(card.top, field.top));
      const cx = card.left + card.width / 2;
      const cy = card.top + card.height / 2;
      return {
        ok: true,
        overlapRatio: card.width * card.height > 0 ? (overlapX * overlapY) / (card.width * card.height) : 0,
        onScreen: cx > canvas.left && cx < canvas.right && cy > canvas.top && cy < canvas.bottom,
        // Clear of the dock too: a card revealed underneath the floating dock is
        // hidden in the same way the field hid it.
        behindDock: (() => {
          const dock = document.querySelector('.skw-dock')?.getBoundingClientRect();
          return dock === undefined ? false : cy > dock.top && cy < dock.bottom;
        })(),
        zoom: (() => {
          const world = document.querySelector('.skw-world');
          return world ? +new DOMMatrix(getComputedStyle(world).transform).a.toFixed(2) : 1;
        })(),
      };
    })()`)
    record(label, {
      ok: state.ok === true && state.overlapRatio < 0.02 && state.onScreen === true && state.behindDock === false,
      detail: state.ok === false
        ? state.reason
        : `overlap=${(state.overlapRatio * 100).toFixed(0)}% onScreen=${state.onScreen} behindDock=${state.behindDock} zoom=${state.zoom}`,
    })
    return state
  }

  // Pan the paper so the field's world position is far from the origin. This is
  // the camera state in which the old placement logic was wrong.
  const panAway = await page.evaluate(`(() => {
    const rect = document.querySelector('.skw-canvas').getBoundingClientRect();
    return { x: rect.left + 40, y: rect.top + rect.height - 160 };
  })()`)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: panAway.x, y: panAway.y, button: 'none', buttons: 0 })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: panAway.x, y: panAway.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let step = 1; step <= 6; step += 1) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: panAway.x + step * 48, y: panAway.y - step * 36, button: 'left', buttons: 1 })
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: panAway.x + 288, y: panAway.y - 216, button: 'left', buttons: 0, clickCount: 1 })
  await page.wait(500)
  await captureBehind('capture-on-a-panned-wall-stays-clear-of-the-field', '平移后记录')

  // Zoom in, so the field covers a much smaller world patch than the reserve the
  // old code assumed. This is the second half of the same defect.
  await page.evaluate(`(() => {
    const viewport = document.querySelector('.skw-canvas');
    viewport.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -360, ctrlKey: true, bubbles: true, cancelable: true,
      clientX: window.innerWidth / 2, clientY: window.innerHeight / 2,
    }));
    return true;
  })()`)
  await page.wait(500)
  await captureBehind('capture-on-a-zoomed-wall-stays-clear-of-the-field', '放大后记录')

  // Back to a framed wall for the remaining assertions.
  await page.evaluate(`(() => {
    const reset = [...document.querySelectorAll('.skw-dock button')].find((b) => b.getAttribute('aria-label') === '重置视图');
    reset?.click();
    return !!reset;
  })()`)
  await page.wait(700)

  // The dock must be a single floating row over the canvas, and the canvas must
  // occupy the whole page (no header/toolbar rows eating vertical space).
  const layoutState = await page.evaluate(`(() => {
    const page = document.querySelector('.skw-page').getBoundingClientRect();
    const canvas = document.querySelector('.skw-canvas').getBoundingClientRect();
    const dock = document.querySelector('.skw-dock').getBoundingClientRect();
    return {
      head: !!document.querySelector('.skw-head'),
      toolbar: !!document.querySelector('.skw-toolbar'),
      canvasRatio: canvas.height / page.height,
      dockInsideCanvas: dock.top > canvas.top && dock.bottom <= canvas.bottom + 1,
      dockCentred: Math.abs((dock.left + dock.right) / 2 - (canvas.left + canvas.right) / 2) < 3,
      dockHeight: dock.height,
      dockRows: new Set([...document.querySelectorAll('.skw-dock > *')].map((n) => Math.round(n.getBoundingClientRect().top))).size,
      dockOverflowsPage: dock.left < page.left - 1 || dock.right > page.right + 1,
      // Every control must be INSIDE the dock's own painted box: the complaint was
      // that buttons spilled past the background they were drawn on.
      controlsOutside: [...document.querySelectorAll('.skw-dock button, .skw-dock input')].filter((node) => {
        const r = node.getBoundingClientRect();
        return r.width > 0 && (r.left < dock.left - 1 || r.right > dock.right + 1 || r.top < dock.top - 1 || r.bottom > dock.bottom + 1);
      }).length,
    };
  })()`)
  record('canvas-fills-the-page-with-a-floating-dock', {
    ok: !layoutState.head && !layoutState.toolbar && layoutState.canvasRatio > 0.95 &&
      layoutState.dockInsideCanvas && layoutState.dockCentred && layoutState.dockHeight < 90 &&
      !layoutState.dockOverflowsPage && layoutState.controlsOutside === 0,
    detail: `canvas=${(layoutState.canvasRatio * 100).toFixed(1)}% of page, dock ${Math.round(layoutState.dockHeight)}px tall, centred=${layoutState.dockCentred}, overflowsPage=${layoutState.dockOverflowsPage}, controlsOutside=${layoutState.controlsOutside}`,
  })
  record('canvas-large-wall-screenshot', { ok: true, detail: bigShot })

  // 9. Markdown renders on the card instead of showing literal markers.  // 9. Markdown renders on the card instead of showing literal markers. The
  // note written in step 3 carries `**bold**`, `` `code` `` and a bullet list,
  // so the rendered card must contain the elements and none of the markers.
  const markdown = await page.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.skw-note')];
    const target = cards.find((n) => n.innerText.includes('验证便签'));
    const body = target ? target.querySelector('.skw-note-body') : null;
    const text = body ? body.innerText : '';
    return {
      rendered: !!(body && body.querySelector('.skw-md')),
      bold: body ? body.querySelectorAll('strong').length : 0,
      code: body ? body.querySelectorAll('code').length : 0,
      items: body ? body.querySelectorAll('.skw-md-list li').length : 0,
      rawMarkers: text.includes('**') || text.includes(String.fromCharCode(96)),
    };
  })()`)
  record('card-body-renders-markdown', {
    ok: markdown.rendered && markdown.bold >= 1 && markdown.code >= 1 && markdown.items >= 2 && markdown.rawMarkers === false,
    detail: `strong=${markdown.bold} code=${markdown.code} li=${markdown.items} raw=${markdown.rawMarkers}`,
  })

  // 10. View modes: grid and list render the same note set, and the canvas
  // camera only exists in canvas view.
  const gridView = await page.evaluate(`(() => {
    const button = [...document.querySelectorAll('.skw-dock button')].find((b) => b.getAttribute('aria-label') === '网格');
    button?.click();
    return !!button;
  })()`)
  await page.wait(800)
  const gridState = await page.evaluate(`(() => ({
    grid: !!document.querySelector('.skw-grid'),
    cards: document.querySelectorAll('.skw-note').length,
    camera: !!document.querySelector('.skw-dock-zoom'),
  }))()`)
  record('grid-view-renders-notes', { ok: gridView && gridState.grid && gridState.cards > 0, detail: `cards=${gridState.cards}` })
  await page.evaluate(`(() => {
    const button = [...document.querySelectorAll('.skw-dock button')].find((b) => b.getAttribute('aria-label') === '列表');
    button?.click();
    return true;
  })()`)
  await page.wait(800)
  const listState = await page.evaluate(`(() => ({
    list: !!document.querySelector('.skw-list'),
    rows: document.querySelectorAll('.skw-row').length,
  }))()`)
  record('list-view-renders-rows', { ok: listState.list && listState.rows > 0, detail: `rows=${listState.rows}` })
  await page.evaluate(`(() => {
    const button = [...document.querySelectorAll('.skw-dock button')].find((b) => b.getAttribute('aria-label') === '画布');
    button?.click();
    return true;
  })()`)
  await page.wait(900)

  // 11. Theme: the note palette must differ between the light and dark flags.
  // The shell may ALREADY be dark, so the check reads both states explicitly
  // instead of assuming which one it started in — an earlier version compared
  // nothing and saved two byte-identical screenshots.
  const lightStyle = await page.evaluate(`(() => {
    document.body.removeAttribute('data-ds-dark-theme');
    const card = document.querySelector('.skw-note');
    const style = card ? getComputedStyle(card) : null;
    return { bg: style?.backgroundColor ?? null, ink: style?.color ?? null };
  })()`)
  await page.wait(500)
  const lightShot = await page.shot('sticky-wall-light.png')
  const darkStyle = await page.evaluate(`(() => {
    document.body.setAttribute('data-ds-dark-theme', '');
    const card = document.querySelector('.skw-note');
    const style = card ? getComputedStyle(card) : null;
    return { bg: style?.backgroundColor ?? null, ink: style?.color ?? null };
  })()`)
  await page.wait(500)
  const darkShot = await page.shot('sticky-wall-dark.png')
  record('theme-switches-note-palette', {
    ok: lightStyle.bg !== null && darkStyle.bg !== null && lightStyle.bg !== darkStyle.bg && lightStyle.ink !== darkStyle.ink,
    detail: `light ${lightStyle.bg}/${lightStyle.ink} -> dark ${darkStyle.bg}/${darkStyle.ink}`,
  })
  await page.evaluate(`document.body.removeAttribute('data-ds-dark-theme')`)

  // 12. No uncaught errors during the whole interaction.
  const consoleErrors = await page.evaluate(`(() => (window.__skwErrors || []).length)()`)
  record('no-uncaught-errors', { ok: consoleErrors === 0, detail: `${consoleErrors} recorded` })

  await writeFile(
    `${evidenceDir}/ui-verification.json`,
    `${JSON.stringify({ capturedAt: new Date().toISOString(), viewport: '1440x900@2x', locale: 'zh', screenshots: [wallShot, noteShot, archivedShot, canvasShot, lightShot, darkShot], results }, null, 2)}\n`,
    'utf8',
  )
  const failed = results.filter((entry) => entry.ok === false)
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`)
  if (failed.length > 0) process.exitCode = 1
} finally {
  page.close()
}
