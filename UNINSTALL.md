# Uninstall and rollback

The user removes this bundle in their DSH Desktop Client or Web UI **Plugins** manager. To roll back, the user removes the faulty version and chooses a verified known-good package/version in that manager, if supported. Neither an agent nor a developer uninstalls preexisting user bundles or installs the replacement for them.

## What removal does and does not touch

Removing the package removes its bundle layer, so the sidebar entry, the wall page, the `/api/skillre-sticky-wall/execute` route and the optional `sticky_wall` tool all disappear with it. **Note data is not removed.**

- The notes live in the storage domain `skillre_sticky_wall`, which the profile's storage backend owns. For the shipped profile this is a directory under `$DSH_HOME/storages`; the exact path is decided by the `storage-json` row's `root` and the domain's own directory naming.
- Reinstalling the same version reuses that data, because the domain name and version are unchanged.
- A user who wants the data gone can remove that domain directory while DSH is stopped. That is a user action, and it is irreversible — back it up first if the notes might matter.
- Because a reinstall resolves the same domain name, deleting the directory while DSH is running is not supported: stop the app, delete, then start again.

## Rollback across versions

The domain declares `version: 1`. A downgrade to a build that declares a different version fails loudly at domain open (`version-mismatch` from the storage backend) instead of silently rewriting notes. Before downgrading, copy the domain directory so the previous notes can be restored.

## Temporary development installs

Temporary tests use a different rule: stop the test process; remove only the test-created bundle/dependency/selection/config or the confirmed owned isolated non-Desktop profile; verify the test state is absent. If an actual user profile was used with prior approval, preserve its baseline installations and data and report any residue that could not be restored.

If the interface cannot start, arrange user-authorized recovery through the applicable CLI/profile recovery procedure; do not assume Electron's `desktop` profile can be operated with CLI `--profile desktop`. Removing the package removes its bundle layer.

## Leftover files an installed build can leave behind

None by design. The plugin writes no file of its own outside the storage domain, registers no timer, and holds no process. The one residue worth knowing is the note data described above, which deliberately outlives the plugin.
