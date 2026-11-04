#!/usr/bin/env node
/**
 * Packed-package verification ONLY. Never point this runner at a user profile.
 *
 * It creates one owned, disposable DSH home in the platform temp directory,
 * copies the shipped `web` profile template into it, installs the packed
 * tarball, composes the profile, boots a real bounded startup, exercises the
 * plugin's exact Connection route over the authenticated browser transport,
 * then stops everything and removes the owned root. Cleanup runs in `finally`
 * even when a check fails.
 *
 * Usage: node scripts/verify-isolated.mjs <absolute-path-to.tgz>
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
const cli = process.env.DSH_TEST_CLI || 'dsh'
const tarball = resolve(process.argv[2] || join(repo, `skillre-dsh-plugin-sticky-wall-${manifest.version}.tgz`))
const tarballInfo = await readFile(tarball)
const tarballSha256 = createHash('sha256').update(tarballInfo).digest('hex')
const base = await realpath(tmpdir())
const owned = await mkdtemp(join(base, 'dsh-sticky-wall-mount-'))
const owner = randomUUID()
const home = join(owned, 'home')
const work = join(owned, 'work')
const profile = `sticky-wall-test-${owner.slice(0, 8)}`
assert.notEqual(profile, 'desktop')
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
const children = []
const checks = []
const report = { package: manifest.name, version: manifest.version, dsh: '', tarball: { path: tarball, sha256: tarballSha256 }, profile, checks, endpoint: {}, cleanup: {} }
let failure
let cleanupVerified = false
const strip = (text) => text.replace(/\u001b\[[0-9;]*m/g, '').replace(/([?&]token=)[^\s"'<]+/g, '$1[redacted]')

function start(args, timeoutMs = 60000) {
  const child = spawn(cli, args, { cwd: work, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const record = { child, args, text: '', closed: null, result: null }
  record.closed = new Promise((res, rej) => {
    child.once('error', rej)
    child.once('close', (code, signal) => { record.result = { code, signal }; res(record.result) })
  })
  const append = (data) => { record.text += data.toString(); if (record.text.length > 2 * 1024 * 1024) record.text = record.text.slice(-2 * 1024 * 1024) }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  record.deadline = new Promise((_, rej) => {
    record.timer = setTimeout(() => rej(new Error(`Owned CLI deadline exceeded (${timeoutMs}ms): ${args.join(' ')}`)), timeoutMs)
  })
  record.finished = Promise.race([record.closed, record.deadline])
  record.closed.finally(() => clearTimeout(record.timer)).catch(() => {})
  children.push(record)
  return record
}

async function stop(record) {
  if (record.result !== null) return
  try { record.child.kill('SIGTERM') } catch {}
  const closed = await Promise.race([record.closed.then(() => true), delay(3000).then(() => false)])
  if (!closed) {
    try { record.child.kill('SIGKILL') } catch {}
    await Promise.race([record.closed, delay(3000).then(() => { throw new Error(`Owned PID ${record.child.pid} did not close`) })])
  }
}

async function run(args, timeoutMs = 90000) {
  const record = start(args, timeoutMs)
  const result = await record.finished
  await stop(record)
  report.checks.push(`command: dsh ${args.join(' ')} -> exit ${result.code}`)
  assert.equal(result.code, 0, `CLI exited ${result.code}: ${strip(record.text).slice(-4000)}`)
  return strip(record.text)
}

/** Authenticate through the real launch token and return the origin + cookie. */
async function authenticatedStartup() {
  const record = start(['--profile', profile, '--port', '0', '--no-open'], 60000)
  const tokenUrl = await new Promise((res, rej) => {
    const timeout = setTimeout(() => { finish(); rej(new Error(`No bounded startup URL: ${strip(record.text).slice(-4000)}`)) }, 30000)
    const inspect = () => {
      // Read the launch URL from the RAW stream: `strip` redacts the token, and
      // a redacted token cannot be exchanged.
      const match = record.text.replace(/\u001b\[[0-9;]*m/g, '').match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/[^\s"<>]*[?&]token=[^\s"<>]+/)
      if (match) { finish(); res(match[0]) }
    }
    const finish = () => { clearTimeout(timeout); record.child.stdout.off('data', inspect); record.child.stderr.off('data', inspect) }
    record.child.stdout.on('data', inspect)
    record.child.stderr.on('data', inspect)
    record.closed.then((result) => { finish(); rej(new Error(`Startup exited: ${result.code}; ${strip(record.text).slice(-4000)}`)) }).catch(rej)
    inspect()
  })
  const origin = new URL(tokenUrl).origin
  const auth = await fetch(tokenUrl, { redirect: 'manual', signal: AbortSignal.timeout(15000) })
  assert.ok(auth.status === 302 || auth.status === 303, `Owned auth exchange returned HTTP ${auth.status}`)
  const cookie = auth.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ')
  assert.ok(cookie, 'Authenticated browser cookie missing')
  await auth.body?.cancel()
  return { record, origin, cookie }
}

/** Call the plugin's exact endpoint through the real authenticated transport. */
async function rpc(origin, cookie, payload) {
  const rpcId = randomUUID()
  const endpoint = 'skillre-sticky-wall/execute'
  const response = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: cookie, Origin: origin },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
    signal: AbortSignal.timeout(15000),
  })
  assert.equal(response.status, 200, `${endpoint}: RPC transport HTTP ${response.status}`)
  const envelope = await response.json()
  assert.equal(envelope.type, 'server-response')
  assert.equal(envelope.rpcId, rpcId)
  assert.equal(envelope.result.ok, true, `${endpoint}: ${JSON.stringify(envelope.result.error)}`)
  return envelope.result.value
}

