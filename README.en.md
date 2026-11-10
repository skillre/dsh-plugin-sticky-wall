# @skillre/dsh-plugin-sticky-wall · Sticky Wall

> Status: experimental · for DSH `0.2.2-rc.1`

A sticky-note wall in the DSH left sidebar: capture a passing idea, a piece of temporary work, or a short reminder, and place it on the board **like a real sticky on a desk** — drag it, resize it, tidy the whole wall in one click. Bodies are written in **Markdown** and rendered right on the card. Both the notes and their placement are persisted by the Host, so position and content survive a DSH restart.

[中文](README.md)

## What it solves

Ideas arrive at the busiest moments, and the friction of "open a document, invent a title, pick a folder" is enough to lose them. The sticky wall compresses it into three steps: click the sidebar entry, type one line, press `⌘/Ctrl + Enter`. It is a **scratchpad**, not a knowledge base: no hierarchy, backlinks or rich text — just capture now and find it later.

Non-goals: task management (no scheduling, assignment or reminders), collaboration, exporting a Markdown knowledge base, or a WYSIWYG rich-text editor (the body stays Markdown source; rendering is a reading view).

## Features

- **Sidebar entry** — a "Notes" glyph in `sidebar.panellist`; clicking it swaps the centre column to the wall.
- **Free canvas** — notes are cards on a canvas, not list rows. Position, rotation and a three-step width (small/medium/large) are note data owned by the Host, so the same wall opens with the same arrangement in another window.
- **Drag to place** — press anywhere on a card and drag; the drop lands on the new position immediately and then writes it to the Host, so the card never snaps back first. A drag does **not** bump `updatedAt`, so tidying your desk never reshuffles a "by updated" sort.
- **A wall with a middle** — "Tidy" packs every note into a **compact composition hugging a clear rectangle** at the world origin, which is kept free for the greeting and the quick-capture field; the camera opens with the whole wall framed and centred. The packer follows the rectangle's own **contour** rather than a circle, so every card is only half its own size away from the middle: the same fourteen notes occupy 1261x705 instead of 1645x1794, and frame at **84% instead of 36%**. Each candidate slot is scored by the zoom the whole wall would need, so the result is a wide, low cluster rather than a disc that leaves the window's sides empty. The reserve is measured against each card's **edge**. Tidy keeps it constant in world space; a **single new note** instead follows where the field really is in world space, so capturing after panning or zooming still lands beside the field rather than behind it.
- **The centre is the entry point** — the middle of the wall is an always-available capture field: type a line, press Enter, and it becomes a note without opening the form. The new note lands in the **nearest free gap to the field** rather than being thrown off screen — or hidden behind it.
- **The arrival is visible** — a new card pops in and holds a ring for about 0.9s; if the gap is not on screen the camera brings it to the free space **beside the capture field** (whichever of above/below/left/right needs the least movement), zooming out only when nothing fits, so a capture never leaves you guessing whether it worked. It deliberately does **not** centre the card, because the centre of the viewport is where the field is drawn.
- **The reserve is a magnetic edge** — dragging a card onto the capture field pushes it to the nearest clear spot instead of letting it cover the input.
- **One-click tidy** — "Tidy" repacks deterministically and collision-checks every card against the ones already placed, so the same wall always yields the same arrangement and cards never overlap.
- **Three views** — canvas (default, free placement), grid (responsive masonry for reading long notes) and list (one line per note for finding one by title).
- **Full-window canvas** — the wall fills the entire window: no title row and no toolbar row. Every control lives in one **floating dock** at the bottom.
- **A compact dock** — only the frequent actions stay in the strip: search, filters, three **icon** view buttons, zoom (`− / percent / +`, where the percentage is itself the reset button), tidy and new. Sort, show-archived and clear-archive moved into a `⋯` overflow menu. The dock is a **single row**, centred, and sizes to the window, so no button spills past the strip it is drawn on.
- **Camera** — drag empty paper to pan, scroll to pan, `⌘/Ctrl + wheel` to zoom around the pointer (0.35×–2×). Opening the wall and pressing reset both frame the whole wall and centre it.
- **Markdown bodies** — headings, paragraphs, bold/italic/strikethrough, `code`, code blocks, ordered and unordered lists, `- [ ]` checkboxes, quotes, rules, tables and http(s)/mailto links. The composer has a "Preview" toggle.
- **Quick capture** — "New" opens a note sheet with an optional title, required body, tags, six pastel colors and a width preset.
- **Pin and archive** — pinned notes carry a coloured left rail and a star; archived notes hide by default, the "Archive" filter fetches them on its own, and "Clear archive" is a permanent delete.
- **Note actions** — hovering or keyboard-focusing a note reveals pin, resize, edit, archive and delete at its top-right; on touch devices they stay visible.
- **Search and sort** — live filtering over body, title and tags; order by pinned, created or updated.
- **Light and dark** — the frame uses only DSH theme tokens; note pastels are the plugin's own palette with dark variants.
- **Bilingual** — follows the DSH GUI language live, without a reload.
- **Model-visible** — optionally registers a `sticky_wall` tool, so "note that …" creates a real note, and `arrange` tidies the wall.

