const Database = require('better-sqlite3');
const db = new Database(':memory:');
const row = db.prepare('select sqlite_version() as v').get();
db.exec('create table t(a integer primary key, b text)');
db.prepare('insert into t(b) values (?)').run('hello');
const tx = db.transaction(() => { db.prepare('insert into t(b) values (?)').run('tx'); });
tx();
console.log(JSON.stringify({ ok: true, sqlite: row.v, rows: db.prepare('select count(*) c from t').get().c, node: process.versions.node, electron: process.versions.electron ?? null, modules: process.versions.modules }));
db.close();
