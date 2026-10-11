/**
 * v0.2.0 Phase 3 批次 2 补充验证：统一保存的**事务中途失败回滚**
 *
 * 为什么需要这个测试
 * ──────────────────
 * 批次 2 主测试的所有失败用例都发生在 `db.transaction()` **开始之前**
 * （Service 层输入校验），因此无法证明"事务已执行部分写入后失败会回滚"。
 *
 * 本测试通过**受控故障注入**（见 src/services/faultInjection.ts）：
 *   ① 由环境变量 HOME_CHEF_FAULT_INJECT 控制，默认完全不生效
 *   ② 故障点位于事务**末尾** —— 此时三部分均已写入：
 *        · 菜谱基本信息已 UPDATE
 *        · 食材关联已 DELETE + INSERT
 *        · Tag 关联已 DELETE + INSERT（且可能已新建 Tag）
 *   ③ 随后人为抛错 → 验证整体回滚
 *
 * ⚠️ 独立临时数据库 + 动态端口，不触碰 homechef.db。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

const PORT = 64800 + Math.floor(Math.random() * 200)
const BASE = `http://127.0.0.1:${PORT}`
const dbPath = resolve(process.cwd(), 'data', `recipe-tx-${Date.now()}.db`)
for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

const drizzleDir = resolve(process.cwd(), 'drizzle')
const migrationFiles = readdirSync(drizzleDir).filter((x) => x.endsWith('.sql')).sort()
const setup = new Database(dbPath)
setup.pragma('foreign_keys = ON')
for (const f of migrationFiles) {
  for (const st of readFileSync(resolve(drizzleDir, f), 'utf8').split('--> statement-breakpoint')) {
    const t = st.trim(); if (t) setup.exec(t)
  }
}
setup.close()

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` —— ${detail}` : ''}`)
  cond ? pass++ : fail++
}
const info = (label: string, detail = '') => console.log(`  [INFO] ${label}${detail ? ` —— ${detail}` : ''}`)
const section = (t: string) => console.log(`\n===== ${t} =====`)

section('准备：seed')
await new Promise<void>((res) => {
  const p = spawn('npx', ['tsx', 'seed/seed.ts'], {
    cwd: process.cwd(), env: { ...process.env, HOME_CHEF_DB_PATH: dbPath }, shell: true, stdio: 'ignore',
  })
  p.on('close', () => res())
})

const raw = new Database(dbPath)
raw.pragma('foreign_keys = ON')
const defs = raw.prepare('select id, name from ingredient_definition order by id limit 3').all() as Array<{ id: number; name: string }>
ok('seed 完成，食材定义可用', defs.length >= 3, `${defs.length}`)
const [d1, d2, d3] = defs

/* ---------- 启动服务：带故障注入环境变量 ---------- */
const FAULT = 'recipe_full_save_after_links'
const proc: ChildProcess = spawn('npx', ['tsx', 'src/server.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(PORT),
    HOME_CHEF_DB_PATH: dbPath,
    HOME_CHEF_FAULT_INJECT: FAULT,   // ← 关键：启用故障注入
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
})
let serverLog = ''
proc.stdout?.on('data', (d) => { serverLog += String(d) })
proc.stderr?.on('data', (d) => { serverLog += String(d) })

async function waitFor() {
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) return false
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return true } catch { /* */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

const j = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const t = await r.text(); let b: any
  try { b = t ? JSON.parse(t) : undefined } catch { b = undefined }
  return { status: r.status, body: b }
}