## Data and permissions

| Item | Detail |
|---|---|
| Data owner | Host. Notes (including canvas placement) persist through the native DSH `storageDomain`, domain `skillre_sticky_wall`, `per-record` layout (one file per note). |
| Data location | Decided by the profile's storage backend; the shipped profile's `storage-json` row writes domain files under `$DSH_HOME/storages`. |
| Network | No external requests. Browser ↔ Host uses the local DSH `/api` channel only. |
| Filesystem | Only the domain directory through the storage backend; no arbitrary user files. |
| Secrets | None. |
| Model-visible | Only when `enableAgentTool` is true (default): the `sticky_wall` tool, whose results include note text in the session. |

## Configuration

Override by row id in the profile's `cordis.patch.yml` (a patch replaces the whole `config`, so omitted keys take their defaults):

```yaml
- id: skillre-sticky-wall
  name: '@skillre/dsh-plugin-sticky-wall'
  config:
    maxNotes: 400
    enableAgentTool: true
    seedWelcomeNote: true
```

| Key | Default | Meaning |
|---|---|---|
| `maxNotes` | `400` | Cap on live (non-archived) notes, 1–5000. Creating, unarchiving and batch-restoring all respect it; going over returns `sticky-wall/wall-full`, so archive or delete first. |
| `enableAgentTool` | `true` | Whether to register the model-facing `sticky_wall` tool. |
| `seedWelcomeNote` | `true` | Whether a brand-new empty wall gets one welcome note explaining the shortcuts. |

## Install

After development and test cleanup, **the user** chooses the source and confirms install/enable in the DSH Desktop Client or Web UI **Plugins** manager; no developer or agent preinstalls it into the user's profile.

- **In the plugin market**: add `https://skillre.github.io/dsh-plugin-market/index.json` under **Plugins → Discover → Index sources** (enable the experimental *Custom plugin markets* bundle first), then install the plugin from Discover.
- **npm (recommended, and the only source that supports in-place updates)**: enter the npm spec `@skillre/dsh-plugin-sticky-wall@<version>` in the install dialog.
- Not published: an absolute path to a built `.tgz` may be offered only after verifying that this manager accepts the source and the artifact is installable.
- This repository is a **self-contained** Git source: the built `lib/` output is committed and no `scripts.prepare` is declared, so an install runs no build script. The pinned spec looks like `git+https://github.com/skillre/dsh-plugin-sticky-wall.git#<commit>` and has been verified installable.

## Update and rollback

From the DSH `0.2.2` line, the plugin page has an official **Versions** section (`listVersions` / `updateBundle`) that can check and update in place. Whether a bundle gets it depends **only on the install source and package contents**, never on repository configuration:

