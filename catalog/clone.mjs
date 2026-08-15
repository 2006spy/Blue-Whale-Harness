#!/usr/bin/env node
/**
 * clone.mjs — git clone --depth 1 every repo in repos.txt into Plugins/<owner>/<name>/.
 *
 * Features:
 *   - resumable: skip dirs that already exist & look like a git repo
 *   - concurrency 6, per-clone timeout 120s
 *   - records failures to clones-failed.json (reason + http-ish code)
 *   - progress + periodic flush
 *
 * Reads token from .gh_token to use authenticated clone URL (higher rate limits
 * for private/large repos; public repos work either way).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const REPOS = join(ROOT, 'repos.txt')
const PLUGINS = join(ROOT, 'Plugins')
const FAILED = join(__dirname, 'clones-failed.json')

mkdirSync(PLUGINS, { recursive: true })

const TOKEN = (() => {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  const p = join(ROOT, '.gh_token')
  if (existsSync(p)) return readFileSync(p, 'utf8').trim()
  return null
})()

const repos = readFileSync(REPOS, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)

let failed = {}
if (existsSync(FAILED)) { try { failed = JSON.parse(readFileSync(FAILED, 'utf8')) } catch {} }

const CONCURRENCY = 6
const TIMEOUT_MS = 120_000
const retried = new Set() // repos attempted once already, allow one retry

function targetDir(repo) {
  const [owner, name] = repo.split('/')
  return join(PLUGINS, owner, name)
}
function isCloned(repo) {
  const d = targetDir(repo)
  return existsSync(join(d, '.git'))
}

function cloneOne(repo) {
  return new Promise(resolve => {
    const dir = targetDir(repo)
    let url = `https://github.com/${repo}.git`
    if (TOKEN) url = `https://${TOKEN}@github.com/${repo}.git`
    const args = ['clone', '--depth', '1', url, dir]
    const cp = spawn('git', args, { windowsHide: true, stdio: 'ignore' })
    let killed = false
    const t = setTimeout(() => { killed = true; cp.kill('SIGKILL'); }, TIMEOUT_MS)
    cp.on('close', code => {
      clearTimeout(t)
      if (code === 0 && isCloned(repo)) {
        resolve({ ok: true })
      } else {
        // clean partial
        try { rmSync(dir, { recursive: true, force: true }) } catch {}
        resolve({ ok: false, code, killed })
      }
    })
    cp.on('error', err => {
      clearTimeout(t)
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
      resolve({ ok: false, err: String(err.message) })
    })
  })
}

let i = 0
const total = repos.length
let savedAt = 0

async function worker() {
  while (i < total) {
    const idx = i++
    const repo = repos[idx]
    if (isCloned(repo)) {
      process.stdout.write(`\r[${idx + 1}/${total}] skip ${repo}`)
      continue
    }
    if (failed[repo] && !retried.has(repo)) {
      // skip permanently-failed unless we decide to retry
      process.stdout.write(`\r[${idx + 1}/${total}] was-failed ${repo}`)
      continue
    }
    const r = await cloneOne(repo)
    if (r.ok) {
      delete failed[repo]
      process.stdout.write(`\r[${idx + 1}/${total}] OK  ${repo}`)
    } else {
      failed[repo] = { code: r.code, killed: r.killed, err: r.err, at: new Date().toISOString() }
      process.stdout.write(`\r[${idx + 1}/${total}] FAIL ${repo} ${r.code ?? r.err ?? ''}`)
    }
    if (idx - savedAt >= 25) {
      writeFileSync(FAILED, JSON.stringify(failed, null, 1))
      savedAt = idx
    }
  }
}

const workers = Array.from({ length: CONCURRENCY }, () => worker())
await Promise.all(workers)
writeFileSync(FAILED, JSON.stringify(failed, null, 1))

const cloned = repos.filter(isCloned).length
console.log(`\nClone pass done. cloned dirs: ${cloned}/${total}, failed: ${Object.keys(failed).length}`)
