#!/usr/bin/env node
/**
 * fetch-meta.mjs — fetch live GitHub metadata for every repo in repos.txt.
 *
 * Output: catalog/meta-raw.json  (map repo -> github repo object subset)
 * Resumable: already-fetched repos are skipped unless --refresh.
 * Reads token from .gh_token (gitignored) or GH_TOKEN env.
 *
 * Fields captured (richer than dsh-suite's cached stars-only):
 *   stars, forks, created_at, updated_at, pushed_at, open_issues,
 *   language, license, description, archived, disabled, size, default_branch,
 *   watchers, homepage, topics, owner_type
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const REPOS = join(ROOT, 'repos.txt')
const OUT = join(__dirname, 'meta-raw.json')

function getToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  const p = join(ROOT, '.gh_token')
  if (existsSync(p)) return readFileSync(p, 'utf8').trim()
  return null
}

const TOKEN = getToken()
if (!TOKEN) {
  console.error('fetch-meta: no token. Set GH_TOKEN, or write it to .gh_token (gitignored).')
  process.exit(1)
}

const repos = readFileSync(REPOS, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
let meta = {}
if (existsSync(OUT)) {
  try { meta = JSON.parse(readFileSync(OUT, 'utf8')) } catch {}
}
const refresh = process.argv.includes('--refresh')
if (refresh) meta = {}

const CONCURRENCY = 8
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'blue-whale-harness-crawler',
  'X-GitHub-Api-Version': '2022-11-28',
}

function pick(json) {
  return {
    stars: json.stargazers_count,
    forks: json.forks_count,
    watchers: json.subscribers_count,
    created_at: json.created_at,
    updated_at: json.updated_at,
    pushed_at: json.pushed_at,
    open_issues: json.open_issues_count,
    language: json.language,
    license: json.license && json.license.spdx_id,
    description: json.description,
    archived: json.archived,
    disabled: json.disabled,
    size: json.size,
    default_branch: json.default_branch,
    homepage: json.homepage,
    topics: json.topics || [],
    owner_type: json.owner && json.owner.type,
    fetched_at: new Date().toISOString(),
  }
}

async function fetchOne(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers })
  if (res.status === 404) return { _error: 'not_found', fetched_at: new Date().toISOString() }
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get('x-ratelimit-reset')
    const wait = reset ? Math.max(0, Number(reset) * 1000 - Date.now()) + 2000 : 60000
    throw Object.assign(new Error('rate_limited'), { retryAfter: wait, repo })
  }
  if (!res.ok) return { _error: `http_${res.status}`, fetched_at: new Date().toISOString() }
  const json = await res.json()
  return pick(json)
}

let i = 0
const total = repos.length
let rateLimited = false
let savedAt = 0

async function worker() {
  while (i < total && !rateLimited) {
    const idx = i++
    const repo = repos[idx]
    if (!refresh && meta[repo] && !meta[repo]._error) {
      process.stdout.write(`\r[${idx + 1}/${total}] skip ${repo}`)
      continue
    }
    try {
      const data = await fetchOne(repo)
      meta[repo] = data
      const err = data._error ? ` (${data._error})` : ''
      process.stdout.write(`\r[${idx + 1}/${total}] ${repo}${err}`)
    } catch (e) {
      if (e.message === 'rate_limited') {
        rateLimited = true
        const sec = Math.round((e.retryAfter || 60000) / 1000)
        console.error(`\nRATE LIMITED — sleep ${sec}s then re-run to resume (progress saved).`)
        break
      }
      meta[repo] = { _error: String(e.message), fetched_at: new Date().toISOString() }
      process.stdout.write(`\r[${idx + 1}/${total}] ${repo} ERR ${e.message}`)
    }
    // periodic flush every 50
    if (idx - savedAt >= 50) {
      writeFileSync(OUT, JSON.stringify(meta, null, 1))
      savedAt = idx
    }
  }
}

const workers = Array.from({ length: CONCURRENCY }, () => worker())
await Promise.all(workers)
writeFileSync(OUT, JSON.stringify(meta, null, 1))

const ok = Object.values(meta).filter(v => !v._error).length
const errs = Object.entries(meta).filter(([, v]) => v._error)
console.log(`\nDone. ${ok} ok, ${errs.length} errors. Wrote ${OUT}`)
if (errs.length) {
  const counts = {}
  for (const [, v] of errs) counts[v._error] = (counts[v._error] || 0) + 1
  console.log('error breakdown:', JSON.stringify(counts))
}
