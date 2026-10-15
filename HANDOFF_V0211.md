# HomeChef v0.2.1.1 交接说明（烹饪记录管理）

> 生成时间：**2026-10-15**
> 最后更新：**2026-10-15 21:44（Asia/Shanghai）—— 迁移 0011 已执行并验证；后端已受控重启加载新代码，见 §8.8。**
> 状态：**v0.2.1.1 已启用**（真实库含 `cooking_session.name`；后端 PID 36996 运行新代码）。
> ⚠️ 本文件**独立于** [`HANDOFF_B1B.md`](./HANDOFF_B1B.md)，不覆盖、不替代它。
> 本文件记录 **v0.2.1.1** 的功能范围、实际改动、验证结果与上线待办。

---

## 1. 功能范围（用户已确定）

### 1.1 多选批量删除

- 每条记录左侧小复选框；列表顶部**全选 / 取消全选**，并支持**半选**（indeterminate）。
- 选中后显示「已选 N 条」与**统一删除入口**；**单条选中也走同一条后端路径**，不额外堆按钮。
- 列表当前**不分页、无筛选**，故「全选」范围＝当前加载的全部记录。
  若日后引入分页或筛选，必须把选择范围收敛到**当前可见集合**（代码中已注明）。

### 1.2 删除语义（**核心，必须保持**）

> **这是「清理历史记录」，不是「撤销烹饪」。**

- **不回补库存、不再次扣减库存**：`standard_ingredient` 的任何数值**完全不变**。
- 只删除**所选会话**及其**从属记录**，删除顺序显式按外键依赖排列：
  **结算明细 → 结算凭证 → 跳过确认 → 菜品 → 会话**。
  （`cooking_settlement_item.dish_id` 是 `ON DELETE RESTRICT`，只靠级联会失败。）
- **不删除**菜谱、不删除食材定义、不影响任何未选中的记录。
- **不做**归档箱、**不做**恢复、**不做**「删除菜谱时级联清理全部历史」。
- **全有或全无**：任一 id 不存在 → 整批 404，且**不删除任何行**。
- 全部删除在**单个事务**内完成，任一步失败整体回滚。

### 1.3 时间排序

- 默认按**烹饪时间**（`started_at`）**从新到旧**，同一时间用 `id` 降序保证**稳定次序**。
- **后端全表排序**，不是对当前页做倒序。
- **改名不改变排序**（只写 `name` / `updated_at`，不碰 `started_at`）。

### 1.4 命名与改名

- `cooking_session` 新增**可空**列 `name`（迁移 0011）。
- `name IS NULL` → **默认名称**：由 `started_at`（无法解析时回退 `created_at`）
  在**客户端本地时区**渲染为 `YYYY-MM-DD-HH:mm`，例如 `2026-10-15-21:30`。
- `name` 非空 → 自定义名称，**列表与详情一致显示**。
- 交互：名称旁**小铅笔** → **行内编辑**（无强制命名弹窗）；**Enter 保存 / Esc 取消**；
  编辑自动聚焦；复选框、铅笔、打开详情三者是**并列兄弟节点**，互不误触。
- **空 / 纯空白被拒绝**，且与「恢复默认」**语义分离**：
  前端提示；「恢复默认」按钮调用 API 传 `null`。
- 长度上限 **60**，三处一致：Service 常量 / API JSON Schema `maxLength` / 前端 `maxLength`。
- 提交期间有**同步互斥锁**（`renameLock`），避免 Enter 连按造成重复请求；
  失败**保留用户输入**并就地提示，绝不假装成功。
- **输入法组合期间让路**：`onKeyDown` 先检查 `nativeEvent.isComposing`
  与 `keyCode === 229`，组合中**直接返回**（不 `preventDefault`、不提交、不取消），
  避免中文选词的 Enter 误存未完成名称、Esc 误取消编辑。

### 1.5 旧记录

- 旧「会话 #N」自动名一律按开始时间显示为日期时间；
- **不批量改写**历史行（迁移 0011 **不回填**，历史行保持 `name = NULL`）。

---

## 2. 实际完成的文件

### 2.1 新增

| 文件 | 说明 |
|---|---|
| `server/drizzle/0011_cooking_session_name.sql` | 迁移 0011：`ALTER TABLE cooking_session ADD COLUMN name text` |
| `server/verify-v0211-cooking-records.ts` | 隔离验证脚本（65 条断言），路径安全前置 |

### 2.2 修改

