#!/usr/bin/env node
/**
 * Fail when the committed build output no longer matches the source.
 *
 * `lib/` is tracked so the repository is a self-contained Git install source
 * (a Git market entry must ship its main entry at the pinned commit and must
 * not declare `scripts.prepare`). That makes silent drift possible: someone
 * edits `src/`, forgets to rebuild, and the published Git source serves stale
 * runtime code. This runs after the build inside `npm run check`.
 */

import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

let tracked
try {
  tracked = git(['ls-files', '--', 'lib'])
} catch {
  // Not a Git checkout (for example a packed tarball being inspected): the
  // drift question does not apply.
  process.stdout.write('lib-drift: skipped (not a Git checkout)\n')
  process.exit(0)
}
if (tracked.trim() === '') {
  process.stdout.write('lib-drift: skipped (lib/ is not tracked in this checkout)\n')
  process.exit(0)
}

let diff
try {
  diff = git(['diff', '--name-only', '--', 'lib'])
} catch (error) {
  throw new Error(`lib-drift: git diff failed: ${error.message}`)
}
if (diff.trim() !== '') {
  process.stderr.write(`lib-drift: committed build output differs from source:\n${diff}\nRun \`npm run build\` and commit lib/.\n`)
  process.exit(1)
}
process.stdout.write('lib-drift: committed build output matches source\n')
