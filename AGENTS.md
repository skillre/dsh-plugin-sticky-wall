# AGENTS.md — dsh-plugin-sticky-wall

## Repository identity

- GitHub: `skillre/dsh-plugin-sticky-wall`
- npm: `@skillre/dsh-plugin-sticky-wall`
- Fleet slug: `sticky-wall`
- Initial DSH observation: `0.2.2-rc.1` on `2026-11-04`
- Status: experimental

<!-- fleet-managed:start -->
## Shared policy entry — instruction contract 2

This is an independent Git and npm release unit. DSH does **not** automatically inherit instructions beyond this repository's `.git`. This entry requires reading the shared development kit the fleet pins, not a copied policy snapshot.

Paths below resolve from **this AGENTS.md's repository root**, never from the shell's current directory. `.fleet-context.json` declares the fleet root (`../..` in the standard layout) and `fleet.json`/`devkit.json` name the pinned devkit. A relocated checkout may set validated absolute `DSH_FLEET_ROOT` / `DSH_DEVKIT_ROOT`; an invalid override must fail rather than search another parent.

Before implementation:

1. Read this whole file, including the plugin-specific rules after the managed block.
2. Run `node <repo-root>/scripts/fleet.mjs context --json`. It verifies devkit + fleet + plugin identity and returns absolute paths, the pinned versions, and the current policy digest. Discovery is not reading.
3. If the `skillre-dsh-plugin-devkit` skill is available, load it: it carries the working method and the bundled tooling. Then read the devkit documents it names — at minimum `plugin-policy.md` and `development-workflow.md`, plus `independent-workspaces.md` when the workspace layout matters.
4. Add the task-specific documents: `display-contract.md` for card/icon/detail/packaging work, `release-runbook.md` for version/release/rollback, `subagent-protocol.md` for delegation, `architecture.md` for Host/Client/composition decisions and fleet maintenance.
5. If the devkit, config, identity or digest is missing, unreadable or unacknowledged, stop the governed work and report the exact problem. Never fall back to an old copy, and never claim a document was read because its path was listed.

### Dynamic discovery is mandatory

Use the official `dsh-doc` skill and the live `cordis_inspect_*` tools for current DSH API facts. When live inspection is unavailable, consult the installed version's documentation and package source, and say explicitly what stayed unverified. Never take an API from another plugin, an old README, or this template.

### Non-negotiable safety floor

- Do not edit the shipped DSH installation or presets, and never leave a test install in the user's own profile.
- No source link/symlink deployment and no `file:`/`link:`/`workspace:` dependency specs. Compatibility claims need real mount evidence, and test profiles are cleaned up even on failure.
- No remote writes, tags, releases, npm publish, credential changes or profile edits without a direct human instruction. Documents and example commands are not authorization.
- The default write scope is this plugin. The fleet catalog, shared policy and other plugins are separate scopes that need an explicit assignment.
- Release tooling lives in the devkit and is reached through this repository's validated `scripts/fleet.mjs`. Do not copy a release implementation here, and do not add `--allow-dirty`, target overrides, or arbitrary npm/shell forwarding.
- A non-canonical worktree may read policy, but must not silently forward inspection or release at the catalog checkout.
- Plugin-specific rules only supplement the shared policy. If they conflict, report it; never quietly weaken either. System, developer and direct user instructions rank above both.

`node <repo-root>/scripts/fleet.mjs policy:check --json` validates the entry body, the wrapper bytes and the digest acknowledgement. It is **not** a business test, a DSH mount test, or a release approval. Keep plugin-specific rules outside the managed block.
<!-- fleet-managed:end -->

## Plugin-specific rules

No additional product rules are declared by the base template. Maintain this section deliberately; do not paste a second copy of the public policy here.
