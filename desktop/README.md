# HomeChef 桌面客户端（Windows）

Electron 外壳 + 仓库现有的 Fastify / SQLite 后端。**用户不需要安装 Node**：
后端跑在 Electron 主进程里，前端静态文件由同一个 Fastify 实例托管，
整个应用只有一个监听在 127.0.0.1 的端口。

## 运行

两种形态，任选其一：

- **安装包**：`release/HomeChef-Setup-0.2.5.exe`（NSIS，按用户安装，可改安装目录，约 100 MB）
- **免安装**：`release/win-unpacked/HomeChef.exe`

系统要求：Windows 10 / 11 x64。

## 数据位置

默认 `%APPDATA%\HomeChef`：

| 路径 | 内容 |
| --- | --- |
| `data/homechef.db` | 用户数据库 |
| `logs/main.log` | 主进程日志（启动、迁移、退出） |
| `backups/` | 恢复操作前自动留的副本 |
| `chromium/` | Chromium 缓存（已从 `%APPDATA%` 收进来） |

可以用环境变量 `HOME_CHEF_DATA_DIR` 覆盖整棵数据树（自动化测试就是靠它隔离的）。

**与仓库里的 `server/data` 完全隔绝**：开发用的真实库不会被桌面端读到或写入。

## 启动 / 退出

- 单实例锁：重复启动的第二个进程会立即退出，避免两个进程同时写同一个 SQLite 文件。
- 端口由系统分配（`port: 0`），不会占用 3001 / 5173，也不会和用户机器上别的服务抢端口。
- 关闭窗口 → 关闭 Fastify → `wal_checkpoint(TRUNCATE)` → 关闭 SQLite → 进程退出，端口随进程释放。
- 菜单「帮助 → 打开数据文件夹」可直接定位数据；"关于"里显示数据与日志路径。

## 持久化与升级

- 首次启动自动建库，并按顺序执行 `server/drizzle` 下的 15 个迁移。
- **升级只应用尚未执行的迁移**（靠 `__drizzle_migrations` 判定），不会重建库、不会清空用户数据。
- 安装包默认 `deleteAppDataOnUninstall: false`，卸载不删数据。
- 需要回退或搬迁时，用「文件 → 导出备份 / 从备份恢复」。

## 备份与恢复

真正的文件级逻辑在 `src/database-maintenance.ts`（**不依赖 electron**），
所以自动化测试可以直接调用它，而不是在脚本里用 `Copy-Item` 模拟。

### 备份文件校验（拒绝什么）

与安卓端同一套思路，`inspectDatabaseFile()` 逐项检查：

1. 文件存在、非空、≥ 512 字节，且文件头是 `SQLite format 3`；
2. `integrity_check = ok`（截断或损坏的库会被 `UNREADABLE` / `INTEGRITY` 拦下）；
3. **必须**包含 HomeChef 的 16 张核心表（`app_settings`、`ingredient_definition`、`standard_ingredient`、`recipe`、`cooking_session`、`recommendation_request`、`__drizzle_migrations` 等）——其它应用的 SQLite 会因缺表被拒绝；
4. `application_id` 必须是 `1212377158`（HomeChef 指纹），或为 0 且其余各项全部通过（应用启动后会自动补写指纹）；
5. `__drizzle_migrations` **逐条**比对 `created_at` 与 `sha256(迁移 SQL)`——只比条数不够；
6. 迁移记录多于本应用已知数量 → `FUTURE_VERSION`（“来自更新版本，请先升级应用”）；
7. `foreign_key_check` 必须为空。

### 导出

- 拒绝把导出目标写成**当前活动库**或其 `-wal` / `-shm`，也拒绝导到备份目录本身；
- 用 better-sqlite3 的**在线备份 API**（`db.backup()`）直接拿一致快照，不依赖 checkpoint 是否成功；
- 复制完立刻用同一套校验函数复核产物；
- 拒绝导出到应用内部的保留文件（`.restore-staging.db` / `.restore-previous.db` / 待确认标记）。

### 恢复（标记先行、先暂存、保留原库、可回滚）

