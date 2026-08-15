#!/usr/bin/env node
/**
 * risk-report.mjs — merge 360 antivirus + programmatic scan into a unified risk table.
 *
 * Outputs:
 *   catalog/risk-report.md          — Markdown risk table (summary + per-file detail)
 *   catalog/risk-report.csv         — CSV export (repo-level)
 *   catalog/risk-report-detail.csv  — CSV export (per-file, every 360-flagged file)
 *   catalog/risk-report.html        — Filterable HTML page (expandable per-file detail)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const __dirname = import.meta.dirname
const SCAN = join(__dirname, 'risk-scan.json')
const R360 = join(__dirname, 'risk-360.json')
const INTENTS = join(__dirname, 'intents.json')

const scan = existsSync(SCAN) ? JSON.parse(readFileSync(SCAN, 'utf8')) : {}
const r360 = existsSync(R360) ? JSON.parse(readFileSync(R360, 'utf8')) : []
const intents = existsSync(INTENTS) ? JSON.parse(readFileSync(INTENTS, 'utf8')) : {}

// --- merge ---
const merged = {} // repo -> record

// 1) 360 results (highest trust — these are real AV detections)
for (const r of r360) {
  const repo = r.repo
  const intent = intents[repo] || {}
  merged[repo] = {
    repo,
    url: `https://github.com/${repo}`,
    stars: intent.stars ?? null,
    category: intent.dshCategory ?? '',
    isDshPlugin: intent.isDshPlugin ?? false,
    severity360: r.maxSeverity,
    alertCount360: r.alertCount,
    scanDate: r.scanDate,
    tags360: [...new Set(r.tags)],
    files360: r.files || [],
    severityScan: null,
    findingCountScan: 0,
    patternsScan: [],
    source: '360-antivirus-only',
    verdict: r.maxSeverity === 'critical' ? '🔴 确认恶意' : r.maxSeverity === 'high' ? '🟠 高危可疑' : '🟡 需关注',
    note: '360 杀毒引擎检出，含真实木马/webshell/病毒特征码',
  }
}

// 2) Programmatic scan findings
for (const [repo, s] of Object.entries(scan)) {
  if (merged[repo]) {
    merged[repo].severityScan = s.maxSeverity
    merged[repo].findingCountScan = s.findingCount
    merged[repo].patternsScan = [...new Set(s.scanFindings.map(f => f.label))]
    merged[repo].source = '360 + programmatic'
  } else {
    const intent = intents[repo] || {}
    if (s.maxSeverity === 'high') {
      merged[repo] = {
        repo,
        url: `https://github.com/${repo}`,
        stars: intent.stars ?? null,
        category: intent.dshCategory ?? '',
        isDshPlugin: intent.isDshPlugin ?? false,
        severity360: null,
        alertCount360: 0,
        scanDate: null,
        tags360: [],
        files360: [],
        severityScan: s.maxSeverity,
        findingCountScan: s.findingCount,
        patternsScan: [...new Set(s.scanFindings.map(f => f.label))],
        source: 'programmatic-pattern',
        verdict: '🟡 程序化扫描匹配高危模式（需人工复核）',
        note: '代码中检测到 eval/base64/exfil 等高危模式，可能为误报',
      }
    }
  }
}

// Sort: all 360-flagged first, then programmatic-scan
const sevOrder = { critical: 0, high: 1, medium: 2 }
const rows = Object.values(merged).sort((a, b) => {
  const aHas360 = !!a.severity360
  const bHas360 = !!b.severity360
  if (aHas360 !== bHas360) return aHas360 ? -1 : 1
  if (aHas360 && bHas360) {
    return (sevOrder[a.severity360] ?? 99) - (sevOrder[b.severity360] ?? 99)
      || b.alertCount360 - a.alertCount360
  }
  return (sevOrder[a.severityScan] ?? 99) - (sevOrder[b.severityScan] ?? 99)
    || b.findingCountScan - a.findingCountScan
})

console.log(`Risk table: ${rows.length} repos (${r360.length} from 360 AV, ${rows.length - r360.length} from programmatic)`)

function esc(v) { return String(v ?? '').replace(/"/g, '""') }
function escHtml(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) }

// ---------- repo-level CSV ----------
const cols = ['repo', 'url', 'verdict', 'severity360', 'alertCount360', 'scanDate', 'severityScan', 'findingCountScan', 'tags360', 'patternsScan', 'stars', 'category', 'isDshPlugin', 'source', 'note']
writeFileSync(join(__dirname, 'risk-report.csv'),
  [cols.join(',')].concat(rows.map(r => cols.map(c => {
    let v = r[c]
    if (Array.isArray(v)) v = v.join('; ')
    return `"${esc(v)}"`
  }).join(','))).join('\n'))

// ---------- per-file detail CSV (every 360-flagged file) ----------
const detailCols = ['repo', 'file', 'tag', 'severity', 'scanDate']
const detailRows = []
for (const r of r360) {
  const files = r.files || []
  const tags = r.tags || []
  for (let i = 0; i < files.length; i++) {
    const tag = tags[i] || ''
    const sev = /Trojan|Backdoor|web[sS]hell|HackTool/i.test(tag) ? 'high' : 'medium'
    detailRows.push({ repo: r.repo, file: files[i], tag, severity: sev, scanDate: r.scanDate })
  }
}
writeFileSync(join(__dirname, 'risk-report-detail.csv'),
  [detailCols.join(',')].concat(detailRows.map(d => detailCols.map(c => `"${esc(d[c])}"`).join(','))).join('\n'))
console.log(`  risk-report-detail.csv  (${detailRows.length} flagged files)`)

// ---------- Markdown (summary + per-file detail) ----------
const mdHead = `# Blue-Whale-Harness · 安全风险报告

> 基于 **360 杀毒引擎扫描结果** + **程序化代码安全扫描** ｜ ${new Date().toISOString().slice(0, 10)}

## 统计

| 指标 | 数量 |
|---|---|
| 总计风险仓库 | **${rows.length}** |
| 🔴 确认恶意 (360 critical) | **${rows.filter(r => r.severity360 === 'critical').length}** |
| 🟠 高危可疑 (360 high) | **${rows.filter(r => r.severity360 === 'high').length}** |
| 🟡 需关注 (360 medium / 扫描 high) | **${rows.filter(r => !r.severity360 || r.severity360 === 'medium').length}** |
| 360 逐文件告警总数 | **${detailRows.length}** |

## 一、风险仓库汇总表

| # | 仓库 | 判定 | 360等级 | 360告警 | 扫描等级 | 扫描命中 | STAR | 分类 | 真DSH | 数据来源 |
|---|---|---|---|---|---|---|---|---|---|---|
`
const mdSummary = rows.map((r, i) =>
  `| ${i + 1} | [${r.repo}](${r.url}) | ${r.verdict} | ${r.severity360 || '—'} | ${r.alertCount360 || 0} | ${r.severityScan || '—'} | ${r.findingCountScan || 0} | ${r.stars || 0} | ${r.category} | ${r.isDshPlugin ? '✅' : '—'} | ${r.source} |`
).join('\n')

// Per-file detail section (grouped by repo)
let mdDetail = '\n## 二、360 检出文件明细（逐文件）\n'
for (const r of r360) {
  mdDetail += `\n### 🔻 ${r.repo} — ${r.alertCount} 条告警（${r.maxSeverity}）\n\n`
  mdDetail += `| # | 文件相对路径 | 360 判定 |\n|---|---|---|\n`
  const files = r.files || []
  const tags = r.tags || []
  for (let i = 0; i < files.length; i++) {
    mdDetail += `| ${i + 1} | \`${files[i]}\` | ${escHtml(tags[i] || '')} |\n`
  }
}
writeFileSync(join(__dirname, 'risk-report.md'), mdHead + mdSummary + mdDetail + '\n')

// ---------- HTML (interactive, expandable per-file detail) ----------
const dataJson = JSON.stringify(rows).replace(/</g, '\\u003c')
const sevClass = s => s === 'critical' ? 'crit' : s === 'high' ? 'high' : 'med'
const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blue-Whale-Harness · 安全风险报告</title>
<style>
:root{--bg:#0d1117;--fg:#c9d1d9;--mut:#8b949e;--acc:#58a6ff;--bd:#30363d;--odd:#161b22;--red:#f85149;--orange:#d29922;--green:#3fb950}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:16px 20px;border-bottom:1px solid var(--bd);position:sticky;top:0;background:var(--bg);z-index:5}
h1{margin:0 0 4px;font-size:18px}
.stats{display:flex;gap:16px;margin-top:8px;font-size:13px;flex-wrap:wrap}
.stat-box{background:#161b22;border:1px solid var(--bd);border-radius:8px;padding:10px 14px}
.stat-num{font-size:22px;font-weight:700}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}
input,select{background:#0d1117;color:var(--fg);border:1px solid var(--bd);border-radius:6px;padding:6px 8px;font-size:13px}
input[type=search]{flex:1;min-width:200px}
table{width:100%;border-collapse:collapse}
th,td{padding:7px 10px;text-align:left;border-bottom:1px solid var(--bd);vertical-align:top}
th{position:sticky;top:150px;background:#161b22;cursor:pointer;user-select:none;white-space:nowrap}
th:hover{color:var(--acc)}
tbody tr:nth-child(odd){background:var(--odd)}
a{color:var(--acc);text-decoration:none}
a:hover{text-decoration:underline}
.tag{display:inline-block;padding:1px 6px;border:1px solid var(--bd);border-radius:10px;font-size:11px;color:var(--mut)}
.crit{color:var(--red)}.high{color:var(--orange)}.med{color:var(--mut)}
.num{text-align:right;font-variant-numeric:tabular-nums}
.verdict{font-weight:600}
details{margin:6px 0 6px 24px}
details>summary{cursor:pointer;color:var(--acc);font-size:13px}
details>ul{margin:6px 0;padding-left:18px}
details li{margin:3px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--mut)}
details li .ft{color:var(--fg)}
.tw{cursor:pointer;user-select:none}
</style></head><body>
<header>
<h1>Blue-Whale-Harness · 安全风险报告</h1>
<div class="stats">
<div class="stat-box"><div class="stat-num">${rows.length}</div><div>风险仓库</div></div>
<div class="stat-box"><div class="stat-num crit">${rows.filter(r => r.severity360 === 'critical').length}</div><div>🔴 确认恶意</div></div>
<div class="stat-box"><div class="stat-num high">${rows.filter(r => r.severity360 === 'high').length}</div><div>🟠 高危可疑</div></div>
<div class="stat-box"><div class="stat-num">${detailRows.length}</div><div>360 逐文件告警</div></div>
</div>
<div class="bar">
<input type="search" id="q" placeholder="搜索仓库 / 判定 / 标签 / 文件…">
<select id="src"><option value="">全部来源</option><option value="360">仅 360 杀毒</option><option value="programmatic">仅程序化扫描</option><option value="both">双源</option></select>
<select id="sev"><option value="">全部等级</option><option value="critical">critical</option><option value="high">high</option><option value="medium">medium</option></select>
<select id="sort"><option value="alert">按360告警数</option><option value="stars">按 STAR</option><option value="repo">按仓库名</option></select>
<span id="cnt" class="tag"></span>
</div>
</header>
<table><thead><tr>
<th data-k="repo">仓库</th><th data-k="verdict">判定</th><th data-k="severity360">360等级</th>
<th data-k="alertCount360" class="num">360告警</th><th data-k="severityScan">扫描等级</th>
<th data-k="findingCountScan" class="num">扫描命中</th><th data-k="stars" class="num">STAR</th>
<th data-k="category">分类</th><th data-k="source">来源</th><th>文件明细</th>
</tr></thead><tbody id="tb"></tbody></table>
<script>
const DATA=__DATA__;
const tb=document.getElementById('tb'),q=document.getElementById('q'),src=document.getElementById('src'),sev=document.getElementById('sev'),sort=document.getElementById('sort'),cnt=document.getElementById('cnt');
let dir=-1;
function sevOf(r){return r.severity360||r.severityScan||'medium'}
function render(){
 const qv=q.value.toLowerCase(),sv=sev.value,sr=src.value,sk=sort.value;
 let rows=DATA.filter(r=>{
   if(sv&&sevOf(r)!==sv)return false;
   if(sr==='360'&&!r.severity360)return false;
   if(sr==='programmatic'&&r.severity360)return false;
   if(sr==='both'&&!r.severity360)return false;
   if(qv){const hay=(r.repo+' '+(r.verdict||'')+' '+(r.tags360||[]).join(' ')+(r.files360||[]).join(' ')+(r.patternsScan||[]).join(' ')).toLowerCase();if(!hay.includes(qv))return false;}
   return true;
 });
 rows.sort((a,b)=>{
   if(sk==='repo')return dir*(a.repo).localeCompare(b.repo);
   if(sk==='stars')return dir*((a.stars||0)-(b.stars||0));
   return dir*((a.alertCount360||0)-(b.alertCount360||0));
 });
 tb.innerHTML=rows.map(r=>{
   let detail='';
   if(r.files360&&r.files360.length){
     const items=r.files360.map((f,i)=>'<li><span class="ft">'+esc(f)+'</span> &middot; '+esc((r.tags360&&r.tags360[i])||'')+'</li>').join('');
     detail='<details><summary>展开 '+r.files360.length+' 个被标记文件</summary><ul>'+items+'</ul></details>';
   }
   const sc=r.severity360||r.severityScan||'';
   return '<tr>'
     +'<td><a href="'+r.url+'" target="_blank">'+esc(r.repo)+'</a></td>'
     +'<td class="verdict">'+esc(r.verdict)+'</td>'
     +'<td class="'+(sc)+'">'+esc(r.severity360||'—')+'</td>'
     +'<td class="num">'+(r.alertCount360||0)+'</td>'
     +'<td class="">'+esc(r.severityScan||'—')+'</td>'
     +'<td class="num">'+(r.findingCountScan||0)+'</td>'
     +'<td class="num">'+(r.stars||0)+'</td>'
     +'<td>'+esc(r.category)+'</td>'
     +'<td><span class="tag">'+esc(r.source)+'</span></td>'
     +'<td>'+detail+'</td></tr>';
 }).join('');
 cnt.textContent=rows.length+' / '+DATA.length+' 个';
}
function esc(s){return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
q.oninput=render;src.onchange=render;sev.onchange=render;sort.onchange=render;
document.querySelectorAll('th[data-k]').forEach(th=>th.onclick=()=>{sort.value=th.dataset.k;dir*=-1;render();});
render();
</script></body></html>`

writeFileSync(join(__dirname, 'risk-report.html'), html.replace('__DATA__', dataJson))

console.log(`Generated:
  risk-report.csv          (${rows.length} rows)
  risk-report-detail.csv  (${detailRows.length} flagged files)
  risk-report.md
  risk-report.html`)
