#!/usr/bin/env node
/**
 * sizes.mjs — compute source-code size (excluding .git) for every cloned repo.
 * Walks each Plugins/<owner>/<name> tree, sums file sizes, skips any path
 * segment equal to '.git'. Writes catalog/sizes-raw.json { repo: bytes }.
 * Resumable-ish: recomputes all cloned repos each run (fast enough).
 */
import { readdirSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PLUGINS = 'D:/github/Blue-Whale-Harness/Plugins'
const OUT = 'D:/github/Blue-Whale-Harness/catalog/sizes-raw.json'

function sizeOf(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let ents
    try { ents = readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      if (e.name === '.git') continue
      const p = join(cur, e.name)
      if (e.isDirectory()) {
        stack.push(p)
      } else if (e.isFile()) {
        try { total += statSync(p).size } catch {}
      }
      // skip symlinks
    }
  }
  return total
}

const out = {}
for (const owner of readdirSync(PLUGINS)) {
  if (owner === '.git') continue
  const op = join(PLUGINS, owner)
  let names
  try { names = readdirSync(op) } catch { continue }
  for (const name of names) {
    const dir = join(op, name)
    if (!existsSync(join(dir, '.git'))) continue
    out[`${owner}/${name}`] = sizeOf(dir)
  }
}
writeFileSync(OUT, JSON.stringify(out, null, 1))
const vals = Object.values(out)
const total = vals.reduce((a, b) => a + b, 0)
console.log(`sized ${vals.length} repos, total ${(total / 1024 / 1024).toFixed(1)} MB`)
const top = Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 8)
console.log('largest:', top.map(([k, v]) => `${k}=${fmt(v)}`).join('  '))

function fmt(b) {
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + 'MB'
  if (b >= 1024) return (b / 1024).toFixed(0) + 'KB'
  return b + 'B'
}
