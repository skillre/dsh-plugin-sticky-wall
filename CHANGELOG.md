# Changelog

## 0.8.1

### Patch Changes

- **修复 0.8.0 的迁移 bug：升级后旧便签看不到（数据没有丢）**
  
  0.8.0 打开旧 storage domain 时把表声明成了 `tables: { notes: {} }`，没有 `valueSchema`。DSH 的 storage 在加载每条记录时会执行 `tableSpec.valueSchema.parse(raw)`，因此**每一条记录都抛错**；又因为声明了 `invalidRecords: 'backup-and-skip'`，后端把每条便签都改名成 `<id>.json.bak.<时间戳>` 并当作不存在 —— 迁移于是读到 0 条，墙面被判定为全新空墙并播种了一张欢迎便签，用户看到的就是空墙。
  
  - **数据从未丢失**：14 个备份文件完好保留在 `~/.dsh/storages/skillre_sticky_wall/notes/`。
  - **已修复**：迁移读取器现在声明真实的宽松 zod schema（`passthrough`、字段可选），它的职责是**读取退役格式**而不是校验它，所以缺字段的记录会带着默认值迁移，而不是被隔离。
  - **为什么测试没抓到**：之前所有迁移测试都用 `readLegacy: async () => [...]` 直接注入数组，完全绕过了真实 domain 的加载路径。新增 `tests/legacy-reader.spec.ts` 驱动**真实 domain 契约**（没有 schema 就必须失败），并已验证：把修复回退后该测试立即失败。
  - **端到端补强**：`scripts/verify-isolated.mjs` 现在在首次启动前种入 legacy 记录，并断言它们全部带着属性、摆位和归档状态迁移成 `.md`；此前端到端完全不覆盖迁移（`legacy-*` 计数为 0）。

## 0.8.0

### Minor Changes

- 便签从 DSH storage domain 搬到了真正的 Markdown 文件，并把编辑器与保存可靠性一起重做。
  
  - **一张便签 = 一个 `.md` 文件**：便签不再存在 storage domain 的 JSON 记录里，而是 `$DSH_HOME/sticky-notes/` 下的 `<id>.md`，文件顶部的 YAML frontmatter 带 `id`/`schema`/`title`/`color`/`tags`/`pinned`/`archived`/`width`/`x`/`y`/`rotate`/`created`/`updated` 十三个属性，其后就是正文。它是用户的普通文件：任何编辑器都能打开，可以 `grep`、可以进 Git、可以直接备份。写入走「同目录临时文件 + `rename`」，一条便签要么是旧的要么是新的，不会是写了一半的。
  - **保留看不懂的东西**：更新版本或用户自己手写的 frontmatter 键会原样保留并在每次重写时写回；`schema` 比本版本新的文件会读成一张带「元数据异常」角标的卡片，而不是被静默改写或丢弃。frontmatter 写坏时也一样 —— 卡片照常显示、正文照常渲染、属性退化成默认值并挂角标，整份文件内容不会丢。这条 fail-soft 契约以前是 storage domain 的 `invalidRecords: 'backup-and-skip'` 白送的，现在由解析器自己保证。
  - **正文上限从 4000 字符提到 200,000**：便签现在是文件而不是 JSON 记录，一条便签可以是一篇短文。20 万是**资源护栏**而不是产品定位；另外单个便签文件超过 4 MiB 时会在读入前就被跳过（不交给解析器），并在 Host 日志里留一行说明。
  - **一次性迁移，且可回滚**：0.8.0 第一次启动时，如果便签目录还是空的、而旧 domain 里还有便签，就把每一条都转成 `.md`，属性、摆位、时间戳和 id 全部保留。写入同级暂存目录再一次性 `rename` 发布，所以中途崩溃不会留下半截目录；发布后还会逐条读回比对，确认字节真的 round-trip。迁移只读旧 domain，**从不删除也不回写**，所以回装 0.7.x 仍能读到原来的便签；迁移失败时什么也不写，墙面照常打开（空的而不是坏的），下次启动重试。成功后在便签旁边写一个 `migration.json` 记录时间和条数。
  - **新增配置键 `notesDir`**（默认为空 = 跟随 DSH home，回落 `~/.dsh/sticky-notes`；可写绝对路径或 `~/…`）。便签跨 workspace 共享。`maxNotes`、`enableAgentTool`、`seedWelcomeNote` 三个键不变。
  - **客户端编辑器重做**：正文编辑器加了 IME 安全的组合保护（组合期间所有快捷键静默、选区与光标不动，中文/日文输入不再丢字）、Markdown 插入工具栏（一～三级标题、引用、分隔线、代码块、无序/有序/待办列表、表格、粗体/斜体/删除线/行内代码/链接、插入当前时间）、随内容自动增高（超过视口 60% 后改为内部滚动）、`Tab`/`Shift + Tab` 整行缩进、回车自动续写列表。同时把 Markdown 摘要改成真正的纯文本 digest：列表行、aria-label 和搜索里不再看到 `##`、`**`、`- [ ]` 和表格竖线。
  - **可靠性修复**：保存失败的错误现在显示在编辑面板**内部**（以前显示在面板背后的页面横幅上，等于看不见）；上一个写入还没回来时的操作会**排队**而不是被静默丢掉（丢掉的那次拖动随后会被 reload 打回原处，而且没有任何解释）；有未保存草稿时离开会先问「放弃未保存的内容？」；墙面现在在窗口重新获得焦点、标签页重新可见以及一条慢轮询上刷新，每次只问 Host 的 revision，未变化就完全不碰 React state，所以 agent 或另一个窗口的改动会出现，但不会打断正在组合的输入法。
  - **agent 访问方式变了**：便签是文件，所以 agent 可以直接 `read` 便签文件（读不经过沙箱、不需要批准）；但用原生 `edit`/`write` 改便签文件在 `workspace-write` 下**第一次会被拒绝一次**，需要逐次调用带 `sandbox_permissions: danger-full-access` 和理由才放行 —— 除非用户把便签目录加进自己 profile 的 `additionalWritableRoots`。这条摩擦如实写进了 README，而不是含糊成「无缝」。
  - **`sticky_wall` 工具扩容**：新增 `read`（返回一条便签的**全文**和 `.md` 文件路径 —— 以前模型只能看到 140 字符的摘要，想展开一条便签还得让用户贴回来）和 `move`（摆一张卡片的位置）；`list` 现在真的遵守 `includeArchived`（以前这个参数被声明却忽略，工具自己的描述是假的）；`archive` 现在**必须**显式给出 `archived` 布尔值 —— 一个破坏性开关不能有默认值，模型本来是想恢复一条便签、只是没写这个字段时，以前会把它重新归档，正好做了反方向的事。

