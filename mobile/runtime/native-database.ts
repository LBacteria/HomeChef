declare global { var HomeChefSQLite: { execute(sql: string, params: string, mode: string): string; confirmRestore():void; consumeValidationFlag():boolean }; }
let unavailable=false;
export function invoke(sql: string, params: unknown[] = [], mode = 'run'): any {
  if (unavailable) throw Error('数据库需要重启后检查');
  if (!globalThis.HomeChefSQLite) throw Error('请在 HomeChef 安卓客户端中打开');
  const result = JSON.parse(globalThis.HomeChefSQLite.execute(sql, JSON.stringify(params), mode));
  if (!result.ok) { const error = Object.assign(new Error(result.message), { code: result.code }); throw error; }
  return result.data;
}
export default class NativeDatabase {
  open = true;
  depth = 0;
  constructor(_path?: unknown, _options?: unknown) {}
  prepare(sql: string) {
    let raw = false;
    return {
      raw(value = true) { raw = value; return this; },
      all(...params: unknown[]) { const data = invoke(sql, params, 'query'); return raw ? data.rows : data.rows.map((row: unknown[]) => Object.fromEntries(data.columns.map((c: string, i: number) => [c, row[i]]))); },
      get(...params: unknown[]) { return this.all(...params)[0]; },
      run(...params: unknown[]) { return invoke(sql, params, 'run'); },
    };
  }
  exec(sql: string) { invoke(sql, [], 'exec'); return this; }
  pragma(sql: string, options?: { simple?: boolean }) { const data = invoke('PRAGMA ' + sql, [], 'query'); return options?.simple ? data.rows[0]?.[0] : data.rows.map((row: unknown[]) => Object.fromEntries(data.columns.map((c: string, i: number) => [c, row[i]]))); }
  transaction<T extends (...args: any[]) => any>(fn: T) {
    const run = (behavior: string, args: any[]) => {
      const nested = this.depth > 0; const savepoint = 'native_' + this.depth;
      this.exec(nested ? `SAVEPOINT ${savepoint}` : `BEGIN ${behavior}`); this.depth++;
      try {
        const result = fn(...args);
        if (result && typeof result.then === 'function') throw Error('同步数据库事务不能接收异步回调');
        this.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT'); return result;
      } catch (error) {
        try { this.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK'); if (nested) this.exec(`RELEASE SAVEPOINT ${savepoint}`); }
        catch { this.open = false; unavailable=true; throw Error('数据库回滚失败，请重启应用后重试'); }
        throw error;
      } finally { this.depth--; }
    };
    const wrapped = (...args: any[]) => run('DEFERRED', args);
    return Object.assign(wrapped, { deferred: wrapped, immediate: (...args: any[]) => run('IMMEDIATE', args), exclusive: (...args: any[]) => run('EXCLUSIVE', args) });
  }
  close() { this.open = false; }
}
