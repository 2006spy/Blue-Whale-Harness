#!/usr/bin/env node
/**
 * risk-scan.mjs — programmatic security scan across ALL cloned repos.
 *
 * Looks for:
 *   - Webshell patterns (PHP/ASP/JSP backdoors)
 *   - eval() / exec() / system() with obfuscated args
 *   - base64_decode + eval combos
 *   - Suspicious file extensions (.php, .asp, .aspx in non-web projects)
 *   - Known malware signatures (document.write + encoded strings)
 *   - Exfiltration URLs (external POST/GET to suspicious domains)
 *   - credential harvesting patterns
 *
 * Produces catalog/risk-scan.json (per-repo aggregated findings).
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const PLUGINS = join(ROOT, 'Plugins')
const INTENTS = join(import.meta.dirname, 'intents.json')
const OUT = join(import.meta.dirname, 'risk-scan.json')

const intents = existsSync(INTENTS) ? JSON.parse(readFileSync(INTENTS, 'utf8')) : {}

// --- pattern definitions ---
const PATTERNS = [
  {
    id: 'php-webshell',
    label: 'PHP Webshell',
    severity: 'critical',
    ext: ['.php'],
    re: /eval\s*\(\s*[\$_](POST|GET|REQUEST|COOKIE)|base64_decode\s*\(\s*[\$_]|assert\s*\(|preg_replace\s*\(.*\/[a-z]*e[a-z]*\s*['"]|call_user_func\s*\(\s*['"]|create_function\s*\(/i,
  },
  {
    id: 'asp-webshell',
    label: 'ASP/JSP Webshell',
    severity: 'critical',
    ext: ['.asp', '.aspx', '.jsp'],
    re: /eval\s*\(|execute\s*\(|Server\.CreateObject|Request\.(Form|QueryString|Item)|response\.write.*eval/i,
  },
  {
    id: 'obfuscated-eval',
    label: 'Obfuscated eval/exec',
    severity: 'high',
    ext: ['.js', '.ts', '.mjs', '.html', '.htm'],
    re: /eval\s*\(\s*(atob|btoa|Buffer\.from|String\.fromCharCode|\[.*?\]\.join)/i,
  },
  {
    id: 'base64-payload',
    label: 'Base64-encoded payload',
    severity: 'high',
    ext: ['.js', '.ts', '.mjs', '.html', '.htm', '.json'],
    re: /(atob|btoa)\s*\(\s*['"][A-Za-z0-9+\/=]{40,}['"]\s*\)|(Buffer\.from)\s*\(\s*['"][A-Za-z0-9+\/=]{40,}/i,
  },
  {
    id: 'credential-harvest',
    label: 'Credential harvesting',
    severity: 'high',
    ext: ['.js', '.ts', '.mjs', '.html', '.htm', '.py'],
    re: /password\s*[=:]\s*(localStorage|sessionStorage|document\.cookie|prompt|process\.env)/i,
  },
  {
    id: 'exfil-url',
    label: 'Exfiltration URL',
    severity: 'medium',
    ext: ['.js', '.ts', '.mjs', '.html', '.htm', '.py', '.md'],
    re: /fetch\s*\(\s*['"](https?:\/\/(?!github\.com|npmjs\.com|cdn\.|raw\.githubusercontent)[^'"]+)['"]\s*,\s*\{[^}]*method\s*:\s*['"]POST/i,
  },
  {
    id: 'suspicious-html-inject',
    label: 'Suspicious HTML injection',
    severity: 'medium',
    ext: ['.html', '.htm', '.md'],
    re: /<script[^>]*>(?!(function|var|const|let|window|document))/i,
  },
]

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.next', 'dist', 'build', '.cache', 'vendor', 'target'])

function walk(dir, maxDepth = 6) {
  const results = []
  const stack = [{ dir, depth: 0 }]
  while (stack.length) {
    const { dir: d, depth } = stack.pop()
    let entries
    try { entries = readdirSync(d) } catch { continue }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue
      const full = join(d, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 })
      } else if (st.isFile()) {
        results.push(full)
      }
    }
  }
  return results
}

function matchPatterns(filePath) {
  const ext = '.' + filePath.split('.').pop().toLowerCase()
  const hits = []
  // skip very large files (>500KB) and binary-looking paths
  try {
    if (statSync(filePath).size > 512000) return hits
  } catch { return hits }
  let content
  try { content = readFileSync(filePath, 'utf8') } catch { return hits }
  if (!content || content.length > 200000) return hits
  for (const p of PATTERNS) {
    if (p.ext && !p.ext.includes(ext)) continue
    const m = content.match(p.re)
    if (m) {
      hits.push({ id: p.id, label: p.label, severity: p.severity, match: m[0].slice(0, 80), line: content.slice(0, Math.max(m.index, 0)).split('\n').length })
    }
  }
  return hits
}

console.log('Scanning all cloned repos for security patterns...')
const owners = existsSync(PLUGINS) ? readdirSync(PLUGINS).filter(o => o !== '.git') : []

const repoFindings = {}
let totalFiles = 0, totalHits = 0

for (const owner of owners) {
  const ownerDir = join(PLUGINS, owner)
  let names
  try { names = readdirSync(ownerDir) } catch { continue }
  for (const name of names) {
    const repoDir = join(ownerDir, name)
    if (!existsSync(join(repoDir, '.git'))) continue
    const repo = `${owner}/${name}`
    const files = walk(repoDir)
    totalFiles += files.length
    const findings = []
    for (const f of files) {
      const rel = f.slice(repoDir.length + 1)
      const hits = matchPatterns(f)
      for (const h of hits) {
        findings.push({ file: rel, ...h })
        totalHits++
      }
    }
    if (findings.length > 0) {
      const intent = intents[repo]
      repoFindings[repo] = {
        repo,
        stars: intent?.stars ?? null,
        category: intent?.dshCategory ?? '',
        isDshPlugin: intent?.isDshPlugin ?? false,
        scanFindings: findings,
        maxSeverity: findings.some(f => f.severity === 'critical') ? 'critical'
          : findings.some(f => f.severity === 'high') ? 'high' : 'medium',
        findingCount: findings.length,
        scannedAt: new Date().toISOString(),
      }
    }
  }
}

writeFileSync(OUT, JSON.stringify(repoFindings, null, 1))
console.log(`Scan complete: ${totalFiles} files scanned, ${totalHits} pattern matches in ${Object.keys(repoFindings).length} repos`)
console.log(`Output: ${OUT}`)