## 0.7.0

### Patch Changes

- A note captured from the centre field no longer lands behind that field.

  - The clear rectangle around the centrepiece now carries a **world position**, not only half-extents. The centrepiece is a screen-space overlay, so as the paper pans and zooms the patch of world it covers travels with it; the Host used to keep the world **origin** clear instead, and on a moved camera that is a different place entirely. A capture was therefore placed beside a point the user could not see.
  - The reveal no longer centres a new card on the viewport middle. That middle is exactly where the capture field is drawn, so "bringing the card into view" put it directly behind the field the user had just typed into. The card is now shown in the free space **beside** the field (above, below, left or right), choosing the side that needs the least camera movement, and zooming out only when no side fits.
  - Measured on the shipped build: the defect reproduced at **41% of the new card's own area** overlapping the field on the default camera, and 6 of 10 probed camera states left the card behind the field or off screen. After the fix all 10 land clear and on screen.
  - Tidy still anchors its contour on the origin, deliberately: it refits the camera afterwards, which puts the centrepiece back over the origin. Only the single-card placement follows the field's live position.
  - New regression coverage drives the real UI with a **panned** and a **zoomed** camera and measures the painted rectangles, because the old suite only ever captured on the default camera — which is why this shipped.

## 0.6.0

### Minor Changes

- Contour packing: a tidied wall is now a compact composition instead of a small ring seen from far away.

  - Tidy packs against the reserved rectangle's own **contour** instead of concentric circles. A ring's first radius is the reserve's half-DIAGONAL, so the innermost cards sat at the rectangle's corner distance in all four directions — including the four where the rectangle is barely one card away. A contour keeps each card one half-size from the reserve, so the same fourteen notes now fill **1261x705 instead of 1645x1794**.
  - Every candidate slot is scored by the **zoom the whole wall would need** in a reference viewport, then by how **window-shaped** the wall becomes, then by how **evenly spaced** it is. Packing for the frame rather than for the slot is what turns the result from a disc into a wide, low cluster: a 14-card wall now frames at **84% instead of 36%**, and the live 8-note wall at **86% instead of 51%**.
  - The contour grows its height faster than its width until it matches the reference window's aspect, so extra frames add room on the short edges where cards are useful rather than lengthening the left and right columns.
  - A never-placed note's derived position is now a **squashed** golden-angle spiral (1.4:1), so a wall written before the canvas existed also renders wide and framable instead of as a circle.
  - Centring now alternates the exact shift with a reserve repair until the shift is negligible, then settles any remaining violators without shifting. A single shift left a 20-card wall ~56px off centre.

## 0.5.0

