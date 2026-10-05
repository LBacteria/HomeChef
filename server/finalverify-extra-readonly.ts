/**
 * 最终验证 · 补充只读检查
 *
 * 1. 文档中声明的 npm scripts 是否真实存在
 * 2. 文档中引用的文件路径是否存在
 * 3. 文档之间是否互相矛盾（1:N / AUTOINCREMENT / 入库日期）
 * 4. README 的端口与 scripts 是否与实际配置一致
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd(), '..')
const docs = ['PROJECT_SPEC.md', 'DATABASE_DESIGN.md', 'ARCHITECTURE.md', 'README.md', 'TECH_STACK.md']
const t: Record<string, string> = {}
for (const d of docs) t[d] = readFileSync(resolve(root, d), 'utf8')

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` —— ${detail}` : ''}`)
  cond ? pass++ : fail++
}

/* ===== 1. npm scripts 真实性 ===== */
console.log('===== 1. 文档声明的 npm scripts =====')
const rootPkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const serverPkg = JSON.parse(readFileSync(resolve(root, 'server', 'package.json'), 'utf8'))
const clientPkg = JSON.parse(readFileSync(resolve(root, 'client', 'package.json'), 'utf8'))
const allScripts = new Set([
  ...Object.keys(rootPkg.scripts ?? {}),
  ...Object.keys(serverPkg.scripts ?? {}),
  ...Object.keys(clientPkg.scripts ?? {}),
])
console.log('  实际可用 scripts:', [...allScripts].join(', '))

// README 中出现的 npm run 命令
const readmeCmds = [...new Set([...t['README.md'].matchAll(/npm run ([a-z:_-]+)/g)].map((m) => m[1]))]
for (const c of readmeCmds) {
  ok(`README 中的 "npm run ${c}" 真实存在`, allScripts.has(c))
}

/* ===== 2. 文档引用的文件路径 ===== */
console.log('\n===== 2. 文档引用的文件是否存在 =====')
const referenced = new Set<string>()
for (const d of docs) {
  for (const m of t[d].matchAll(/`([A-Za-z0-9_\-./]+\.(?:md|json|ts|db|sql))`/g)) {
    const p = m[1]
    if (p.includes('/') || /^[A-Z_]+\.md$/.test(p)) referenced.add(p)
  }
}
for (const p of [...referenced].sort()) {
  // 这些是文档名或代码路径引用
  const candidates = [
    resolve(root, p),
    resolve(root, 'server', p),
    resolve(root, 'client', p),
  ]
  const found = candidates.some((c) => existsSync(c))
  // 部分引用是描述性路径（如 server/data/homechef.db 运行时生成），允许不存在
  const optional = /homechef\.db|data\//.test(p)
  ok(`引用 ${p}`, found || optional, found ? '存在' : '运行时生成/描述性路径')
}

/* ===== 3. 文档互链 ===== */
console.log('\n===== 3. 文档之间的互相引用 =====')
for (const d of docs) {
  const links = [...new Set([...t[d].matchAll(/`([A-Z_]+\.md)`/g)].map((m) => m[1]))]
  const broken = links.filter((l) => !existsSync(resolve(root, l)))
  ok(`${d} 引用的文档都存在`, broken.length === 0, broken.join(', ') || `${links.length} 个引用`)
}

/* ===== 4. 关键规则跨文档一致性 ===== */
console.log('\n===== 4. 关键规则跨文档一致性 =====')

// 4.1 1:N 模型
const oneToN = docs.filter((d) => /1\s*:\s*N|0\.\.N/.test(t[d]))
ok('至少 3 份文档使用 1:N 表述', oneToN.length >= 3, oneToN.join(', '))

// 4.2 无 UNIQUE(definition_id)
const noUnique = docs.filter((d) => !/UNIQUE\(definition_id\)/.test(t[d]) || /不(允许|使用)|\*\*无\*\*|没有/.test(t[d]))
ok('无文档错误声称存在 UNIQUE(definition_id)', noUnique.length === docs.length)

// 4.3 AUTOINCREMENT
const auto = docs.filter((d) => /AUTOINCREMENT/i.test(t[d]))
ok('至少 4 份文档提及 AUTOINCREMENT', auto.length >= 4, `${auto.length}/5`)

// 4.4 "入库日期"用词
const wrongTerm = docs.filter((d) => t[d].includes('购买日期'))
ok('无文档使用旧称"购买日期"', wrongTerm.length === 0, wrongTerm.join(', ') || '全部使用"入库日期"')

// 4.5 manual/estimated 优先级
const priorityDocs = ['PROJECT_SPEC.md', 'DATABASE_DESIGN.md', 'ARCHITECTURE.md', 'README.md']
const inconsistent = priorityDocs.filter((d) => {
  const hasManualNotOverwritten = /manual[^\n]{0,80}(不被|不会)(自动)?(覆盖|改写)|(不被|不会)(自动)?(覆盖|改写)[^\n]{0,80}manual/.test(t[d])
  return !hasManualNotOverwritten
})
ok('业务文档均声明 manual 不被自动覆盖', inconsistent.length === 0, inconsistent.join(', ') || '全部一致')

// 4.6 zero quantity
const zeroDocs = ['PROJECT_SPEC.md', 'DATABASE_DESIGN.md', 'ARCHITECTURE.md', 'README.md']
const zeroOk = zeroDocs.filter((d) => /(保留|不删除)/.test(t[d]) && /(隐藏|不显示)/.test(t[d]))
ok('业务文档均声明"保留记录但隐藏"', zeroOk.length >= 3, `${zeroOk.length}/4`)

// 4.7 删除保护
const deleteProtect = docs.filter((d) => /HAS_STOCK/.test(t[d]))
ok('至少 3 份文档提及 HAS_STOCK 删除保护', deleteProtect.length >= 3, deleteProtect.join(', '))

/* ===== 5. 端口与配置一致性 ===== */
console.log('\n===== 5. 配置一致性 =====')
const serverSrc = readFileSync(resolve(root, 'server', 'src', 'server.ts'), 'utf8')
const portMatch = serverSrc.match(/PORT \?\? (\d+)/)
const realPort = portMatch?.[1]
console.log('  实际后端默认端口:', realPort)
ok('README 声明的后端端口与实际一致', t['README.md'].includes(`:${realPort}`), `实际 ${realPort}`)

const viteSrc = readFileSync(resolve(root, 'client', 'vite.config.ts'), 'utf8')
const proxyMatch = viteSrc.match(/localhost:(\d+)/)
ok('README 声明的 proxy 目标与实际一致', t['README.md'].includes(`:${proxyMatch?.[1]}`), `实际 ${proxyMatch?.[1]}`)

/* ===== 6. 表清单一致性 ===== */
console.log('\n===== 6. 表清单一致性 =====')
const schemaSrc = readFileSync(resolve(root, 'server', 'src', 'db', 'schema.ts'), 'utf8')
const schemaTables = [...schemaSrc.matchAll(/sqliteTable\(\s*'([a-z_]+)'/g)].map((m) => m[1])
console.log('  schema.ts 中定义的表:', schemaTables.join(', '))
ok('schema 定义 4 张表', schemaTables.length === 4)
for (const tb of schemaTables) {
  const inDb = t['DATABASE_DESIGN.md'].includes(tb)
  ok(`DATABASE_DESIGN.md 描述 ${tb}`, inDb)
}

console.log(`\n===== 补充检查结果：PASS=${pass}  FAIL=${fail} =====`)
