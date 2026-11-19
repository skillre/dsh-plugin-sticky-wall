# Releasing @skillre/dsh-plugin-sticky-wall

## Repository release identity

- Package: `@skillre/dsh-plugin-sticky-wall`
- Fleet slug: `sticky-wall`
- Trusted Publisher repository: `skillre/dsh-plugin-sticky-wall`
- Workflow: `.github/workflows/release.yml`
- Protected environment: `npm-publish`

<!-- fleet-managed:start -->
## Authoritative release procedure

Read the full local `AGENTS.md`, run `node scripts/fleet.mjs context --json`, then actually read the returned Fleet `docs/plugin-policy.md` and `docs/release-runbook.md` before version/release/rollback work. In the standard layout the runbook is [here](<../../docs/release-runbook.md>); resolve this link relative to this repository, never a nested cwd. This file is navigation and repository-specific evidence, not a copied second release workflow.

- Parent release tools are not local npm scripts. `node scripts/fleet.mjs release:dispatch --plan` previews a verified, uniquely scoped call without running it. Other whitelist commands and arbitrary-cwd usage are in Fleet `docs/independent-workspaces.md`.
- Actual dispatch needs direct human package@version authorization, approved commit via `DSH_RELEASE_COMMIT`, clean canonical main, matching origin/local/remote main, real compatibility evidence and the protected OIDC approval. No `--allow-dirty`, npm publish, credentials or automatic approval.
- Bootstrap, provisioning, npm trust/login, interactive and market writes are separately reviewed parent maintenance operations; no child forwarder. Old bootstrap dry-run is not a guarantee of no side effects.
- Changesets, final tarball tests, artifact/provenance/tag verification, cleanup and rollback follow the shared runbook. This entry/fixture check is not evidence of a mount, real publish or complete artifact verification.
- Final installation/update/uninstall/rollback belongs to the user's Plugins manager; [UNINSTALL](<UNINSTALL.md>) gives this plugin's user-facing path. CLI/profile recovery, when the manager cannot start, is a separately authorized path that preserves preexisting state.

Keep package-specific release facts and dated history below; examples/history are not current authority or proof of remote state.
<!-- fleet-managed:end -->

## Plugin-specific release notes

No additional release facts are declared by the base template. Record verified dates, versions and evidence here without copying the public runbook.