### Minor Changes

- Ring-packed wall, a visible capture landing, and a compact dock.

  - The clear area around the centrepiece is now a **rectangle** measured against each card's edge, and it stays constant in world space at every zoom (the centrepiece counter-scales below 100%). A card can no longer sit behind the capture field, and dropping one there pushes it clear.
  - The dock keeps only the frequent actions — search, filters, three icon view buttons, zoom, tidy, new — with sort, show-archived and clear-archive in an overflow menu. One centred row that cannot overflow the page; the zoom readout is itself the reset button.
  - Creating a note places it in the **nearest free gap** instead of leaving its placement to an index-derived spiral that grew outward. The card pops in, holds a ring for 0.9s, and the camera glides to it (zooming out only as far as it takes) when the gap is outside the viewport.
  - Tidy packs the wall into **concentric rings** rather than a phyllotaxis first-fit spiral, which saturated at ~25% of the available area and spread fourteen cards over ~2700px. The same wall now fits in ~2300px and reads as a ring around its middle.
  - The welcome note no longer sits inside the reserved middle, so a brand-new wall opens with the capture field clear.

## 0.4.0

### Minor Changes

- Make the middle of the wall the point, and give the canvas the whole window.
  
  The wall was a board you scrolled around with a toolbar above it. It is now a
  composition with a centre: everything is framed around the middle, and the middle
  is where you write.
  
  - **Tidy leaves a hole in the middle.** The phyllotaxis packing now reserves a
    clear disc (`CENTRE_RADIUS`) at the world origin for the centrepiece, measured
    to each card's nearest **edge** rather than its centre — measuring from the
    centre let a wide card reach over the capture field by half its own width. The
    re-centring shift is applied only when it preserves that reserve, because an
    unconditional shift pushed cards back into the middle.
  - **The middle is the entry point.** The wall's centre holds a time-aware
    greeting, a running tally and an always-available quick-capture field: type a
    line, press Enter, and it becomes a note without opening the form. It is a
    screen-space overlay, not part of the transformed world, so it stays put while
    the wall pans and zooms.
  - **The canvas fills the window.** The title row and the toolbar row are gone.
    Every control — search, filters, view, sort, zoom, tidy, new — lives in one
    floating dock along the bottom, kept to a single row so it never eats the wall
    it floats above.
  - **Auto-framing measures instead of estimating.** The camera now reads the
    rendered card boxes from the DOM, so framing is exact instead of off by
    whatever the layout data guessed wrong. It is capped at 100% and floored at
    50%: a wall that cannot fit legibly is centred and readable, not crammed into
    unreadable confetti. Tidy re-frames one animation frame after its reconcile,
    so it frames the wall it actually produced.
  - **Cards render at the height the Host estimated.** The packer's collision
    geometry is only true if the rendered box is the box it checked; canvas cards
    now carry that height inline, which removes the residual overlap a code block's
    padding could cause.
  - **Zoom and reset are exact.** Reset no longer sets 100% before fitting, so the
    readout and the transform never disagree.
  
  Verified in the real DSH Web UI: 36/36 assertions, including a centred
  centrepiece that survives panning, a 14-note wall tidying to a centred ring with
  zero overlaps, and quick capture creating a note from the middle of the wall.

## 0.3.0

### Minor Changes

- Give the wall a centre, and make the canvas feel direct.
  
  The wall used to be laid out from a top-left corner and viewed through a scroll
  container, which is why it opened on empty paper and why the first drag of a
  session moved the whole wall.
  
  - **The wall is a disc around the origin.** "Tidy" now packs a phyllotaxis
    (sunflower) spiral centred on the world origin, with a real collision check
    against every card already placed instead of an estimated shelf. The result is
    deterministic, roughly square at every size (12 / 60 / 300 cards all come out
    within 0.7–1.4 aspect ratio), and cannot overlap even when every card sits at
    its height cap. The finished disc is re-centred on its own centre of mass, so
    the composition is balanced rather than merely origin-anchored.
  - **The camera opens on that middle.** Opening the wall, pressing reset, and
    tidying all frame the wall's centre of mass and pick the zoom that fits the
    whole wall in view (capped at 100%, never below the readable minimum).
  - **The camera is a transform, not a scroll container.** The canvas clips and one
    wrapper carries `translate3d(pan) scale(zoom)`, written imperatively. Panning
    and zooming cost zero React renders and zero layout, and dragging a card can no
    longer move the wall under it — which is exactly what the old padded scroll
    surface did when a card crossed its bounds.
  - **Panning and anchored zoom.** Drag empty paper to pan, scroll to pan, and
    `⌘/Ctrl + wheel` zooms around the pointer: the world point under the cursor
    stays under the cursor (verified to under 2px in the real browser).
  - **The drop is optimistic.** On release the card is written to its final world
    position on the node and in the note list before the Host round-trip, so it no
    longer snaps back to where it started while the write is in flight.
  - **Fewer renders per interaction.** Cards are memoized and note objects are
    reconciled by identity, so a mutation re-renders one card instead of the whole
    wall; the full-size wrapper element per note is gone and the card carries its
    own id.
  - **Clamping follows the width preset**, so a long body ends on a whole line
    instead of being cut mid-glyph by the card's max-height.
  
  Verified in the real DSH Web UI: 31/31 assertions, including a 14-note wall that
  tidies into a centred disc (zero overlaps, aspect ratio 0.94) and is framed at
  54% by the camera.

