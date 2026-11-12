# Uninstall and rollback

The user removes this bundle in their DSH Desktop Client or Web UI **Plugins** manager. To roll back, the user removes the faulty version and chooses a verified known-good package/version in that manager, if supported. Neither an agent nor a developer uninstalls preexisting user bundles or installs the replacement for them.

## What removal does and does not touch

Removing the package removes its bundle layer, so the sidebar entry, the wall page, the `/api/skillre-sticky-wall/execute` route and the optional `sticky_wall` tool all disappear with it. **The notes are not removed.**

- The notes are the user's own files: one `.md` per note in the notes directory. By default that is **`$DSH_HOME/sticky-notes/`**, falling back to `~/.dsh/sticky-notes/` when DSH sets no `DSH_HOME`; a configured `notesDir` moves it anywhere, including under `~/`.
- Nothing in that directory is owned by the plugin in a way that requires it to be present. Each file is ordinary Markdown with a frontmatter block at the top, so after uninstalling they can still be opened, searched, copied and version-controlled with any editor or tool.
- Reinstalling the same or a newer version reads that same directory again and rebuilds the wall from it, placement included (placement lives in the frontmatter).
- A user who wants the files gone can delete the notes directory while DSH is stopped. That is a user action, it is irreversible, and it is the only thing that removes the notes — back it up first if they might matter.

## The legacy storage domain may still be there

An install that was upgraded from 0.7.x still has the old storage-domain records at **`$DSH_HOME/storages/skillre_sticky_wall/`** (the exact path is decided by the profile's `storage-json` `root`). The 0.8.0 upgrade copies those notes into `.md` files but deliberately **never deletes the domain**, so a rollback is possible.

Once the user is satisfied that the `.md` notes are complete, that leftover directory may be deleted by the user — it is dead weight, and deleting it is the final step of the migration rather than part of uninstalling. Until then, leaving it costs only disk space; nothing reads it except a 0.7.x install.

## Rollback across versions

Notes are plain files now, so data rollback is a file copy: before downgrading, copy the whole notes directory somewhere safe.

- **0.8.0 → 0.7.x**: stop DSH, move the `sticky-notes/` directory aside (do not delete it), then install the 0.7.x build. It reads the legacy domain, which the upgrade left untouched. The `.md` files stay on disk and are picked up again if the user returns to 0.8.0.
- **0.7.x → 0.8.0**: automatic, on first start — see the migration section of the README. A failed migration writes nothing and the wall still opens.
- A note file written by a **newer** build still loads: it renders with a "metadata issue" badge, keeps every frontmatter key this build does not understand, and writes them back on the next save. That is why an accidental downgrade warns instead of destroying notes — but the newer keys are carried, not interpreted, so move forward again rather than editing that note with an older build.

## Temporary development installs

Temporary tests use a different rule: stop the test process; remove only the test-created bundle/dependency/selection/config or the confirmed owned isolated non-Desktop profile; verify the test state is absent. If an actual user profile was used with prior approval, preserve its baseline installations and data and report any residue that could not be restored.

If the interface cannot start, arrange user-authorized recovery through the applicable CLI/profile recovery procedure; do not assume Electron's `desktop` profile can be operated with CLI `--profile desktop`. Removing the package removes its bundle layer.

## Leftover files an installed build can leave behind

- The **notes** described above, which deliberately outlive the plugin.
- A **`migration.json`** marker inside the notes directory, written once after a successful migration. It records what happened; deleting it is harmless but pointless.
- The **legacy domain directory** under `$DSH_HOME/storages/skillre_sticky_wall/`, if the install was upgraded from 0.7.x.
- A `<id>.md.tmp` file, only if a write was interrupted by a crash mid-save. It is ignored on load (it is not named like a note) and can be deleted.

Beyond those, the plugin writes nothing, registers no timer that outlives it, and holds no process.
