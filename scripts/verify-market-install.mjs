#!/usr/bin/env node
/**
 * Verify that the PUBLISHED market entry installs.
 *
 * It creates one owned, disposable DSH home, creates a fresh web profile from
 * the shipped template, installs the exact spec the market's own validator
 * derives from the LIVE hosted index, composes the profile, boots a bounded
 * real startup and calls the plugin's route. Then it removes everything.
 *
 * This proves the market round-trip (index -> install spec -> running plugin),
 * not just that a local tarball works.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const INDEX_URL = process.env.MARKET_INDEX_URL || 'https://skillre.github.io/dsh-plugin-market/index.json'
const PACKAGE = '@skillre/dsh-plugin-sticky-wall'
const cli = process.env.DSH_TEST_CLI || 'dsh'
const owned = await mkdtemp(join(await realpath(tmpdir()), 'dsh-market-install-'))
const home = join(owned, 'home')
const work = join(owned, 'work')
const profile = `market-install-${owned.slice(-6)}`
const env = {
  ...process.env,
  DSH_HOME: home,
  DSH_AGENTS_HOME: join(home, 'agents'),
  DSH_PROFILE: profile,
  DSH_PROFILE_DIR: join(home, 'profiles', profile),
  DSH_TELEMETRY_DISABLED: '1',
  npm_config_cache: join(owned, 'npm-cache'),
  npm_config_store_dir: join(owned, 'pnpm-store'),
}
const strip = (text) => text.replace(/\u001b\[[0-9;]*m/g, '')
const report = { indexUrl: INDEX_URL, package: PACKAGE, checks: [], cleanup: {} }
const children = []

function run(args, timeoutMs = 180000) {
  const child = spawn(cli, args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let text = ''
  child.stdout.on('data', (data) => { text += data.toString() })
  child.stderr.on('data', (data) => { text += data.toString() })
  const closed = new Promise((resolve) => child.once('close', (code) => resolve(code)))
  const deadline = delay(timeoutMs).then(() => { child.kill('SIGKILL'); throw new Error(`timeout: dsh ${args.join(' ')}`) })
  return Promise.race([closed, deadline]).then((code) => {
    if (code !== 0) throw new Error(`dsh ${args.join(' ')} exited ${code}: ${strip(text).slice(-3000)}`)
    return strip(text)
  })
}

let app
async function shutdown() {
  if (app && app.exitCode === null) {
    app.kill('SIGTERM')
    await Promise.race([new Promise((resolve) => app.once('close', resolve)), delay(3000)])
    if (app.exitCode === null) app.kill('SIGKILL')
  }
  report.cleanup.processesStopped = children.every((child) => child.exitCode !== null)
  try {
    const marker = await readFile(join(owned, '.owned'), 'utf8')
    assert.equal(marker.trim(), owned, 'owned marker mismatch')
    await rm(owned, { recursive: true, force: true })
    const gone = await readFile(join(owned, '.owned')).then(() => false, (error) => error.code === 'ENOENT')
    report.cleanup.rootRemoved = gone
    report.cleanup.verified = gone
  } catch (error) {
    report.cleanup.error = String(error)
    process.exitCode = 1
  }
}

try {
  await writeFile(join(owned, '.owned'), owned, { flag: 'wx', mode: 0o600 })
  await mkdir(home)
  await mkdir(work)

  // 1. Read the LIVE hosted index and derive the install spec exactly the way
  //    the DSH market UI does.
  const index = await fetch(INDEX_URL, { signal: AbortSignal.timeout(30000) }).then((response) => {
    assert.equal(response.status, 200, `index HTTP ${response.status}`)
    return response.json()
  })
  report.checks.push('live-index-fetched')
  const entry = index.plugins.find((plugin) => plugin.name === PACKAGE)
  assert.ok(entry, `${PACKAGE} is missing from the live index`)
  report.checks.push('live-index-lists-plugin')
  const version = entry.versions[0]
  const spec = `git+${version.source.url.endsWith('.git') ? version.source.url : `${version.source.url}.git`}#${version.source.commit}`
  report.spec = spec
  report.version = version.version
  report.checks.push('install-spec-derived')

  // 2. The icon must be reachable over the same origin (the Web UI blocks http icons).
  const icon = await fetch(new URL(entry.icon, INDEX_URL), { signal: AbortSignal.timeout(30000) })
  assert.equal(icon.status, 200, `icon HTTP ${icon.status}`)
  report.checks.push('live-icon-reachable')

  // 3. Install that exact spec into an isolated profile.
  await run(['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
  await run(['plugin', '--profile', profile, 'add', spec, '--ignore-scripts', '--store-dir', join(owned, 'pnpm-store')])
  report.checks.push('market-spec-installed')
  const profileDir = join(home, 'profiles', profile)
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  assert.ok(Object.hasOwn(manifest.dependencies ?? {}, PACKAGE), 'market spec did not add the dependency')
  assert.ok((manifest.dsh?.profile?.bundles ?? []).includes(PACKAGE), 'bundle selection was not saved')
  report.checks.push('dependency-and-selection')

  const dump = await run(['--profile', profile, '--dump-config'])
  assert.ok(dump.includes('skillre-sticky-wall'), 'bundle row did not compose')
  report.checks.push('dump-config')

  // 4. Bounded startup plus one authenticated route call.
  app = spawn(cli, ['--profile', profile, '--port', '0', '--no-open'], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(app)
  let text = ''
  const append = (data) => { text += data.toString() }
  app.stdout.on('data', append)
  app.stderr.on('data', append)
  const url = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`no launch URL: ${strip(text).slice(-3000)}`)), 40000)
    const inspect = () => {
      const match = strip(text).match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/[^\s"<>]*[?&]token=[^\s"<>]+/)
      if (match) { clearTimeout(deadline); resolve(match[0]) }
    }
    app.stdout.on('data', inspect)
    app.stderr.on('data', inspect)
    app.once('close', (code) => { clearTimeout(deadline); reject(new Error(`app exited ${code}: ${strip(text).slice(-3000)}`)) })
    inspect()
  })
  const origin = new URL(url).origin
  const auth = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) })
  assert.ok(auth.status === 302 || auth.status === 303, `auth exchange HTTP ${auth.status}`)
  const cookie = auth.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ')
  await auth.body?.cancel()
  report.checks.push('bounded-startup')
  await delay(1000)

  const endpoint = 'skillre-sticky-wall/execute'
  const response = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: cookie, Origin: origin },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { action: 'list', includeArchived: true } }),
    signal: AbortSignal.timeout(15000),
  })
  assert.equal(response.status, 200, `route HTTP ${response.status}`)
  const envelope = await response.json()
  assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result.error))
  assert.ok(Array.isArray(envelope.result.value.notes), 'route returned no notes array')
  report.notes = envelope.result.value.notes.length
  report.checks.push('route-live')
} catch (error) {
  report.error = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  await shutdown()
  await writeFile(join(process.cwd(), 'market-install-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

process.stdout.write(`${process.exitCode ? 'FAILED' : 'OK'} ${JSON.stringify(report, null, 2)}\n`)