## 0.2.2

### Patch Changes

- Publish through the reviewed OIDC release workflow.
  
  0.2.1 was bootstrapped by a manual `npm publish`, which created the package so a
  Trusted Publisher could be attached to it. This release is the first one to go
  out through `release.yml` with npm Trusted Publishing, so it carries real
  provenance instead of a bare publish by a maintainer account.
  
  No runtime change: the canvas, the Markdown renderer and the drag behaviour are
  byte-identical to 0.2.1.

## 0.2.1

### Patch Changes

- Make dragging feel direct instead of laggy.
  
  - The canvas card no longer transitions `transform`. Every pointer move writes a
    new transform, and an active transition turned each write into an animation
    target, so the card trailed the pointer by ~160ms and read as rubber-banding.
    Only the drop shadow animates now.
  - The drag flag is a `data-dragging` attribute on the card instead of React
    state, so pressing and releasing no longer re-renders the whole wall.
  - Pointer moves are coalesced into one transform write per animation frame, so a
    high-rate trackpad cannot queue more writes than there are paints.
  - The pointer loop is registered once for the page instead of being torn down and
    re-added on every press and release (and re-registered whenever the note list
    changed mid-drag).
  - The dragged card keeps its rotation and width throughout; the drag no longer
    flattens the tilt and snaps it back on drop.
  - The hover lift now applies only in the grid view. On the canvas it overwrote
    the drag transform, so the card jumped a couple of pixels whenever the pointer
    crossed it.

## 0.2.0

### Minor Changes

- Turn the wall into a free canvas and render Markdown bodies.
  
  - Notes now own a canvas placement (`layout`: x, y, rotation, width preset)
    persisted by the Host, so dragging a card survives a restart and a second
    window shows the same arrangement. A note created before the canvas existed
    carries `layout: null` and gets a stable derived preview position instead of
    a broken or stacked wall.
  - Drag any card to place it; a drag deliberately does not bump `updatedAt`, so
    tidying the board never reshuffles a "by updated" sort.
  - New deterministic "Tidy" pass (`arrange`) repacks the wall with shelf
    packing: the same wall always yields the same arrangement, and a second tidy
    writes nothing.
  - Three card width presets (small/medium/large) and canvas zoom (0.4x-2x) via a
    floating control and ctrl/cmd + wheel.
  - Three view modes: canvas, responsive grid and a dense list index.
  - Note bodies render Markdown: headings, paragraphs, bold/italic/strike,
    inline code, fenced code, ordered and unordered lists, `- [ ]` checkboxes,
    quotes, rules, pipe tables and http(s)/mailto links. Rendering is done with a
    small in-package renderer that emits React elements, never HTML strings, and
    only http(s)/mailto targets become live links.
  - The `sticky_wall` model tool gains `arrange` and optional `x`/`y` on create.
  - Migrate to the DSH 0.2.2 display contract: `meta.detail` points at
    `docs/DETAIL*.md`, which carries one preview banner, so the plugin detail
    page no longer falls back to the full README. README keeps the long-form
    documentation.
  - Re-declare the toolchain for the mounted DSH 0.2.2-rc.1 line
    (`engines.dsh >=0.2.2-rc.1 <0.3.0`, cordis `~4.1.0`, schemastery `~3.19.0`).

## 0.1.2

### Patch Changes

- Redesign the wall's visual language: masonry layout so short notes stop
  leaving dead space, a derived accent palette with tinted shadows, real tag
  pills and status badges, a paper dot grid, and quieter chip-style controls.

## 0.1.1

### Patch Changes

- Move the note actions onto their own compact top row, so a long title keeps
  the full card width instead of wrapping early, and shrink the four controls.

## 0.1.0

### Minor Changes

- Ship the sticky wall: a left-sidebar entry and a main panel backed by the DSH
  storage domain, with quick capture, pin/archive, search and sort, bilingual
  copy, and an optional model-facing `sticky_wall` tool.
