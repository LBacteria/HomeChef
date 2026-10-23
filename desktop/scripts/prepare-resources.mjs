// 把已构建的 server/dist 复制成 desktop/server-dist，并写入模块类型标记。
//
// 为什么要单独写一个 package.json：server 的产物是 ESM，而打包进 asar 后
// 模块类型由最近的 package.json 决定。显式标记 type=module，避免
// electron-builder 精简上层 package.json 时把 server-dist 当成 CJS。
import { cp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const source = path.resolve(desktopRoot, '..', 'server', 'dist');
const target = path.join(desktopRoot, 'server-dist');

if (!existsSync(path.join(source, 'app.js'))) {
  console.error('[prepare-resources] 未找到 server/dist/app.js，请先构建 server。');
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
await mkdir(target, { recursive: true });
await writeFile(path.join(target, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');
console.log('[prepare-resources] server-dist 就绪：' + target);