1. 拒绝把活动库或其 `-wal` / `-shm` 当作恢复来源；
2. 校验源文件；
3. 把当前库复制到 `backups/pre-restore-<时间>.db`；
4. 把源文件复制成 `data/.restore-staging.db`，**再校验一次**（防止复制过程被截断）；
5. **先原子写入 `data/.restore-pending.json`**（写 `.tmp` 再 rename）——在任何破坏性重命名之前；
6. 把原库连同 `-wal` / `-shm` 整体改名成 `data/.restore-previous.db*`（不删除）；
7. 暂存文件改名为正式库，然后重启应用。

**第 6、7 步任何一步失败都会立即回滚**：把 `.restore-previous.db*` 挪回原位、清掉标记与暂存，原库保持可用。
第 5 步写标记失败则直接取消恢复，此时原库尚未被动过。

**启动期幂等恢复**（打开数据库连接之前执行）：

| 现场状态 | 处理 |
| --- | --- |
| 无标记 | 正常启动 |
| 有新库且校验通过 | 继续启动（等确认） |
| 新库 MISSING 或有结构性损坏、`.restore-previous.db` 可用 | 回滚到原库再启动 |
| 新库 `UNREADABLE`（可能被杀软/其它进程短暂占用） | **不自动回滚**，拒绝启动并提示重试——瞬时错误上不做破坏性操作 |
| 标记损坏但当前库可用 | 继续启动，坏标记改名成 `.restore-pending.corrupt-*.json` |
| 标记损坏且库不可用 / 两边都不可用 | **拒绝启动**并提示用 `backups/` 手工恢复，绝不新建空库 |

**回滚不删除任何库**：当前（未完成的）新库会被改名成 `.restore-failed-<时间>.db` 保留，
因为它可能是用户数据唯一的一份副本。

- 迁移失败 → **先关闭 SQLite 连接**（否则 Windows 上文件被占用，回滚会 EPERM 失败）→ 回滚原库 → 自动重启；
- 退出时若有备份/恢复在进行，会阻止退出并提示，避免恢复被静默中断；
- 关闭 Fastify 有 3 秒超时，长连接不会让进程退不掉；
- **确认时机**：后端已监听**且窗口加载完成**之后才清除标记与 `.restore-previous.db`，不是在迁移通过时。

**互斥**：导出与恢复共用一把进程内锁，执行期间菜单项置灰，避免连点对话框造成并发替换。

## 从源码构建

前置：Node.js ≥ 20、npm。

```powershell
npm install
npm run build:client
npm run build:server
npm --workspace desktop run build      # tsc + 复制 server/dist 到 server-dist
npm --workspace desktop run dist       # electron-builder → desktop/release
```

国内网络需要镜像（否则 Electron 二进制与 NSIS 资源会下载超时）：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
```

### 关于 better-sqlite3

13.0.3 是 **Node-API 10** 模块（`binding.gyp` 里 `NAPI_VERSION=10`，用 `prebuilds/` 单平台二进制）。
实测在 Electron 38.8.6 里可以直接加载执行查询与事务，**不需要 electron-rebuild**，
因此 `package.json` 里把 `npmRebuild` 设为 `false`，避免无谓的源码编译。
原生二进制由 `asarUnpack` 解包到 `app.asar.unpacked`。

## 自动化验证

四个脚本都用临时数据目录隔离，不会碰真实用户数据和仓库库文件：

```powershell
# 备份/恢复的真实逻辑（直接 require dist/database-maintenance.js）
node scripts/maintenance-test.cjs

# 开发模式（electron + 源码目录）
pwsh -File scripts/smoke-test.ps1

# 打包产物
pwsh -File scripts/smoke-test.ps1 -Exe "D:\HomeChef\desktop\release\win-unpacked\HomeChef.exe"

pwsh -File scripts/content-backup-test.ps1
pwsh -File scripts/single-instance-test.ps1
```

## 已知限制

- 备份/恢复中的系统文件对话框未自动化；被自动化的是它背后的**真实**校验与替换逻辑。
- 恢复只接受 HomeChef 自己的数据库，并拒绝比当前应用更新的迁移版本。
- 未配置应用图标（使用 Electron 默认图标），未做代码签名。
- 首页与各业务页沿用现有 Web 版布局，**未在桌面窗口尺寸下逐页做视觉走查**。
- 便携版仍包含 better-sqlite3 的其它平台 prebuilds，体积可进一步裁剪。
