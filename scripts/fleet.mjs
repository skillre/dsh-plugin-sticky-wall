#!/usr/bin/env node
// Canonical thin entry. Shared behavior lives in the pinned devkit, never in copied release code.
//
// This file resolves two independent things and then hands both to the devkit:
//   fleetRoot  — this project's control repo (inventory, authorization, toolchain)
//   devkitRoot — the reusable policy/template/tooling repository it pins
// Neither is inferred from where this file happens to sit.
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

async function readRegular(path, label) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${path}`)
  return readFile(path, 'utf8')
}

try {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  if (process.argv[2] === 'help' || process.argv[2] === '--help' || process.argv.length === 2) {
    if (process.argv.length > 3) throw new Error('help accepts no extra arguments')
    console.log(
      'Plugin devkit: context | policy:check | update:readiness | release:dispatch | release:watch | release:verify.\n' +
        'Use --json; release commands support --plan (prints the call, executes nothing). --online explicitly enables network reads.',
    )
  } else {
    const config = JSON.parse(await readRegular(join(repoRoot, '.fleet-context.json'), 'Workspace config'))
    if (typeof config.fleetRoot !== 'string' || !config.fleetRoot || config.fleetRoot.includes('\0')) {
      throw new Error('Invalid Fleet root configuration')
    }

    const override = process.env.DSH_FLEET_ROOT
    if (override !== undefined && (!isAbsolute(override) || override.includes('\0'))) {
      throw new Error('DSH_FLEET_ROOT must be an absolute non-empty path')
    }
    const candidate = resolve(repoRoot, override ?? config.fleetRoot)
    const rootStat = await lstat(candidate)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Fleet root must be a real directory')
    const fleetRoot = await realpath(candidate)

    const fleetManifest = JSON.parse(await readRegular(join(fleetRoot, 'package.json'), 'Fleet manifest'))
    if (config.fleetOwner !== 'skillre' || fleetManifest.name !== '@skillre/dsh-plugin-fleet' || fleetManifest.private !== true) {
      throw new Error('The selected directory is not the declared Skillre Fleet')
    }

    // The fleet pins one devkit. Resolving it from the fleet (not from this file's
    // position, and not from a global install) keeps every plugin on the version
    // the project reviewed.
    const pin = JSON.parse(await readRegular(join(fleetRoot, 'devkit.json'), 'Fleet devkit pin'))
    const pinnedRoot = process.env.DSH_DEVKIT_ROOT ?? (isAbsolute(pin.root ?? '') ? pin.root : resolve(fleetRoot, pin.root))
    const devkitStat = await lstat(pinnedRoot)
    if (!devkitStat.isDirectory() || devkitStat.isSymbolicLink()) throw new Error(`Pinned devkit root must be a real directory: ${pinnedRoot}`)
    const devkitRoot = await realpath(pinnedRoot)

    const devkitManifest = JSON.parse(await readRegular(join(devkitRoot, 'package.json'), 'Devkit manifest'))
    if (devkitManifest.name !== '@skillre/dsh-plugin-devkit') throw new Error(`Pinned directory is not the plugin devkit: ${devkitRoot}`)
    if (typeof pin.version === 'string' && pin.version !== devkitManifest.version) {
      throw new Error(`Fleet pins devkit ${pin.version} but ${devkitManifest.version} is present; review the upgrade before running`)
    }

    const helper = join(devkitRoot, 'scripts/lib/plugin-workspace.mjs')
    const helperStat = await lstat(helper)
    const rel = relative(devkitRoot, await realpath(helper))
    if (!helperStat.isFile() || helperStat.isSymbolicLink() || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error('Workspace helper resolves outside the devkit')
    }

    const { runWorkspaceCommand } = await import(pathToFileURL(helper).href)
    process.exitCode = await runWorkspaceCommand(repoRoot, process.argv.slice(2), { fleetRoot })
  }
} catch (error) {
  console.error(`plugin workspace: ${error.message}`)
  process.exitCode = 1
}
