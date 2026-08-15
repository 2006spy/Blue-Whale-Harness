#!/usr/bin/env node
/**
 * analyze.mjs — programmatically infer each plugin's INTENT from cloned code + GitHub meta.
 *
 * Combines:
 *   - GitHub description / topics (from meta-raw.json)
 *   - Local signals: cordis.patch.yml presence, package.json deps & manifest,
 *     README first lines.
 *
 * Produces catalog/intents.json  (map repo -> intent record).
 * Resumable: re-run merges. Designed to be run repeatedly as clones land.
 *
 * Honest heuristic approach (no per-repo LLM): intent = GitHub description if
 * present, else first meaningful README line; "isDshPlugin" + techStack + keyDeps
 * are detected from real files.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PLUGINS = join(ROOT, 'Plugins')
const REPOS = join(ROOT, 'repos.json')
const META = join(__dirname, 'meta-raw.json')
const OUT = join(__dirname, 'intents.json')

const repos = JSON.parse(readFileSync(REPOS, 'utf8'))
let meta = {}
if (existsSync(META)) { try { meta = JSON.parse(readFileSync(META, 'utf8')) } catch {} }
let prev = {}
if (existsSync(OUT)) { try { prev = JSON.parse(readFileSync(OUT, 'utf8')) } catch {} }

function readText(p) { try { return readFileSync(p, 'utf8') } catch { return null } }
function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

// framework fingerprints -> human label
const FRAMEWORKS = [
  [/@deepseek-ai\/dsh-tools/, 'dsh-tools'],
  [/@deepseek-ai\/dsh-session/, 'dsh-session'],
  [/^@cordisjs\//, 'cordis'],
  [/^cordis$/, 'cordis'],
  [/^koishi/, 'koishi'],
  [/^@koishijs\//, 'koishi'],
  [/^@cordisjs\/core/, 'cordis-core'],
  [/react/, 'react'],
  [/vue/, 'vue'],
  [/express/, 'express'],
  [/^koa/, 'koa'],
  [/^@hono/, 'hono'],
  [/^fastify/, 'fastify'],
  [/puppeteer/, 'puppeteer'],
  [/playwright/, 'playwright'],
  [/openai/, 'openai-sdk'],
  [/axios/, 'axios'],
  [/typescript/, 'typescript'],
  [/esbuild/, 'esbuild'],
  [/vite/, 'vite'],
]

function detectDsh(repoDir, pkg) {
  const signals = []
  const hasManifest = existsSync(join(repoDir, 'cordis.patch.yml'))
  if (hasManifest) signals.push('cordis.patch.yml')
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) }
    for (const d of Object.keys(deps)) {
      if (d.startsWith('@deepseek-ai/')) signals.push(d)
      if (/^@cordisjs\//.test(d) || d === 'cordis') signals.push('cordis-dep:' + d)
      if (/^@koishijs\//.test(d) || d === 'koishi') signals.push('koishi-dep:' + d)
    }
    const kw = pkg.keywords || []
    if (kw.some(k => /dsh|deepseek.?harness|cordis|koishi|plugin/i.test(k))) signals.push('keyword-plugin')
    if (kw.some(k => /dsh-plugin|cordis-plugin/i.test(k))) signals.push('keyword-dsh')
  }
  // README evidence
  const readme = [join(repoDir, 'README.md'), join(repoDir, 'readme.md'), join(repoDir, 'README.zh.md')]
    .map(readText).find(Boolean)
  if (readme && /deepseek\s*harness|dsh[- ]?plugin|cordis\.patch/i.test(readme)) signals.push('readme-mentions-dsh')
  const isDsh = signals.some(s => /cordis\.patch\.yml|dsh-tools|dsh-session|keyword-dsh|readme-mentions-dsh/.test(s))
  return { isDsh, signals }
}

function detectTech(pkg, language) {
  const stack = []
  if (language) stack.push(language)
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
    for (const [re, label] of FRAMEWORKS) {
      for (const d of Object.keys(deps)) if (re.test(d)) { if (!stack.includes(label)) stack.push(label); break }
    }
    if (pkg.type === 'module') stack.push('esm')
    if (/tsc|tsup|ts-node/.test(JSON.stringify(pkg.scripts || {}))) stack.push('ts-build')
  }
  return stack
}

function hasCJK(s) { return /[一-鿿]/.test(s || '') }
function firstMeaningfulLine(md) {
  if (!md) return null
  const lines = md.split('\n')
    .map(l => l.replace(/<[^>]+>/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#+\s*/, '').replace(/[*_`>#]/g, '').replace(/&[a-z]+;/g, ' ').trim())
    .filter(l => l && /[A-Za-z一-鿿]/.test(l)) // must contain real letters/CJK, not pure markup
  for (const l of lines) {
    if (l.length >= 12 && l.length <= 200 && !/^(license|copyright|install|npm i|usage|\$\s)/i.test(l)) return l
  }
  return null
}

function entryOf(pkg) {
  if (!pkg) return null
  return pkg.main || (pkg.exports && (typeof pkg.exports === 'string' ? pkg.exports : pkg.exports['.']?.default)) || null
}

// ---------- translation (Google gtx primary, MyMemory fallback; cached) ----------
const TRANSLATIONS = join(__dirname, 'translations.json')
let transCache = {}
if (existsSync(TRANSLATIONS)) { try { transCache = JSON.parse(readFileSync(TRANSLATIONS, 'utf8')) } catch {} }
let quotaHit = false
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function gtx(src, targetIsZh) {
  const sl = hasCJK(src) ? 'zh' : 'en'
  const tl = targetIsZh ? 'zh' : 'en'
  if (sl === tl) return src
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&q=' +
    encodeURIComponent(src.trim().slice(0, 1000)) + '&sl=' + sl + '&tl=' + tl + '&dt=t'
  try {
    const { stdout } = await execFileP('curl', ['-s', '--max-time', '15', url], { maxBuffer: 1e7 })
    const j = JSON.parse(stdout)
    const t = j && j[0] ? j[0].map(x => x[0]).join('') : null
    return t && t.trim() ? t.trim() : null
  } catch (e) { return null }
}

async function mymemory(src, targetIsZh) {
  const pair = targetIsZh ? 'en|zh' : 'zh|en'
  try {
    const url = 'https://api.mymemory.translated.net/get?q=' +
      encodeURIComponent(src.trim().slice(0, 500)) + '&langpair=' + pair
    const res = await fetch(url)
    const j = await res.json()
    if (j.responseStatus === 200 && j.responseData && j.responseData.translatedText) {
      const t = j.responseData.translatedText
      if (/MYMEMORY WARNING|QUOTA|TRY AGAIN LATER|YOU EXCEEDED/i.test(t)) { quotaHit = true; return null }
      return t
    }
  } catch (e) {}
  return null
}

async function translate(src, targetIsZh) {
  if (!src || !src.trim()) return null
  if (hasCJK(src) === targetIsZh) return src // already in target language
  const pair = (targetIsZh ? 'zh|en' : 'en|zh') + '::' + src.trim().slice(0, 600)
  if (transCache[pair] != null) return transCache[pair]
  if (quotaHit) return null
  let t = null
  try { t = await gtx(src, targetIsZh) } catch (e) {}
  if (!t) t = await mymemory(src, targetIsZh)
  if (t) { transCache[pair] = t; await sleep(60) }
  return t
}

// code-analysis fallback when no usable description exists in either language
function codeAnalyze(dir, pkg, name, targetIsZh) {
  const signals = []
  if (existsSync(join(dir, 'cordis.patch.yml'))) signals.push('cordis.patch.yml')
  const deps = pkg ? Object.keys({ ...(pkg.dependencies || {}) }).filter(d => /dsh|cordis|koishi|deepseek/i.test(d)) : []
  const base = pkg && pkg.description ? pkg.description : ''
  if (targetIsZh) {
    return `DSH 插件「${name}」：${base ? base + '。' : '功能需查阅仓库源码。'}` +
      (signals.length ? ' 检测到 ' + signals.join('、') + '。' : '') +
      (deps.length ? ' 关键依赖 ' + deps.slice(0, 5).join('、') + '。' : '')
  }
  return `DSH plugin "${name}": ${base ? base : 'functionality requires reading the repo source.'}` +
    (signals.length ? ' Detected ' + signals.join(', ') + '.' : '') +
    (deps.length ? ' Key deps: ' + deps.slice(0, 5).join(', ') + '.' : '')
}

// ---------- pass 1: decide sources + collect unique translation jobs ----------
const plan = []
for (const r of repos) {
  const repo = r.repo
  const [, name] = repo.split('/')
  const dir = join(PLUGINS, repo.split('/')[0], name)
  const m = meta[repo] || {}
  const descZh = (r.desc_zh && r.desc_zh.trim()) || null
  const descEn = (r.desc_en && r.desc_en.trim()) || null
  const ghDesc = (m.description && m.description.trim()) || null
  const ghEn = ghDesc && !hasCJK(ghDesc) ? ghDesc : null
  const ghZh = ghDesc && hasCJK(ghDesc) ? ghDesc : null

  // Chinese column: prefer a Chinese source
  let zhSrc = null
  if (descZh && hasCJK(descZh)) zhSrc = descZh
  else if (ghZh) zhSrc = ghZh
  // English column: prefer a usable (non-Chinese, distinct) English source
  let enSrc = null
  if (descEn && !hasCJK(descEn) && descEn !== descZh) enSrc = descEn
  else if (ghEn && ghEn !== descZh) enSrc = ghEn

  // what we need to translate (source text -> target language)
  const jobs = [] // {src, targetIsZh}
  if (!zhSrc) {
    const src = descZh || ghZh || descEn || ghEn
    if (src) jobs.push({ src, targetIsZh: true })
  }
  if (!enSrc) {
    const src = descEn || ghEn || descZh || ghZh
    if (src) jobs.push({ src, targetIsZh: false })
  }
  plan.push({ repo, dir, name, lists: r._lists, category: r.category, language: r.language,
    stars: r.stars, license: r.license, compat: r.compat, featured: !!r.featured,
    pkg: () => readJson(join(dir, 'package.json')), zhSrc, enSrc, jobs })
}

// unique translation jobs (dedupe by src+target)
const jobMap = new Map()
for (const p of plan) for (const j of p.jobs) {
  const k = (j.targetIsZh ? 'zh::' : 'en::') + j.src.trim().slice(0, 600)
  if (!jobMap.has(k)) jobMap.set(k, j)
}
const uniqueJobs = [...jobMap.values()]
console.log(`Translation jobs (unique): ${uniqueJobs.length}  (quota-aware, cached)`)

async function runPool(items, worker, concurrency = 4) {
  let i = 0
  async function next() { while (i < items.length) { const idx = i++; await worker(items[idx]) } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next))
}
await runPool(uniqueJobs, async (j) => { await translate(j.src, j.targetIsZh) })
writeFileSync(TRANSLATIONS, JSON.stringify(transCache, null, 1))

// ---------- pass 2: build intents ----------
const out = { ...prev }
let n = 0
for (const p of plan) {
  const { repo, dir, name, lists, category, language, stars, license, compat, featured, zhSrc, enSrc, jobs } = p
  const pkg = p.pkg()
  const cloned = existsSync(join(dir, '.git'))
  const m = meta[repo] || {}
  const dsh = detectDsh(dir, pkg)
  const readme = [join(dir, 'README.md'), join(dir, 'README.zh.md'), join(dir, 'readme.md')]
    .map(readText).find(Boolean)

  let intentZh = zhSrc || null
  let intentEn = enSrc || null
  let zhFromTranslate = false, enFromTranslate = false, zhFromCode = false, enFromCode = false

  if (!intentZh) {
    const job = jobs.find(j => j.targetIsZh)
    if (job) { const t = await translate(job.src, true); if (t && hasCJK(t)) { intentZh = t; zhFromTranslate = true } }
  }
  if (!intentEn) {
    const job = jobs.find(j => !j.targetIsZh)
    if (job) { const t = await translate(job.src, false); if (t) { intentEn = t; enFromTranslate = true } }
  }
  // code-analysis fallback if still missing
  if (!intentZh) { intentZh = codeAnalyze(dir, pkg, name, true); zhFromCode = true }
  if (!intentEn) { intentEn = codeAnalyze(dir, pkg, name, false); enFromCode = true }

  const needsReview = zhFromCode || enFromCode
  const intent = intentEn || intentZh || null
  const keyDeps = pkg ? Object.keys({ ...(pkg.dependencies || {}) })
    .filter(d => /dsh|cordis|koishi|deepseek|react|vue|express|axios|openai/i.test(d)).slice(0, 8) : []
  out[repo] = {
    repo,
    lists,
    dshCategory: category,
    isDshPlugin: dsh.isDsh,
    dshSignals: dsh.signals,
    manifestType: existsSync(join(dir, 'cordis.patch.yml')) ? 'cordis.patch.yml'
      : pkg && /plugin/i.test(pkg.name || '') ? 'package.json' : 'none',
    language: m.language || language || (pkg ? 'JS/TS' : null),
    intent,
    intentEn,
    intentZh,
    zhSource: zhSrc ? 'native' : zhFromTranslate ? 'translated' : zhFromCode ? 'code-analysis' : 'missing',
    enSource: enSrc ? 'native' : enFromTranslate ? 'translated' : enFromCode ? 'code-analysis' : 'missing',
    needsReview,
    techStack: detectTech(pkg, m.language || language),
    keyDeps,
    entry: entryOf(pkg),
    stars: m.stars ?? stars ?? null,
    forks: m.forks ?? null,
    created_at: m.created_at ?? null,
    updated_at: m.updated_at ?? null,
    license: m.license || license || null,
    open_issues: m.open_issues ?? null,
    topics: m.topics || [],
    cloned,
    compat: compat || null,
    featured: featured,
    analyzed_at: new Date().toISOString(),
  }
  n++
}
writeFileSync(OUT, JSON.stringify(out, null, 1))
console.log(`Analyzed ${n} repos -> ${OUT}`)
const dshCount = Object.values(out).filter(v => v.isDshPlugin).length
const clonedCount = Object.values(out).filter(v => v.cloned).length
console.log(`isDshPlugin: ${dshCount}, cloned: ${clonedCount}`)
const review = Object.values(out).filter(v => v.needsReview).length
const zhTrans = Object.values(out).filter(v => v.zhSource === 'translated').length
const enTrans = Object.values(out).filter(v => v.enSource === 'translated').length
console.log(`translated Zh: ${zhTrans}, translated En: ${enTrans}, code-analysis fallback: ${review}, quotaHit: ${quotaHit}`)
