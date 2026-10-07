/**
 * 最小复现：定位 Cross-Category 测试中 2 个 FAIL 的真实原因
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

const PORT = 56000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`
const dbPath = resolve(process.cwd(), 'data', `u1-repro-${Date.now()}.db`)
for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

const setup = new Database(dbPath)
setup.pragma('foreign_keys = ON')
const dd = resolve(process.cwd(), 'drizzle')
for (const f of readdirSync(dd).filter((x) => x.endsWith('.sql')).sort()) {
  for (const st of readFileSync(resolve(dd, f), 'utf8').split('--> statement-breakpoint')) {
    const t = st.trim(); if (t) setup.exec(t)
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
  let p: any; try { p = text ? JSON.parse(text) : undefined } catch { p = undefined }
  return { status: res.status, body: p }
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

  const seasonA = await req('POST', '/api/definitions', { name: '复现A', units: [], category_id: SEASONING })
  const seasonB = await req('POST', '/api/definitions', { name: '复现B', units: [], category_id: SEASONING })

  // 复现 Cross-Category 脚本的完整序列
  console.log('--- 先给 seasonA 建库存（模拟脚本前序步骤）---')
  const inv0 = await req('POST', '/api/ingredients', { definition_id: seasonA.body.id, note: '第一备注' })
  console.log('  inv0:', inv0.status, 'id=', inv0.body?.id, 'note=', JSON.stringify(inv0.body?.note))

  console.log('--- 再建一次（模拟 sKeepInv，同 definition）---')
  const inv1 = await req('POST', '/api/ingredients', {
    definition_id: seasonA.body.id, note: '调味品同类切换',
  })
  console.log('  inv1:', inv1.status, 'id=', inv1.body?.id, 'note=', JSON.stringify(inv1.body?.note))
  console.log('  → id 是否与 inv0 相同:', inv0.body?.id === inv1.body?.id)
  console.log('  → 说明：调味品 createStock 是「已存在则返回已有记录」')

  console.log('')
  console.log('--- 切换 inv1 到 seasonB ---')
  const sw = await req('PATCH', `/api/ingredients/${inv1.body.id}`, { definition_id: seasonB.body.id })
  console.log('  切换:', sw.status)

  const after = raw.prepare('select * from standard_ingredient where id = ?').get(inv1.body.id) as any
  console.log('  切换后:', JSON.stringify(after))

  const list = (await req('GET', '/api/ingredients')).body
  console.log('  列表长度:', list.length)
  const inList = list.find((r: any) => r.id === inv1.body.id)
  console.log('  列表中可见:', inList !== undefined)
  console.log('')
  console.log('  所有 quantity=0 的库存记录:')
  for (const r of raw.prepare('select id, definition_id, quantity, unit, note from standard_ingredient where quantity = 0').all() as any[]) {
    const cat = raw.prepare(`
      select c.name from ingredient_definition d
      left join category c on c.id = d.category_id where d.id = ?
    `).get(r.definition_id) as any
    const visible = list.some((x: any) => x.id === r.id)
    console.log(`    id=${r.id} def=${r.definition_id} cat=${cat?.name} visible=${visible}`)
  }
} finally {
  proc.kill()
  raw.close()
  await new Promise((r) => setTimeout(r, 500))
}