try {
  await writeFile(join(owned, '.owned-by-sticky-wall'), owner, { flag: 'wx', mode: 0o600 })
  await mkdir(home)
  await mkdir(work)
  const version = (await run(['--version'])).trim()
  report.dsh = version
  checks.push('dsh-version')
  await run(['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
  checks.push('profile-template-created')
  await run(['plugin', '--profile', profile, 'add', tarball, '--ignore-scripts', '--store-dir', join(owned, 'pnpm-store')], 180000)
  checks.push('profile-tarball-install')
  const profileDir = join(home, 'profiles', profile)
  const profileManifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  assert.ok(Object.hasOwn(profileManifest.dependencies ?? {}, manifest.name), 'Tarball dependency was not installed')
  assert.ok((profileManifest.dsh?.profile?.bundles ?? []).includes(manifest.name), 'Bundle selection was not saved')
  checks.push('packed-dependency-and-selection')
  const dump = await run(['--profile', profile, '--dump-config'])
  assert.ok(dump.includes('skillre-sticky-wall'), 'Bundle row id did not compose')
  assert.ok(dump.includes(manifest.name), 'Bundle package name did not compose')
  checks.push('dump-config')

  const installed = await realpath(join(profileDir, 'node_modules', ...manifest.name.split('/')))
  assert.ok(installed.startsWith(`${owned}/`), 'Installed package escaped the owned root')
  const installedManifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.equal(installedManifest.version, manifest.version)
  for (const required of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'compatibility.json']) {
    assert.ok(await readFile(join(installed, required)).then(() => true, () => false), `Packed file missing: ${required}`)
  }
  checks.push('packed-payload-present')

  const { record, origin, cookie } = await authenticatedStartup()
  try {
    await delay(1000)
    checks.push('bounded-startup')
    const list = await rpc(origin, cookie, { action: 'list', includeArchived: true })
    assert.ok(Array.isArray(list.notes), 'list must return a notes array')
    assert.ok(list.notes.some((note) => note.id === 'welcome'), 'a fresh wall must seed the welcome note')
    report.endpoint.list = { notes: list.notes.length }
    checks.push('api-list')

    const created = await rpc(origin, cookie, { action: 'create', note: { body: 'isolated verification note', title: 'verify', tags: ['test'], color: 'blue' } })
    const note = created.changed?.[0]
    assert.ok(note?.id, 'create must return the new note')
    assert.equal(note.body, 'isolated verification note')
    assert.equal(note.color, 'blue')
    report.endpoint.create = { id: note.id }
    checks.push('api-create')

    const updated = await rpc(origin, cookie, { action: 'update', id: note.id, patch: { pinned: true } })
    assert.equal(updated.changed?.[0]?.pinned, true)
    checks.push('api-update')

    const archived = await rpc(origin, cookie, { action: 'archive', ids: [note.id], archived: true })
    assert.equal(archived.changed?.[0]?.archived, true)
    checks.push('api-archive')

    const hidden = await rpc(origin, cookie, { action: 'list' })
    assert.ok(!hidden.notes.some((candidate) => candidate.id === note.id), 'archived notes must hide from the default list')
    checks.push('api-archive-hides-note')

    // Persistence across a real restart: stop the app, start it again, and the
    // note must still be there because it went through the storage domain.
    await stop(record)
    const second = await authenticatedStartup()
    try {
      await delay(1000)
      const again = await rpc(second.origin, second.cookie, { action: 'list', includeArchived: true })
      assert.ok(again.notes.some((candidate) => candidate.id === note.id), 'note did not survive a restart')
      checks.push('storage-persistence-across-restart')
      const removed = await rpc(second.origin, second.cookie, { action: 'delete', ids: [note.id] })
      assert.deepEqual(removed.removed, [note.id])
      checks.push('api-delete')
      const after = await rpc(second.origin, second.cookie, { action: 'list', includeArchived: true })
      assert.ok(!after.notes.some((candidate) => candidate.id === note.id), 'deleted note still listed')
      checks.push('api-delete-verified')
      const bad = await fetch(`${second.origin}/api/skillre-sticky-wall/execute`, {
        method: 'POST', headers: { 'content-type': 'application/json', Origin: second.origin },
        body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'skillre-sticky-wall/execute', payload: { action: 'list' } }),
        signal: AbortSignal.timeout(15000),
      })
      assert.equal(bad.status, 401, 'the route must stay inside Connection auth fencing')
      checks.push('api-auth-fence')
    } finally {
      await stop(second.record)
    }
  } finally {
    await stop(record)
  }
} catch (error) {
  failure = error
} finally {
  report.cleanup.ownedRoot = owned
  report.cleanup.profile = profile
  for (const record of children) await stop(record).catch((error) => { report.cleanup.stopError = String(error) })
  report.cleanup.processesStopped = children.every((record) => record.result !== null)
  try {
    const marker = await readFile(join(owned, '.owned-by-sticky-wall'), 'utf8')
    assert.equal(marker, owner, 'Owned root marker mismatch')
    await rm(owned, { recursive: true, force: true })
    const gone = await readFile(join(owned, '.owned-by-sticky-wall')).then(() => false, (error) => error.code === 'ENOENT')
    report.cleanup.rootRemoved = gone
    cleanupVerified = gone
  } catch (error) {
    report.cleanup.error = String(error)
  }
  report.cleanup.verified = cleanupVerified
  await writeFile(join(repo, `verify-isolated-${manifest.version}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

if (failure) {
  process.stderr.write(`verify-isolated: FAILED\n${failure.stack ?? failure}\n${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = 1
} else {
  assert.equal(cleanupVerified, true, 'cleanup must be verified before reporting success')
  process.stdout.write(`verify-isolated: OK (${checks.length} checks)\n${JSON.stringify(report, null, 2)}\n`)
}
