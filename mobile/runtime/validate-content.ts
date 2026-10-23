import { sqlite } from '@homechef/server/src/db/index';
import { localRequest } from './router';
import { generateContent } from '@homechef/server/src/content/v024/recipes';
import { importContentV024 } from '@homechef/server/src/content/v024/importer';

export async function validateContent() {
  const checks: string[] = [];
  const assert = (value: unknown, name: string) => { if (!value) throw Error(name); checks.push(name); };
  const call = async (path: string, body: unknown, expected = 200) => {
    const response = await localRequest('/api' + path, { method: 'POST', body: JSON.stringify(body) });
    const data = await response.json();
    if (response.status !== expected) throw Error(`${path}: ${response.status} ${JSON.stringify(data)}`);
    return data;
  };
  const count = (table: string) => (sqlite.prepare(`SELECT count(*) n FROM ${table}`).get() as any).n;
  if (count('recipe') || count('ingredient_definition')) throw Error('Content validation requires a fresh isolated database');
  const content = generateContent();
  assert(content.recipes.length === 1211, '内容包数量为1211');
  const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as any[]).map(r => r.name);
  const snapshot = () => JSON.stringify(tables.map(name => [name, sqlite.prepare(`SELECT * FROM "${name}"`).all()]));
  const initial = snapshot();
  // This entry point requires a fresh, isolated Debug database. Run the existing
  // native business checks too, then restore only this test fixture's baseline.
  await (await import('./validate-core')).validateCore();
  await (await import('./validate-rollback')).validateRollback();
  const baseline = JSON.parse(initial) as Array<[string, Array<Record<string, unknown>>]>;
  sqlite.pragma('foreign_keys = OFF');
  try {
    sqlite.transaction(() => {
      for (const [table] of baseline) sqlite.prepare(`DELETE FROM "${table}"`).run();
      for (const [table, rows] of [...baseline.filter(([table]) => table !== 'sqlite_sequence'), ...baseline.filter(([table]) => table === 'sqlite_sequence')]) {
        if (table === 'sqlite_sequence') sqlite.prepare('DELETE FROM sqlite_sequence').run();
        for (const row of rows) {
        const columns = Object.keys(row);
        sqlite.prepare(`INSERT INTO "${table}" (${columns.map(name => `"${name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(name => row[name]));
      }
      }
    }).immediate();
  } finally { sqlite.pragma('foreign_keys = ON'); }
  if (snapshot() !== initial) throw Error('Isolated test baseline was not restored');
  let writes = 0, failed = false;
  const faulty = { prepare(sql: string) {
    const statement = sqlite.prepare(sql);
    return { all: (...args: any[]) => statement.all(...args), get: (...args: any[]) => statement.get(...args),
      run(...args: any[]) { if (++writes === 60) throw Error('content-write-fault'); return statement.run(...args); } };
  } };
  try { sqlite.transaction(() => importContentV024(faulty as any, content, { dryRun: false })).immediate(); }
  catch (error) { failed = String(error).includes('content-write-fault'); }
  assert(failed && snapshot() === initial, '导入中途故障整批回滚');
  await call('/content/starter', { pack: 'unknown' }, 400);
  await call('/content/starter', { pack: 'v024', extra: true }, 400);
  assert(snapshot() === initial, '非法请求零写入');
  const started = performance.now();
  const first = await call('/content/starter', { pack: 'v024' });
  assert(first.inserted_recipes === 1211 && first.skipped_invalid === 0 && count('recipe') === 1211, '空库完整导入1211道菜谱');
  assert(first.inserted_definitions > 0 && count('standard_ingredient') === 0, '导入食材且不添加库存');
  const populated = snapshot();
  const again = await call('/content/starter', { pack: 'v024' });
  assert(again.inserted_recipes === 0 && again.inserted_definitions === 0 && snapshot() === populated, '重复导入零新增且全部数据不变');
  const custom = await call('/definitions', { name: '用户自录食材', units: ['盒'], estimated_shelf_life_days: 77 }, 201);
  await call('/ingredients', { definition_id: custom.id, quantity: 7, unit: '盒', storage_method: '冷藏' }, 201);
  const stock = JSON.stringify(sqlite.prepare('SELECT * FROM standard_ingredient').all());
  const customBefore = JSON.stringify(sqlite.prepare('SELECT * FROM ingredient_definition WHERE id=?').get(custom.id));
  const candidate = sqlite.prepare("SELECT ri.recipe_id,ri.definition_id,ri.unit FROM recipe_ingredient ri JOIN ingredient_definition d ON d.id=ri.definition_id LEFT JOIN category c ON c.id=d.category_id WHERE ri.quantity>0 AND ri.unit IS NOT NULL AND c.name!='调味品' ORDER BY ri.recipe_id LIMIT 1").get() as any;
  const other = sqlite.prepare('SELECT id FROM recipe WHERE id!=? LIMIT 1').get(candidate.recipe_id) as any;
  sqlite.prepare('UPDATE recipe SET note=? WHERE id=?').run('用户自己修改的内容', other.id);
  sqlite.prepare('UPDATE ingredient_definition SET estimated_shelf_life_days=88 WHERE id=?').run(candidate.definition_id);
  sqlite.prepare('DELETE FROM ingredient_definition_unit WHERE definition_id=?').run(candidate.definition_id);
  const incompatibleUnit = candidate.unit === '盒' ? '罐' : '盒';
  sqlite.prepare('INSERT INTO ingredient_definition_unit(definition_id,unit,created_at) VALUES(?,?,?)').run(candidate.definition_id, incompatibleUnit, new Date().toISOString());
  sqlite.prepare('DELETE FROM recipe WHERE id=?').run(candidate.recipe_id);
  const conflict = await call('/content/starter', { pack: 'v024' });
  assert(conflict.inserted_recipes === 0 && conflict.skipped_invalid === 1 && conflict.unit_rejections.length > 0, '已有单位冲突整条菜谱跳过并报告');
  assert((sqlite.prepare('SELECT note FROM recipe WHERE id=?').get(other.id) as any).note === '用户自己修改的内容' && JSON.stringify(sqlite.prepare('SELECT * FROM ingredient_definition WHERE id=?').get(custom.id)) === customBefore, '用户菜谱与自录食材不覆盖');
  assert((sqlite.prepare('SELECT estimated_shelf_life_days n FROM ingredient_definition WHERE id=?').get(candidate.definition_id) as any).n === 88 && (sqlite.prepare('SELECT unit FROM ingredient_definition_unit WHERE definition_id=?').get(candidate.definition_id) as any).unit === incompatibleUnit, '用户保质期与单位不改写');
  assert(JSON.stringify(sqlite.prepare('SELECT * FROM standard_ingredient').all()) === stock, '已有库存完整保留');
  assert((sqlite.pragma('foreign_key_check') as any[]).length === 0 && sqlite.pragma('integrity_check', { simple: true }) === 'ok', '导入后数据库及外键完整');
  console.log('HOMECHEF_CONTENT_RESULT ' + JSON.stringify({ passed: checks.length, checks, fullImportDefinitions: first.inserted_definitions, elapsedMs: Math.round(performance.now() - started) }));
}