if (!(await waitFor())) {
  console.log('  [FAIL] 服务未就绪')
  console.log('  ' + serverLog.slice(-1500))
  fail++
} else {
  info('服务地址', BASE)
  info('故障注入点', FAULT)

  /* ============================================================
   * 1. 先建立基线：正常创建（此时故障注入不影响 createRecipe）
   * ============================================================ */
  section('1. 故障注入的适用范围')

  // ⚠️ 故障点只在 saveRecipeFull（统一保存）内。
  //    createRecipe 不经过该点 —— 这里先验证这一点，避免误判。
  const created = await j('POST', '/api/recipes', {
    name: '注入测试菜',
    note: '初始备注',
    ingredients: [{ definition_id: d1.id, quantity: 1, unit: '个' }],
    tags: ['注入Tag'],
  })
  ok('createRecipe 不受故障注入影响 → 201', created.status === 201, `${created.status}`)
  const injectedRid = created.body?.id

  // 对同一菜谱走统一保存 → 应触发注入
  const blocked = await j('PATCH', `/api/recipes/${injectedRid}/full`, {
    name: '★注入时应回滚的名称',
    note: '★注入时应回滚的备注',
    ingredients: [{ definition_id: d2.id, quantity: 7, unit: '克' }],
    tags: ['★注入时应回滚的新Tag'],
  })
  ok('★ 统一保存触发故障注入 → 失败', blocked.status >= 400, `${blocked.status}`)
  ok('★ 错误为 500 INTERNAL_ERROR（注入的是普通 Error）',
    blocked.status === 500 && blocked.body?.error?.code === 'INTERNAL_ERROR',
    `${blocked.status}/${blocked.body?.error?.code}`)

  const afterBlocked = raw.prepare('select name, note from recipe where id = ?').get(injectedRid) as any
  ok('★★ 注入失败后菜谱名称未变（回滚生效）',
    afterBlocked.name === '注入测试菜', `${afterBlocked.name}`)
  ok('★★ 注入失败后备注未变', afterBlocked.note === '初始备注', `${afterBlocked.note}`)
  const ingAfterInject = raw.prepare('select count(*) c from recipe_ingredient where recipe_id = ?').get(injectedRid) as any
  ok('★★ 注入失败后食材关联未变（仍 1 条）', ingAfterInject.c === 1, `${ingAfterInject.c}`)
  const tagLeak0 = raw.prepare('select count(*) c from recipe_tag where name_normalized = ?')
    .get('★注入时应回滚的新tag') as any
  ok('★★ 注入失败后新 Tag 未泄漏', tagLeak0.c === 0, `${tagLeak0.c}`)

  // 清理这条测试菜谱，避免影响后续基线断言
  raw.prepare('delete from recipe where id = ?').run(injectedRid)
  raw.prepare("delete from recipe_tag where name_normalized = '注入tag'").run()
  const cleared = raw.prepare('select count(*) c from recipe').get() as any
  ok('  测试数据已清理', cleared.c === 0, `${cleared.c}`)

  /* ============================================================
   * 2. 关闭故障注入：重启服务建立基线数据
   * ============================================================ */
  section('2. 关闭故障注入，建立基线')

  proc.kill()
  await new Promise((r) => setTimeout(r, 800))

  const proc2: ChildProcess = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOME_CHEF_DB_PATH: dbPath,
      // ⚠️ 不设置 HOME_CHEF_FAULT_INJECT → 故障注入完全不生效
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  })
  let log2 = ''
  proc2.stdout?.on('data', (d) => { log2 += String(d) })
  proc2.stderr?.on('data', (d) => { log2 += String(d) })

  async function waitFor2() {
    for (let i = 0; i < 100; i++) {
      if (proc2.exitCode !== null) return false
      try { const r = await fetch(`${BASE}/health`); if (r.ok) return true } catch { /* */ }
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  }

  if (!(await waitFor2())) {
    console.log('  [FAIL] 重启后服务未就绪'); console.log('  ' + log2.slice(-1200)); fail++
  } else {
    ok('无故障注入时服务正常启动', true)

    const base = await j('POST', '/api/recipes', {
      name: '回滚测试菜',
      note: '原始备注',
      ingredients: [
        { definition_id: d1.id, quantity: 1, unit: '个', note: '原始食材A' },
        { definition_id: d2.id, quantity: 100, unit: '克', note: '原始食材B' },
      ],
      tags: ['原始Tag'],
    })
    ok('基线菜谱创建成功 → 201', base.status === 201, `${base.status}`)
    const rid = base.body.id

    // 记录基线快照
    const snapshot = () => {
      const r = raw.prepare('select id, name, name_normalized, note, updated_at from recipe where id = ?').get(rid) as any
      const ings = raw.prepare(
        'select definition_id, quantity, unit, note, sort_order from recipe_ingredient where recipe_id = ? order by sort_order, id',
      ).all(rid)
      const tags = raw.prepare(
        `select t.name from recipe_tag_link l join recipe_tag t on t.id = l.tag_id
         where l.recipe_id = ? order by l.id`,
      ).all(rid).map((x: any) => x.name)
      return { r, ings, tags }
    }

    const before = snapshot()
    info('回滚前 · 菜谱', `name=${before.r.name} note=${before.r.note}`)
    info('回滚前 · 食材', JSON.stringify(before.ings))
    info('回滚前 · Tag', JSON.stringify(before.tags))

    ok('基线：2 条食材', before.ings.length === 2, `${before.ings.length}`)
    ok('基线：1 个 Tag', before.tags.length === 1, JSON.stringify(before.tags))

    /* ============================================================
     * 3. ★ 重启服务并启用故障注入，执行"部分写入后失败"
     * ============================================================ */
    section('3. ★ 事务中途失败 → 整体回滚')

    proc2.kill()
    await new Promise((r) => setTimeout(r, 800))

    const proc3: ChildProcess = spawn('npx', ['tsx', 'src/server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(PORT),
        HOME_CHEF_DB_PATH: dbPath,
        HOME_CHEF_FAULT_INJECT: FAULT,   // ← 重新启用
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    })
    let log3 = ''
    proc3.stdout?.on('data', (d) => { log3 += String(d) })
    proc3.stderr?.on('data', (d) => { log3 += String(d) })

    async function waitFor3() {
      for (let i = 0; i < 100; i++) {
        if (proc3.exitCode !== null) return false
        try { const r = await fetch(`${BASE}/health`); if (r.ok) return true } catch { /* */ }
        await new Promise((r) => setTimeout(r, 300))
      }
      return false
    }

    if (!(await waitFor3())) {
      console.log('  [FAIL] 启用注入后服务未就绪'); console.log('  ' + log3.slice(-1200)); fail++
    } else {
      // 这次统一保存会：改名称/备注 → 删旧食材 → 插新食材 → 删旧Tag → 新建Tag → 抛错
      const attempt = await j('PATCH', `/api/recipes/${rid}/full`, {
        name: '★本应被回滚的名称',
        note: '★本应被回滚的备注',
        ingredients: [
          { definition_id: d3.id, quantity: 999, unit: '个', note: '★新食材1' },
          { definition_id: d3.id, quantity: 888, unit: '克', note: '★新食材2' },
          { definition_id: d3.id, quantity: null, unit: null, note: '★新食材3' },
        ],
        tags: ['★本应被回滚的新Tag'],
      })

      ok('★★ 统一保存 → 失败（注入生效）', attempt.status >= 400, `${attempt.status}`)
      ok('  返回 500 INTERNAL_ERROR', attempt.status === 500, `${attempt.status}`)
      info('响应', JSON.stringify(attempt.body))

      /* ---------- 断言：三部分全部恢复 ---------- */
      const after = snapshot()

      console.log('')
      info('回滚后 · 菜谱', `name=${after.r.name} note=${after.r.note}`)
      info('回滚后 · 食材', JSON.stringify(after.ings))
      info('回滚后 · Tag', JSON.stringify(after.tags))
      console.log('')

      ok('★ 菜谱 name 已回滚',
        after.r.name === before.r.name, `${after.r.name}（期望 ${before.r.name}）`)
      ok('★★ 菜谱 note 已回滚',
        after.r.note === before.r.note, `${after.r.note}（期望 ${before.r.note}）`)
      ok('★★ 菜谱 name_normalized 已回滚',
        after.r.name_normalized === before.r.name_normalized,
        `${after.r.name_normalized}`)
      ok('★ 菜谱 updated_at 已回滚（未被改动）',
        after.r.updated_at === before.r.updated_at,
        `${after.r.updated_at}`)

      ok('★★ 食材关联已回滚（仍 2 条）',
        after.ings.length === 2, `${after.ings.length}`)
      ok('★★ 食材内容逐字段一致',
        JSON.stringify(after.ings) === JSON.stringify(before.ings),
        JSON.stringify(after.ings))
      ok('★★ 没有残留新食材（d3 未被关联）',
        (after.ings as any[]).every((i) => i.definition_id !== d3.id),
        JSON.stringify((after.ings as any[]).map((i) => i.definition_id)))

      ok('★★ Tag 关联已回滚（仍 1 个且同名）',
        JSON.stringify(after.tags) === JSON.stringify(before.tags),
        JSON.stringify(after.tags))

      const leak = raw.prepare('select count(*) c from recipe_tag where name_normalized = ?')
        .get('★本应被回滚的新tag') as any
      ok('★★★ 事务内新建的 Tag 未泄漏', leak.c === 0, `${leak.c}`)

      const totalTags = raw.prepare('select count(*) c from recipe_tag').get() as any
      ok('  Tag 总数与基线一致（仅剩原始Tag）', totalTags.c === 1, `${totalTags.c}`)

      /* ---------- 再验证：服务仍然可用 ---------- */
      const healthAfter = await fetch(`${BASE}/health`)
      ok('  服务在事务回滚后仍可用', healthAfter.ok, `${healthAfter.status}`)

      const detailAfter = await j('GET', `/api/recipes/${rid}`)
      ok('  API 读取的详情也已回滚',
        detailAfter.status === 200 &&
        detailAfter.body.name === before.r.name &&
        detailAfter.body.ingredients.length === 2,
        `${detailAfter.body?.name} / ${detailAfter.body?.ingredients?.length}`)

      proc3.kill()
    }
  }
}

await new Promise((r) => setTimeout(r, 500))
raw.close()
// ⚠️ 进程刚结束，文件可能仍被短暂占用 → 容错删除，不影响测试结论
for (const s of ['', '-shm', '-wal']) {
  try { rmSync(`${dbPath}${s}`, { force: true }) } catch { /* 交给系统回收 */ }
}

console.log(`\n===== 事务回滚（中途失败）结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