| 文件 | 内容 |
|---|---|
| `server/drizzle/meta/_journal.json` | 追加 idx 11 / `when` 1791840000000 / tag `0011_cooking_session_name` |
| `server/src/db/schema.ts` | `cookingSession.name`（可空） |
| `server/src/services/cookingService.ts` | 名称常量、`CookingSessionSummary`、`updateSessionName()`、`listSessions()` 排序、`deleteSessions()` |
| `server/src/routes/cooking.ts` | `PATCH /api/cooking/sessions/:id/name`、`POST /api/cooking/sessions/batch-delete` |
| `client/src/types/api.ts` | `name` 字段、`CookingSessionsDeleteResult` |
| `client/src/api/cooking.ts` | `renameSession()`、`deleteSessions()` |
| `client/src/pages/CookingPage.tsx` | 复选框/全选/半选、批量删除、行内改名、IME 让路、迟到响应防护、锁定态 |
| `client/src/components/ConfirmDeleteDialog.tsx` | 新增可选 `description`（向后兼容） |
| `client/src/styles.css` | 多选工具栏、行内编辑器样式 |
| `server/harness/server-lifecycle.ts` | **修既有缺陷**：`assertSafeDbPath` 缺本地绑定导致 `startServer` 抛 `ReferenceError`（见 §3.4） |

### 2.3 未触碰

`HANDOFF_B1B.md`、`server/src/db/migrate.ts`、`server/src/db/safe-db-path.ts`，
以及 14 个未跟踪的受保护诊断脚本 —— 全部原样保留。
**未执行** `git add` / `commit` / `push` / `reset` / `clean` / `stash`。

---

## 3. 隔离验证结果

所有测试使用**独立临时库 + 动态端口**，运行目录为 `<base>/hc-v0211-<uuid>/`。

### 3.1 `verify-v0211-cooking-records.ts` → **PASS=65 FAIL=0，退出码 0**

覆盖：

- **路径安全**：共享 `assertSafeDbPath` 在创建/删除任何文件**之前**调用；
  仅清理本次运行子目录，并有「≠server/data、在 base 内、前缀匹配」三重校验。
- **迁移保留性**：旧 schema 库（0000–0010）插入旧记录 + 库存 → 应用 0011 →
  记录数量 / `started_at` / 库存**完全不变**，且 `name` **全为 NULL（不回填）**。
- **全量迁移**：全新库依次应用 12 个迁移成功。
- **改名**：保存 / 列表与详情重查仍在 / `trim` / 边界 60 接受 / 61 拒绝 /
  空串与纯空白拒绝且**未误写** / 非法 ID 400 / 不存在 404 / 多余字段 400 /
  `null` 恢复默认 / **改名后排序不变**。
- **批量删除**：非法与不存在 ID 全有或全无；只删所选及其从属记录；
  未选记录与已改名记录不受影响；**库存快照前后一致**；
  引用清除后菜谱可删（204）、仍有引用则拒绝（409）；清空后库存与食材定义不变。

### 3.2 `verify-recipe-batch1.ts`（新迁移后的既有套件回归）→ **PASS=83 FAIL=0，退出码 0**

