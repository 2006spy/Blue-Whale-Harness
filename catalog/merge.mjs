#!/usr/bin/env node
/**
 * merge.mjs — apply HY3 direct translations (my-translations-*.json) + adopt
 * original-language sides back into intents.json, overwriting the old
 * Google-machine-translated sides.
 *
 *   node merge.mjs
 *
 * Reads every my-translations-N.json plus todo-translate.json, then for each
 * entry that needed work:
 *   - if a HY3 translation exists for (repo,target) -> use it, source = 'hy3'
 *   - else if the target language IS the original language -> adopt origText,
 *     source = 'native'  (recovers text that was wrongly back-translated)
 *   - else -> leave untouched + warn
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const INTENTS = join(__dirname, 'intents.json')
const TODO = join(__dirname, 'todo-translate.json')

const intents = JSON.parse(readFileSync(INTENTS, 'utf8'))
const todo = JSON.parse(readFileSync(TODO, 'utf8'))

// collect all my-translations-*.json
const files = readdirSync(__dirname)
  .filter(f => /^my-translations-\d+\.json$/.test(f))
  .sort()
const myMap = new Map() // key repo|target -> text
let myCount = 0
for (const f of files) {
  const arr = JSON.parse(readFileSync(join(__dirname, f), 'utf8'))
  for (const t of arr) { myMap.set(t.repo + '|' + t.target, t.text); myCount++ }
}
console.log(`Loaded ${myCount} HY3 translations from ${files.length} file(s).`)

const todoByRepo = new Map(todo.map(e => [e.repo, e]))
let applied = 0, adopted = 0, missing = 0
const missingRepos = []

for (const [repo, v] of Object.entries(intents)) {
  const e = todoByRepo.get(repo)
  if (!e) continue // entry didn't need work
  let changed = false
  if (e.needZh) {
    const k = repo + '|zh'
    if (myMap.has(k)) { v.intentZh = myMap.get(k); v.zhSource = 'hy3'; applied++; changed = true }
    else if (e.origLang === 'zh') { v.intentZh = e.origText; v.zhSource = 'native'; adopted++; changed = true }
    else { missing++; missingRepos.push(repo + ':zh'); }
  }
  if (e.needEn) {
    const k = repo + '|en'
    if (myMap.has(k)) { v.intentEn = myMap.get(k); v.enSource = 'hy3'; applied++; changed = true }
    else if (e.origLang === 'en') { v.intentEn = e.origText; v.enSource = 'native'; adopted++; changed = true }
    else { missing++; missingRepos.push(repo + ':en'); }
  }
  // keep 'intent' helper consistent
  if (changed) v.intent = v.intentEn || v.intentZh || null
}

writeFileSync(INTENTS, JSON.stringify(intents, null, 1))
console.log(`Applied HY3: ${applied}, Adopted original: ${adopted}, Missing/unresolved: ${missing}`)
if (missing) console.log('UNRESOLVED:', missingRepos.slice(0, 20))
const zhT = Object.values(intents).filter(x => x.zhSource === 'translated').length
const enT = Object.values(intents).filter(x => x.enSource === 'translated').length
console.log(`Remaining 'translated' (Google) sides -> zh:${zhT} en:${enT}`)
