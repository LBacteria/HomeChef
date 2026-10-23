import { sqlite } from '@homechef/server/src/db/index';
import journal from '@homechef/server/drizzle/meta/_journal.json';
import migrations from 'virtual:homechef-migrations';
import { createHash } from './crypto';
const files = Object.fromEntries(migrations.map(entry=>[`@homechef/server/drizzle/${entry.tag}.sql`,entry.source]));
export function migrate() {
  sqlite.pragma('foreign_keys = OFF');
  // Android owns the connection pool. Keep its default DELETE journal mode;
  // changing WAL through raw SQL bypasses that pool's configuration.
  sqlite.pragma('busy_timeout = 5000');
  sqlite.exec('CREATE TABLE IF NOT EXISTS __drizzle_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,hash TEXT NOT NULL,created_at INTEGER)');
  const installed = sqlite.prepare('SELECT * FROM __drizzle_migrations ORDER BY created_at').all() as Array<{hash:string;created_at:number}>;
  if (installed.length > journal.entries.length) throw Error('此数据库来自更新版本，请先升级应用');
  for (let i=0;i<installed.length;i++) {
    const entry=journal.entries[i]; const sql=files[`@homechef/server/drizzle/${entry.tag}.sql`];
    if (installed[i].created_at !== entry.when || installed[i].hash !== createHash('sha256').update(sql).digest('hex')) throw Error('数据库迁移记录不匹配，已停止升级');
  }
  try {
    sqlite.transaction(() => {
      for (const entry of journal.entries.slice(installed.length)) {
        const source = files[`@homechef/server/drizzle/${entry.tag}.sql`];
        for (const chunk of source.split('--> statement-breakpoint')) {
          const statement = chunk.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*--.*$/gm,'').trim();
          if (!statement || /^PRAGMA\s+foreign_keys/i.test(statement)) continue;
          // Android SQLite may retain a self-qualified CHECK after table rename.
          // Removing only that CREATE TABLE's own qualifier preserves its meaning.
          const ownTable = /^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+["`]?([A-Za-z_]\w*)/i.exec(statement)?.[1];
          const portable = ownTable ? statement.replace(/["`]([A-Za-z_]\w*)["`]\./g, (whole, table) => table === ownTable ? '' : whole) : statement;
          try { sqlite.exec(portable); } catch (error) { throw Error(entry.tag + ': ' + String(error)); }
        }
        sqlite.prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)').run(createHash('sha256').update(source).digest('hex'),entry.when);
      }
      if ((sqlite.pragma('foreign_key_check') as unknown[]).length) throw Error('升级后的数据关联检查失败');
      sqlite.pragma('application_id = 1212377158');
    }).immediate();
  } finally { sqlite.pragma('foreign_keys = ON'); }
  if (sqlite.pragma('foreign_keys',{simple:true}) !== 1) throw Error('无法启用数据关联约束');
}