### 3.3 类型检查与构建

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit`（server） | exit 0 |
| `npx tsc --noEmit`（client） | exit 0 |
| 独立 `tsc --noEmit`（verify 脚本 + harness） | exit 0 |
| `npm run build`（client + server） | exit 0 |
| `npm run build:client`（IME 修正后复跑） | exit 0 |

### 3.4 顺带修复的既有缺陷（非本任务引入）

`server/harness/server-lifecycle.ts` 原本只有
`export { assertSafeDbPath } from '...'` —— 这**不产生本地绑定**，
而 `startServer()` 内部要**调用**它，导致**任何走 harness 的验证脚本**在运行时报：

```
ReferenceError: assertSafeDbPath is not defined
```

已改为「本地 import + re-export」，**导出面不变**。修复后既有脚本
`verify-recipe-batch1.ts` 回归通过（83/0）。

### 3.5 开发阶段真实数据库未改的证据（**迁移前**；迁移执行见 §8）

- `server/data/homechef.db`：**352256 B / 2026-10-15 00:45:44** —— 开发全程**未变**。
- `server/data/` 文件数：**1823 → 1823**。
- **未执行** `db:migrate`；**未**以 `HOME_CHEF_ALLOW_REAL_DB=1` 运行过任何命令。
- 临时目录残留 **0**；63000–64999 端口监听 **0**。

---

## 4. 浏览器验收（由大白龙在独立虚构数据库上执行）

**已通过**：

- 时间倒序
- 自定义名称显示
- 单选 / 全选 / 取消全选 / 半选
- 铅笔行内编辑
- 空白名称拦截
- Enter 保存 / Esc 取消
- 删除确认及取消

> 本轮新增的**输入法组合让路**逻辑（§1.4 最后一条）**尚未在浏览器用真实
> 中文输入法验证** —— 需要带 IME 的手工测试。

---

## 5. 尚未执行

1. ~~**真实数据库迁移 0011**~~ —— **已于 2026-10-15 21:41 执行并验证通过，见 §8。**
2. 未提交、未推送、未打标签。
3. 未实现归档箱 / 恢复 / 删除菜谱时级联清理历史（按需求明确不做）。
4. 未做并发删除同一批的竞态测试（单用户本地应用，风险低）。
5. 列表无分页与筛选（因此「全选仅限当前页」当前等价于全量）。

---

## 6. 改名功能上线待办（**已于 2026-10-15 执行，实际结果见 §8**）

> 以下是**预定**的上线步骤；实际执行过程、备份与验证结果记录在 **§8**。

### 6.1 前置核对（必须先做）

1. 确认真实库 `__drizzle_migrations` 已应用 **11** 条，
   且**唯一待应用的就是 `0011_cooking_session_name`**（不多不少）。
2. 确认代码与迁移文件版本一致：
   `0011_cooking_session_name.sql` 存在，且 `_journal.json` 含 idx 11。

### 6.2 备份（必须先做）

- **先停掉后端**，再备份 `server/data/homechef.db` **及** `-wal`、`-shm`
  （WAL 模式下直接热拷贝可能不一致）。
- 或生成一致性副本：`VACUUM INTO 'D:\HomeChef\server\data\homechef.db.bak-<日期>-v0211'`。
- 记录备份文件名与 **SHA-256**，并确认**备份与当前代码版本匹配**。

### 6.3 应用迁移（**两个环境变量都必须设置**）

```powershell
cd D:\HomeChef\server
$env:HOME_CHEF_DB_PATH = "D:\HomeChef\server\data\homechef.db"   # 必须是**绝对路径**
$env:HOME_CHEF_ALLOW_REAL_DB = "1"                                # 只放行「路径恰为该库」
npm run db:migrate
```

> ⚠️ **更正上一版说明**：**只设置 `HOME_CHEF_ALLOW_REAL_DB=1` 会直接以退出码 1 失败。**
> `migrate.ts` 在 `HOME_CHEF_DB_PATH` **未设置或为空白**时**拒绝执行**
> （因为未设置时会回退到真实库，存在误迁移风险）。
> 因此**两个变量必须同时给出**，且 `HOME_CHEF_DB_PATH` 必须是**绝对路径**。

### 6.4 回退（**未实测，不得声称可直接执行**）

- **推荐做法**：用 §6.2 的**一致性备份整体回退**；回退后代码版本必须与备份匹配。
- ⚠️ **不要把**「`DROP COLUMN` + 删除 journal 条目」当作简单回滚，因为：
  - 它还牵涉 `__drizzle_migrations` **已应用迁移账本**的一致性；
  - 会**不可逆地丢弃**已保存的自定义名称。
- 该路径**本仓库未实测**，因此**不宣称可直接执行**；如确需评估，
  应先导出 `select id, name from cooking_session where name is not null`。

---

## 7. 给下一个会话的一句话

> v0.2.1.1 代码与隔离验证已完成（65 + 83 全绿）；**真实库 0011 已于 2026-10-15 21:41 应用并验证通过**；
> **后端已于 21:44 受控重启加载新代码（PID 36996），功能已启用**。详见 §8。

---

## 8. 真实库上线执行记录（2026-10-15 21:41 Asia/Shanghai）

> 用户明确授权范围：**仅限「对真实库做一致性备份 + 应用新增列迁移 0011」**，不含任何其他数据改动。

### 8.1 迁移前只读核对（全部通过）

| 项 | 结果 |
|---|---|
| Git | 分支 `main`，HEAD `e6c7521`；本轮未提交改动全部保留 |
| 真实库 | `D:\HomeChef\server\data\homechef.db`，**352256 B**，mtime `2026-10-15 00:45:44` |
| `integrity_check` / 外键 | **`ok`** / 违规 **0** |
| `cooking_session` 列 | **不含 `name`** —— 无 schema 漂移 |
| 迁移账本 | **11 条**，与 `_journal.json` 前 11 条 `when` 一一对应，**无多余记录** |
| **唯一待应用** | **`0011_cooking_session_name`**（且**仅此一个**） |
| 0011 内容 | 去掉注释后**仅一条**语句：<br>`ALTER TABLE \`cooking_session\` ADD COLUMN \`name\` text;` |
| 会话状态 | 仅 `settled`(4) + `abandoned`(1)，**无进行中的烹饪 / 结算动作** |