| Install source | In-place update |
|---|---|
| npm registry (`@skillre/dsh-plugin-sticky-wall@<version>`) | Yes — the detail page shows a Versions section and updates in place |
| `git+https://…#<commit>` (this repository's market entry) | No — no Versions section; uninstall and reinstall |
| Local `.tgz` / `file:` | No — same as above |

Every `updatable` condition holds for this plugin: third-party bundle, registry spec saved under its own package name, valid SemVer, and no protected plugin-management row such as `@deepseek-ai/dsh-plugin-manager`. **Install by npm package name to get the official update path.**

Update semantics, stated plainly:

- **Upgrade only** — the UI never offers an older version than the installed one.
- A successful update stores an **exact version** in the profile dependency (even if it was a range); a restore after failure does the same.
- An update is remove-then-install: under HMR the reinstalled bundle can move to the end of the bundle list and change configuration-layer order.
- Failure is recoverable: a failed install, cancellation or boot failure restores the previous version; if the restore also fails the package is left uninstalled.
- A version that needs new build-script approval fails and restores the old version.
- `allow-version` exemptions exist only in the CLI and agent tooling, not in the plugin page.

- **Rollback**: npm versions are immutable. `npm deprecate` the faulty version and publish a fix; the user removes the faulty bundle in the plugin manager and reinstalls a known-good version (if the UI cannot pin an older one, the user decides the recovery channel).
- **Data compatibility**: the domain carries a `version` field and compatibility only holds within the same version. Back up the domain directory under `$DSH_HOME/storages` before downgrading. Canvas placement is a new optional field: an older note loads with `layout: null` and the UI derives a preview position from the note id, so a downgrade does not fail on the missing field.
- **Uninstall**: see [UNINSTALL.md](UNINSTALL.md). Uninstalling the plugin does **not** delete note data automatically.

## Display metadata (plugin card and detail page)

DSH reads the plugin card and detail page **without activating the plugin**, so these resources must ship in the package, in three layers:

| Layer | Files | Content |
|---|---|---|
| Card title/subtitle | `meta.title` / `meta.description` in `locale/en.json`, `locale/zh.json` | One line, <= 120 characters, plain text |
| Detail page | `meta.detail` -> `docs/DETAIL.md` / `docs/DETAIL.zh.md` | **Exactly one** `![alt](preview*.svg)` line |
| Developer docs | `README.md` / `README.en.md` (this file) | Install, configuration, compatibility, limitations |

- `locale/*.json` is resolved through the Node ESM resolver, so `exports` must declare `"./locale/*.json"`. Without it, `ERR_PACKAGE_PATH_NOT_EXPORTED` is thrown and DSH **swallows it silently**, leaving the card showing the bare package name with no diagnostic anywhere.
- `meta.detail` is new in DSH `0.2.2`: a package-relative Markdown path read from the **package directory** (not through exports), so `files` must include `docs`. Without `meta.detail`, DSH falls back to `README.md` — dumping this developer manual into the detail page, which is exactly what this version fixes.
- Preview images: `docs/preview.svg` (English) and `docs/preview.zh.svg` (Chinese), at the fixed 640x300 logical ratio (this repository uses 1280x600). Rules live in the fleet's `docs/display-contract.md`; the whiteboard registry is [docs/PREVIEW.md](docs/PREVIEW.md).

```sh
node scripts/preview.mjs check   # offline preview/locale check (`npm run check` runs it)
```

## Plugin market

The plugin is published to the market index this fleet generates:

- Index: `https://skillre.github.io/dsh-plugin-market/index.json`
- Entry: `@skillre/dsh-plugin-sticky-wall@0.1.2`, commit-pinned Git source (`83c932f`)
- Icon: `https://skillre.github.io/dsh-plugin-market/icons/sticky-wall.svg`

The install path was verified end to end: derive the spec from the live index, install into an isolated profile, `--dump-config`, bounded startup, live route (evidence in `docs/evidence/market-install-0.1.2.json`).

## Known limitations

- The wall is a scratchpad: body up to 4000 characters, title 120, up to 8 tags — hard limits.
- **Markdown is a deliberate subset**, not full CommonMark: headings (`#`–`####`), paragraphs and hard breaks, bold/italic/strikethrough, inline `` `code` ``, ``` / ~~~ code blocks, ordered and unordered lists, `- [ ]` checkboxes, quotes, rules, pipe tables and http(s)/mailto links. **Not supported**: nested list indentation, images, footnotes, or interactive checkboxes (they render as a read-only glyph).
- **Raw HTML in a body is shown as text** — it is neither executed nor rendered. That is a safety decision, not a bug.
- Card width has only **three presets** (small/medium/large); there is no arbitrary resize. A drag keeps the card's existing tilt.
- Tidy is O(n) spiral placement plus a spatial-grid collision check; the wall holds at most 400 notes, and a wall larger than the viewport needs panning or zooming out.
- The canvas is a flat plane: no grouping, layers, connectors or snap alignment, and no rotation gesture beyond the stored tilt.
- Auto-framing has a legibility floor (42%): a large wall is centred rather than crammed entirely into view, so panning is expected. The middle is reserved space — tidy never places a card under the greeting or the capture field, and a capture on a panned or zoomed wall avoids wherever the field currently sits.
- Placement is owned by the Host, but two windows open on the same wall each render their own snapshot and do not live-push the other's drags.
- Archived notes do not occupy a `maxNotes` slot, but restoring them does; a restore at the cap is rejected instead of silently overshooting.
- "Clear archive" is a permanent, irreversible delete.
- Batch archive/delete is all-or-nothing: one unknown id in the request rejects the whole batch.
- With several windows open, each fetches its own snapshot; the Host is the single source of truth, but no live push across windows.
- Verified only against DSH `0.2.2-rc.1`; no other DSH line is claimed.

## Compatibility

See [compatibility.json](compatibility.json) for the DSH versions really mounted, verification dates and checks. `engines.dsh` is an install declaration, **not** compatibility evidence.

## Development

```sh
npm install
npm run check          # typecheck + tests + publication view
npm pack               # build the installable tarball
```

Package contents: `lib/` (built Host and Client artifacts with declarations), `cordis.patch.yml`, `compatibility.json`, `locale/*.json`, `icon.svg`, docs and license.

## License

MIT
