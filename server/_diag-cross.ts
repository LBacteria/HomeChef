/**
 * 诊断：普通食材 → 调味品 是否**在任何路径下**都可能？
 *
 * 只读诊断，不改产品代码。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

const PORT = 52000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`
const dbPath = resolve(process.cwd(), 'data', `diag-cross-${Date.now()}.db`)
for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

const setup = new Database(dbPath)
setup.pragma('foreign_keys = ON')
const drizzleDir = resolve(process.cwd(), 'drizzle')
for (const f of readdirSync(drizzleDir).filter((x) => x.endsWith('.sql')).sort()) {
  for (const stmt of readFileSync(resolve(drizzleDir, f), 'utf8').split('--> statement-breakpoint')) {
    const t = stmt.trim(); if (t) setup.exec(t)
  }
}
setup.close()

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed: any
  try { parsed = text ? JSON.parse(text) : undefined } catch { parsed = undefined }
  return { status: res.status, body: parsed }
}

const proc: ChildProcess = spawn('npx', ['tsx', 'src/server.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), HOME_CHEF_DB_PATH: dbPath },
  stdio: 'ignore', shell: true,
})
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`${BASE}/health`); if (r.ok) break } catch { /* */ }
  await new Promise((r) => setTimeout(r, 300))
}

const raw = new Database(dbPath)
raw.pragma('foreign_keys = ON')

try {
  await new Promise<void>((res) => {
    const p = spawn('npx', ['tsx', 'seed/seed.ts'], {
      cwd: process.cwd(), env: { ...process.env, HOME_CHEF_DB_PATH: dbPath },
      shell: true, stdio: 'ignore',
    })
    p.on('close', () => res())
  })

  const cats = (await req('GET', '/api/categories')).body
  const SEASONING = cats.find((c: any) => c.name === '调味品').id
  const VEG = cats.find((c: any) => c.name === '蔬菜').id

  console.log('===== 诊断：普通食材 → 调味品 =====\n')

  const normalDef = await req('POST', '/api/definitions', {
    name: '诊断普通食材', units: ['个', '克'], category_id: VEG,
  })
  const seasonDef = await req('POST', '/api/definitions', {
    name: '诊断调味品', units: [], category_id: SEASONING,
  })
  console.log(`普通食材 definition id = ${normalDef.body.id}（units: 个,克）`)
  console.log(`调味品   definition id = ${seasonDef.body.id}（units: 空）`)
  console.log('')

  console.log('--- 尝试 1：仅有数量与单位的普通库存 → 切调味品 ---')
  const inv1 = await req('POST', '/api/ingredients', {
    definition_id: normalDef.body.id, quantity: 3, unit: '个', purchase_date: '2026-10-07',
  })
  const r1 = await req('PATCH', `/api/ingredients/${inv1.body.id}`, { definition_id: seasonDef.body.id })
  console.log(`  结果: ${r1.status} ${r1.body?.error?.code ?? ''} ${r1.body?.error?.message ?? ''}`)

  console.log('')
  console.log('--- 尝试 2：同时切换 definition + unit（试图绕过）---')
  const inv2 = await req('POST', '/api/ingredients', {
    definition_id: normalDef.body.id, quantity: 3, unit: '个', purchase_date: '2026-10-07',
  })
  const r2 = await req('PATCH', `/api/ingredients/${inv2.body.id}`, {
    definition_id: seasonDef.body.id, unit: '个',
  })
  console.log(`  结果: ${r2.status} ${r2.body?.error?.code ?? ''} ${r2.body?.error?.message ?? ''}`)

  console.log('')
  console.log('--- 尝试 3：先把调味品的 units 加上「个」再切换 ---')
  const addUnit = await req('POST', `/api/definitions/${seasonDef.body.id}/units`, { unit: '个' })
  console.log(`  给调味品加 unit「个」: ${addUnit.status}`)
  const inv3 = await req('POST', '/api/ingredients', {
    definition_id: normalDef.body.id, quantity: 3, unit: '个', purchase_date: '2026-10-07',
  })
  const r3 = await req('PATCH', `/api/ingredients/${inv3.body.id}`, { definition_id: seasonDef.body.id })
  console.log(`  再切换: ${r3.status} ${r3.body?.error?.code ?? ''} ${r3.body?.error?.message ?? ''}`)
  if (r3.status === 200) {
    const row = raw.prepare('select * from standard_ingredient where id = ?').get(inv3.body.id) as any
    console.log(`  → 成功！结果 quantity=${row.quantity} unit=${row.unit} expiry=${row.expiry_date} source=${row.expiry_date_source}`)
    const api = (await req('GET', '/api/ingredients')).body.find((x: any) => x.id === inv3.body.id)
    console.log(`  → is_seasoning=${api?.is_seasoning} expiry_status=${api?.expiry_status} 列表可见=${api !== undefined}`)
  }

  console.log('')
  console.log('--- 尝试 4：直接改变 definition 的 category（而非库存的 definition_id）---')
  const patchDef = await req('PATCH', `/api/definitions/${normalDef.body.id}`, { category_id: SEASONING })
  console.log(`  PATCH /api/definitions/:id with category_id: ${patchDef.status}`)
  console.log(`  （该接口的 updateDefinitionSchema 是否支持 category_id 见源码）`)
  if (patchDef.status === 200) {
    const d = raw.prepare('select category_id from ingredient_definition where id = ?').get(normalDef.body.id) as any
    console.log(`  → definition 现在 category_id = ${d.category_id}（调味品 = ${SEASONING}）`)
    const apiN = (await req('GET', '/api/ingredients')).body.find((x: any) => x.id === inv1.body.id)
    console.log(`  → 该 definition 下库存 is_seasoning = ${apiN?.is_seasoning}`)
  }
} finally {
  proc.kill()
  raw.close()
  await new Promise((r) => setTimeout(r, 500))
}