未发现额外待迁移、schema 漂移、同名列或数据完整性问题，**无需停止报告**。

### 8.2 一致性备份

- **方式**：`better-sqlite3` **在线备份 API**（`db.backup()`）—— 不是「只拷主文件」，
  对活跃 WAL 库安全。
- **路径**：`D:\HomeChef\server\data\homechef.db.bak-20261015-v0211-pre0011`
- **大小**：352256 B
- **SHA-256**：`a55df954798752fac556d2569623f67cfe48b4c3600076a407cc93014172d40e`
- **备份校验**：`integrity_check = ok`、外键违规 **0**、
  **14 张表的行数与内容 SHA-256 与当时的真实库逐一相同**、
  且备份中 **不含 `name` 列**（确为迁移前状态）。
- 该文件为**新建**（执行前不存在）；**未覆盖任何旧备份**，执行前后**未删除任何备份或数据库文件**。
- 备份与校验过程顺带生成 `-shm`（32768 B）与 `-wal`（0 B）辅助文件，**已保留**。

### 8.3 「备份 → 迁移」之间无业务写入的保证

1. **排他写锁探测**（不是「读一下行数」）：
   对真实库执行 `BEGIN IMMEDIATE`，**3 ms 即取得写锁** ——
   若存在其他写者会 `BUSY` 或等待；随后 `ROLLBACK`。
   探测前后主库 / `-wal` / `-shm` 的 size 与 mtime **完全一致**，探测本身零改动。
2. 库处于空闲：最后一次业务写入为 `cooking_settlement.settled_at` 最大值
   **2026-10-15 16:52:41 (+08:00)**，距迁移约 4 小时 49 分。
3. **窗口无写入的最终证明**：迁移后用**迁移前的列列表**逐表比对内容 SHA-256，
   **14 张表全部一致**（见 §8.5）—— 即「备份之后 → 迁移完成」整个区间内
   **没有任何业务写入**。
4. **服务未被停止**：真实后端一直在运行（PID 7212，监听 `127.0.0.1:3002`）。
   该进程链的顶层父进程已退出（孤儿链），若停服未必能复现原 `PORT=3002` 参数，
   故采用**排他锁路径**而非停服；因此**无需恢复服务**。

### 8.4 迁移执行（使用项目既有工具）

```powershell
cd D:\HomeChef\server
$env:HOME_CHEF_DB_PATH = "D:\HomeChef\server\data\homechef.db"   # 必须是绝对路径
$env:HOME_CHEF_ALLOW_REAL_DB = "1"
npm run db:migrate
```

- 退出码 **0**，输出 `migration 执行完成。`
- 两个环境变量**仅存在于该子进程**：未做任何全局/持久化设置，**未修改保护代码**。
- **未运行** `seed` / 重建 / 清库 / 任何无关迁移。
- ⚠️ WAL 模式下**主库文件本身未变**（仍 352256 B、mtime 不变），
  变更落在 `-wal`（968232 → **984712** B，21:41:34）。
  迁移已提交，**只读连接即可见新列**。

### 8.5 迁移后验证（全部通过）

| 检查 | 结果 |
|---|---|
| `PRAGMA integrity_check` | **`ok`** |
| `PRAGMA foreign_key_check` | 违规 **0** |
| 新列 | `name` —— **TEXT / notnull = 0**（可空），无默认值 |
| 旧记录名称 | **5 / 5 全部为 `NULL`**（迁移**未回填**） |
| 14 张表内容 | 行数与 SHA-256 **与迁移前逐一相同**：<br>`cooking_session` 5、`cooking_session_dish` 6、`cooking_settlement` 4、`cooking_settlement_item` 10、`cooking_session_dish_skip` 0、`recipe` 7、`recipe_ingredient` 14、`recipe_step` 4、`ingredient_definition` 229、`ingredient_alias` 144、`ingredient_definition_unit` 667、`standard_ingredient` 7、`category` 19、`app_settings` 1 |
| 迁移账本 | **12 条**：旧 11 条哈希**不变**；**仅新增 1 条** `created_at=1791840000000`（hash `75c104879d9e`） |

