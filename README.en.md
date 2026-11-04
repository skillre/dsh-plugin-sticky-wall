# @skillre/dsh-plugin-sticky-wall · Sticky Wall

> Status: experimental · for DSH `0.2.1-rc.5`

A sticky-note wall in the DSH left sidebar: capture a passing idea, a piece of temporary work, or a short reminder, pin what matters and archive the rest. Notes are persisted by the Host, so they survive a DSH restart.

[中文](README.md)

## What it solves

Ideas arrive at the busiest moments, and the friction of "open a document, invent a title, pick a folder" is enough to lose them. The sticky wall compresses it into three steps: click the sidebar entry, type one line, press `⌘/Ctrl + Enter`. It is a **scratchpad**, not a knowledge base: no hierarchy, backlinks or rich text — just capture now and find it later.

Non-goals: task management (no scheduling, assignment or reminders), collaboration, or exporting a Markdown knowledge base.

## Features

- **Sidebar entry** — a "Notes" glyph in `sidebar.panellist`; clicking it swaps the centre column to the wall.
- **Quick capture** — "New" opens a note sheet with an optional title, required body, tags and six pastel colors.
- **Pin and archive** — pinned notes always sort first; archived notes hide by default, the "Archive" filter fetches them on its own, and "Clear archive" is a permanent delete.
- **Note actions** — hovering or keyboard-focusing a note reveals pin, edit, archive and delete beside its title; on touch devices they stay visible.
- **Search and sort** — live filtering over body, title and tags; order by pinned, created or updated.
- **Light and dark** — the frame uses only DSH theme tokens; note pastels are the plugin's own palette with dark variants.
- **Bilingual** — follows the DSH GUI language live, without a reload.
- **Model-visible** — optionally registers a `sticky_wall` tool, so "note that …" creates a real note.

## Data and permissions

| Item | Detail |
|---|---|
| Data owner | Host. Notes persist through the native DSH `storageDomain`, domain `skillre_sticky_wall`, `per-record` layout (one file per note). |
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
- Published to npm: enter the npm spec `@skillre/dsh-plugin-sticky-wall@<version>` in the install dialog.
- Not published: an absolute path to a built `.tgz` may be offered only after verifying that this manager accepts the source and the artifact is installable.
- This repository is a **self-contained** Git source: the built `lib/` output is committed and no `scripts.prepare` is declared, so an install runs no build script. The pinned spec looks like `git+https://github.com/skillre/dsh-plugin-sticky-wall.git#<commit>` and has been verified installable.

## Update and rollback

- Update: install the newer version in the same manager. The Host row config and note data are preserved.
- Rollback: install the last known-good version. The domain carries a `version` field and compatibility only holds within the same version; back up the domain directory under `$DSH_HOME/storages` before downgrading.
- Uninstall: see [UNINSTALL.md](UNINSTALL.md). Uninstalling the plugin does **not** delete note data automatically.

## Plugin market

The plugin is published to the market index this fleet generates:

- Index: `https://skillre.github.io/dsh-plugin-market/index.json`
- Entry: `@skillre/dsh-plugin-sticky-wall@0.1.1`, commit-pinned Git source (`81dd43b`)
- Icon: `https://skillre.github.io/dsh-plugin-market/icons/sticky-wall.svg`

The install path was verified end to end: derive the spec from the live index, install into an isolated profile, `--dump-config`, bounded startup, live route (evidence in `docs/evidence/market-install-0.1.1.json`).

## Known limitations

- The wall is a scratchpad: body up to 4000 characters, title 120, up to 8 tags — hard limits.
- Archived notes do not occupy a `maxNotes` slot, but restoring them does; a restore at the cap is rejected instead of silently overshooting.
- "Clear archive" is a permanent, irreversible delete.
- Batch archive/delete is all-or-nothing: one unknown id in the request rejects the whole batch.
- With several windows open, each fetches its own snapshot; the Host is the single source of truth, but no live push across windows.
- Verified only against DSH `0.2.1-rc.5`; no other DSH line is claimed.

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
