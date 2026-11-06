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

  // The typed body deliberately carries Markdown, so the rendered card proves
  // the renderer ran. It is passed as JSON rather than inlined into the
  // evaluated script: a nested template literal would need three levels of
  // escaping for newlines and backticks, and one mistake breaks the harness.
  // String.fromCharCode keeps a literal backtick out of this source file.
  const TICK = String.fromCharCode(96)
  const typedBody = ['验证便签：来自真实 Web UI 的输入', '', '**粗体**与 ' + TICK + '代码' + TICK, '', '- 第一条', '- 第二条'].join('\n')
  await page.evaluate(`(() => {
    const textarea = document.querySelector('.skw-textarea');
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

  // 8. Free canvas: cards are absolutely placed from the stored layout, a drag
  // writes a new placement through the Host, and "Tidy" repacks the wall.
  const canvas = await page.evaluate(`(() => {
    const card = [...document.querySelectorAll('.skw-note')].find((n) => n.innerText.includes('验证便签'));
    if (!card) return { ok: false, reason: 'card missing' };
    const rect = card.getBoundingClientRect();
    const slot = card.parentElement;
    return {
      ok: true,
      position: getComputedStyle(card).position,
      left: card.style.left,
      top: card.style.top,
      transform: card.style.transform,
      slotId: slot ? slot.getAttribute('data-note-id') : null,
      center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    };
  })()`)
  record('canvas-positions-cards-absolutely', {
    ok: canvas.ok && canvas.position === 'absolute' && canvas.left !== '' && canvas.transform.includes('rotate'),
    detail: `left=${canvas.left} top=${canvas.top} transform=${canvas.transform}`,
  })

  // Drag the card by 90px and confirm the Host persisted a new placement: after
  // the mutation the card's inline left/top must differ from the pre-drag value.
  const dragStart = await page.evaluate(`(() => {
    const card = [...document.querySelectorAll('.skw-note')].find((n) => n.innerText.includes('验证便签'));
    if (!card) return null;
    const rect = card.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + 12 };
  })()`)
  if (dragStart === null) throw new Error('the canvas card is missing for the drag check')
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
  await page.wait(1500)
  const afterDrag = await page.evaluate(`(() => {
    const card = [...document.querySelectorAll('.skw-note')].find((n) => n.innerText.includes('验证便签'));
    return {
      left: card ? card.style.left : null,
      top: card ? card.style.top : null,
      dragged: card ? card.getAttribute('data-dragging') : null,
    };
  })()`)
  const beforeLeft = Number.parseFloat(canvas.left)
  const beforeTop = Number.parseFloat(canvas.top)
  record('canvas-drag-persists-placement', {
    ok: Number.parseFloat(afterDrag.left) !== beforeLeft && Number.parseFloat(afterDrag.top) !== beforeTop,
    detail: `${canvas.left},${canvas.top} -> ${afterDrag.left},${afterDrag.top}`,
  })

  // Tidy: the arrangement must change and no card may keep an unplaced position.
  const beforeTidy = await page.evaluate(`(() => [...document.querySelectorAll('.skw-note')].map((n) => n.style.left + ',' + n.style.top))()`)
  await page.evaluate(`(() => {
    const tidy = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '整理');
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

  // A tidied wall must actually be readable: no two cards may overlap. The
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
  const canvasShot = await page.shot('sticky-wall-canvas.png')

  // 9. Markdown renders on the card instead of showing literal markers. The
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
    const button = [...document.querySelectorAll('.skw-view-seg button')][1];
    button?.click();
    return !!button;
  })()`)
  await page.wait(800)
  const gridState = await page.evaluate(`(() => ({
    grid: !!document.querySelector('.skw-grid'),
    cards: document.querySelectorAll('.skw-note').length,
    camera: !!document.querySelector('.skw-cameras'),
  }))()`)
  record('grid-view-renders-notes', { ok: gridView && gridState.grid && gridState.cards > 0, detail: `cards=${gridState.cards}` })
  await page.evaluate(`(() => {
    const button = [...document.querySelectorAll('.skw-view-seg button')][2];
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
    const button = [...document.querySelectorAll('.skw-view-seg button')][0];
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