### 8.6 迁移时的服务状态（当时**未**停服）

- 迁移当时**未停服，故无需恢复**。只读复核：`GET /health → 200 {"status":"ok"}`
- 当时运行的实例是**迁移前的旧代码**（启动于 2026-10-15 00:46），
  其响应**不含 `name` 字段** —— 属预期：`ADD COLUMN` 向后兼容，旧代码继续正常工作。
- 该状态已于 21:44 通过**受控重启**结束，见 §8.8。
- 未对真实记录执行**任何**删除 / 改名 / 新建 / 结算测试。

### 8.7 回滚

- 首选：使用 §8.2 的一致性备份**整体回退**（该备份与迁移前的代码版本匹配）。
- **本次未执行任何回滚**，未删除、未覆盖任何文件。
- ⚠️ 不建议把 `DROP COLUMN` 作为简单回滚：还牵涉迁移账本一致性，
  且会不可逆丢弃日后的自定义名称。

### 8.8 受控重启与新代码启用（2026-10-15 21:44）

#### 旧实例识别（行动前逐个核对命令行，未误杀无关进程）

```
13804  node  npx-cli.js tsx src/server.ts        （父进程 28376 已退出）
  └─ 34884  cmd.exe /d /s /c tsx src/server.ts
       └─ 9792  node  .../tsx/dist/cli.mjs src/server.ts
            └─ 7212  node --require preflight.cjs --import loader.mjs src/server.ts
                                                    ← 监听 127.0.0.1:3002
```

- **判定无监督 / 无自动重生机制**：命令**不含 `watch`**；根祖辈 28376 已退出。
  实测停止 7212 后，9792 / 34884 / 13804 **随之自动退出**，端口**立即释放**、无残留 —— 证实无监督进程。
- 端口 **3001 归属 QQ Agent**（`E:\QQ Agent\...\snowluma\node.exe`），**未触碰**。
- 停服前再次确认**无进行中烹饪 / 结算**：非终态会话 **0** 条（仅 `settled`×4 + `abandoned`×1）。

#### 启动命令（与旧实例逐字一致；环境变量仅作用于该子进程并随即清除）

```powershell
$env:PORT = "3002"
$env:HOME_CHEF_DB_PATH = "D:\HomeChef\server\data\homechef.db"
Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
  -ArgumentList @("--require","D:\HomeChef\node_modules\tsx\dist\preflight.cjs",
                  "--import","file:///D:/HomeChef/node_modules/tsx/dist/loader.mjs",
                  "src/server.ts") `
  -WorkingDirectory "D:\HomeChef\server" `
  -WindowStyle Hidden `
  -RedirectStandardOutput <log> -RedirectStandardError <log>.err
```

| 项 | 值 |
|---|---|
| **新 PID** | **36996** |
| 端口 / 地址 | **127.0.0.1:3002** |
| cwd | `D:\HomeChef\server` |
| 日志 | `%TEMP%\hc-backend-3002-20261015-214443.log`（另有同名 `.err`） |
| **未改动** | 系统配置、环境变量持久化、启动脚本、保护代码 |

#### 只读验收（全部通过）

| 检查 | 结果 |
|---|---|
| `GET /health` | **200** `{"status":"ok"}` |
| `GET /api/cooking/sessions` | **200**，**5 条**，字段：`id, status, name, recipe_revision, started_at, dish_count, created_at, updated_at` —— **含 `name`** |
| 旧记录名称 | **5 / 5 全为 `null`** |
| 排序 | `started_at DESC, id DESC` —— 实测 **5, 4, 3, 2, 1**，正确 |
| `PATCH /api/cooking/sessions/:id/name` 已注册 | `999999 → 404`；`0 → 400`；类型错误 → 400；空串 → 400；纯空白 → 400；多余字段 → 400（**全部零写入**） |
| 14 张表业务内容 | 与迁移前快照**逐一一致**（`allBusinessDataUnchanged = true`） |
| `integrity_check` / 外键 | `ok` / 违规 **0** |
| 迁移账本 | **12 条**，最后 `created_at = 1791840000000` |

**未执行**：任何真实记录的**改名 / 删除 / 新建 / 结算**测试。

> ✅ **结论：v0.2.1.1 已启用 —— 真实库已含 `name` 列，后端 PID 36996 运行新代码，`name` 字段与改名路由均已生效，业务数据保持不变。**
