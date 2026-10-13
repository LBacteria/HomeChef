# HomeChef —— B1b 会话交接文档

> 生成时间：**2026-10-13 18:28（Asia/Shanghai）**
> 生成方式：全部状态由**只读命令实测**，非沿用旧报告。
> 本文件是**新会话继续工作的唯一依据**，不依赖任何聊天历史。
>
> **本轮只创建了本文件，未修改任何源码、测试脚本、配置或其他文档。**
>
> ---
>
> **✅ 2026-10-13 最终更新：B1b 已按原定范围正式验收通过**
>
> 本文件生成于 B1b 中段，此后 B1b 又推进了三个阶段（4 个 recipe 脚本与
> `verify-phase3-search.ts` 新增 `HOME_CHEF_TEST_DB_DIR` 隔离入口，并各在独立
> `%TEMP%` 目录中实际运行通过）。因此本文件 §3.2、§4、§6.4 中
> "未动态验证 / 最大障碍 / 剩余 12 个脚本"等描述**已不再反映当前状态**。
>
> **B1b 的验收结论见 §1.1；当前权威记录请看 `docs/DEVELOPMENT_LOG.md` 与
> `docs/dev-notes/B1b-harness-lifecycle.md` §7。**
>
> **已验收 ≠ 已提交或已推送**：改动仍全部处于未暂存状态。
> V1（完整孙子进程树清理）与 V5（脚本端到端失败注入）**尚未验证**，
> 且**不得**声称"所有失败路径均已端到端验证"。

---

## 1. 项目基本信息

| 项 | 内容 |
|---|---|
| 项目名 | **HomeChef** —— 本地单用户的家庭食材库存 + 菜谱管理 Web 应用 |
| 本地路径 | `D:\HomeChef` |
| GitHub | `https://github.com/LBacteria/HomeChef.git` |
| 技术栈 | 前端 React 18 + TS + Vite 6（npm workspace `client`）；后端 Node + TS + Fastify 5 + SQLite（better-sqlite3）+ Drizzle ORM（`server`） |
| 当前版本 | `0.2.0`（已于 `96fff9c` 打附注标签 `v0.2.0`） |
| 当前阶段 | **B1b 已验收通过**（2026-10-13）。工作区仍有 5 个**未暂存**的源码修改，**尚未 commit / push** |
| 工作方式 | **分批实施、逐批验收、未经用户明确批准不得进入下一批**。每批先只读核验基线 → 实施 → 验证 → 报告 → 等批准 |

**B1b 的目标**：修复 verify 脚本用
`spawn('npx', ['tsx', 'src/server.ts'], { shell: true })` 启动测试服务导致的**子进程残留**，
统一接入公共生命周期机制（`startServer` / `waitForReady` / `stop`），
并补齐异常路径下的进程清理。

---

## 1.1 B1b 验收结论（2026-10-13）

**✅ B1b 按原定范围正式验收通过。**

**验收依据**（均为已有记录，验收时**未重新运行测试**）：

- 五个脚本与公共 harness 的**静态只读核查**（5/5 接入 harness、无旧式服务 `spawn`、断言零改动）；
- 五个脚本第二阶段的 **358 条断言**全部通过（`PASS` 39/83/103/106/27，`FAIL` 全 0，退出码全 0）；
- **R3 隔离测试 D1–D7**（启动失败、就绪超时、exit 钩子、异常清理、幂等停止、路径守卫）；
- 五文件**合并 TypeScript 检查**：退出码 0、无诊断信息；
- 运行前后的**保护范围核对**：`server/data/` 计数与哈希、`homechef.db`、备份 SHA-256 均未变。

详见 `docs/dev-notes/B1b-harness-lifecycle.md` §7 与 `docs/DEVELOPMENT_LOG.md`。

**⚠️ 已验收 ≠ 已提交或已推送。** 上述改动**仍全部处于未暂存状态**，未 `git add`、未 commit、未 push。

**验收时明确保留的已知限制**（**不因本次通过而视为已解决**）：

- **R3 的结论范围**：限于「控制流核对」与「公共机制层动态验证（D1–D7）」，
  **不**等价于脚本端到端失败路径验证。
- **V1**：exit 钩子对**完整孙子进程树**的清理能力**尚未验证**（D4 仅覆盖单层进程）。
- **V5**：**完整脚本端到端失败注入尚未验证**。
- **不得声称"所有失败路径均已端到端验证"**——该表述与现有证据不符。

**明确属于后续工作、不因本次通过而解决的事项**：

- 剩余 **19 个**旧验证脚本仍用 `npx + shell:true` 启动服务，仍可能生成孤儿进程并把测试库写入 `server/data/`；
- `seed` 子进程的 `shell: true` 与 `DEP0190` 警告；
- `verify-phase3-search.ts` 的端口区间与 Steam **27036** 重叠、以及端口预检不校验 HTTP 状态码；
- 无统一的验证脚本回归入口；
- 真实外部 Ctrl+C 未验证。

---

## 2. 当前 Git 状态（2026-10-13 18:28 实测）

```
分支        : main
HEAD        : 96fff9cbc3c61bf5dd501f3a6d0dbca60affe974
origin/main : 96fff9cbc3c61bf5dd501f3a6d0dbca60affe974
领先/落后   : 0 / 0   （完全同步）
暂存区      : 0 个
未暂存      : 5 个
```

### 未暂存的 5 个改动（全部属 B1b）

| 文件 | diff 规模 | 归属 |
|---|---|---|
| `server/verify-phase3-search.ts` | `48 ++++---` | **阶段 1**（代表脚本改造） |
| `server/verify-recipe-batch1.ts` | `57 ++++++---` | **阶段 2 第一批** |
| `server/verify-recipe-batch2.ts` | `65 ++++++----` | **阶段 2 第一批** |
| `server/verify-recipe-batch3.ts` | `63 ++++++----` | **阶段 2 第一批** |
| `server/verify-recipe-transaction-rollback.ts` | `179 ++++++++++++++-------------` | **阶段 2 第一批** |

合计（**2026-10-13 实测更新**）：`5 files changed, 239 insertions(+), 173 deletions(-)`

> `diff 规模` 一列取自 `git diff --stat`：数字为**变更行数**（新增 + 删除），
> 其后 `+` / `-` 为该命令生成的条形串。
> 逐文件 `--numstat`（新增/删除）实为：
> phase3 `29/19`、batch1 `38/19`、batch2 `39/26`、batch3 `40/23`、tx `93/86`；
> 合计 `239/173`，与本节合计行一致。

> 2026-10-13 更正：原文记的 `208 insertions(+), 167 deletions(-)` 是本文件生成时
> （18:28）的快照。此后 batch1–3 与 `verify-phase3-search.ts` 追加了临时库路径隔离代码，
> 故当前实测为 `239 / 173`。**这 5 个改动仍全部处于未暂存状态，未 commit、未 push。**

### 未跟踪（18 个）

> 2026-10-13 更正：原文写 15 个（漏算本文件自身），后改为 16 个，
> 但当时 `docs/` 尚未展开。按 `git ls-files --others --exclude-standard`
> 的只读实测，**当前为 18 条**。

口径构成（三类、无遗漏，已逐条核对）：

- **文档文件 3 个**：
  - `HANDOFF_B1B.md`（本文件）
  - `docs/DEVELOPMENT_LOG.md`
  - `docs/dev-notes/B1b-harness-lifecycle.md`
- **公共生命周期模块 1 个**：`server/harness/server-lifecycle.ts`（537 行）
- **受保护的 14 个诊断脚本**（见 §5.2 清单）

合计 `3 + 1 + 14 = 18`。

### 提交 / 推送状态

- **未 `git add`、未 commit、未 push、未打 tag**。
- **无任何未完成的 Git 操作**（无 rebase/merge/cherry-pick 中间态）。

---

## 3. B1b 实施进度

> 证据等级标注：
> **【已实测】**＝本轮或本会话中被实际运行验证过；
> **【仅静态】**＝只做了读码 / 类型检查，未运行；
> **【待核实】**＝来自此前报告但本轮未复验。

### 3.1 阶段 1：公共 harness + 代表脚本 —— **已完成**

**新增文件**：`server/harness/server-lifecycle.ts`（537 行）

提供：
- `resolveTsxHooks()` —— 通过 `require.resolve('tsx')` **动态解析** `preflight.cjs` / `loader.mjs`，不硬编码路径。
- `assertSafeDbPath(rawPath, serverRoot)` —— 拒绝空串/纯空白；规范化（含软链接解析、Windows 大小写）后拒绝指向真实库 `server/data/homechef.db`（及 `-wal`/`-shm`）；**在 spawn 之前**抛错。
- `startServer(opts)` —— 用 **`process.execPath` 直接启动 Node**
  （`node --require <tsx>/preflight.cjs --import <tsx>/loader.mjs src/server.ts`），
  **不使用 `shell: true`**；监听 `error` 事件；捕获 stdout/stderr（有 200KB 上限）。
- `waitForReady(opts)` —— **绝对超时**；每次 `fetch` 用 `AbortSignal.timeout`；能区分「spawn 失败 / 服务提前退出 / 就绪超时」。
- `handle.stop()` —— **幂等**；温和 kill → `SIGKILL` → 限定自身 PID 的 `taskkill /T`。
- `installSignalHandlers()` —— SIGINT/SIGTERM 处理器：`handling` 标志防并发，`await stopAll()` **完成后**才 `process.exit(130/143)`。
- `process.on('exit')` **同步**兜底（不做异步清理）。

**代表脚本**：`server/verify-phase3-search.ts` 已改造（`startServer` + `waitForReady` + `try/finally { await server.stop() }`）。

**阶段 1 的验证结果【已实测】**：

| 场景 | 结果 |
|---|---|
| 直接启动（无 shell）进程层级 | **1 层**（`npx-cli: 0`、`cmd.exe: 0`），原为 4 层 |
| 正常启动 / 就绪 / 停止 | ✅ 端口释放、无残留 |
| spawn 失败（无效可执行文件） | ✅ 306ms 即报错（不白等超时）、无残留 |
| 就绪超时 | ✅ 4000ms 阈值 → 3731ms 结束、无残留 |
| 断言失败 → `finally` 清理 | ✅ |
| 父脚本异常退出 | ✅ 服务被 exit 钩子清理 |
| 连续 / 并发 `stop()` | ✅ 幂等、无重复杀进程 |
| dbPath 安全校验（8 例） | ✅ 8/8 通过 |
| SIGINT / SIGTERM 退出码 | ✅ **130 / 143**（同进程合成事件路径，`EXIT_HOOK code=130/143` 直接可见） |
| 重复信号 | ✅ `EXIT_HOOK` 仅 1 次，退出码未被第二次覆盖 |

**已知限制 / 需留意**：
- **Windows 上从其他进程 `child.kill('SIGINT')` 不会触发目标进程的信号处理器**，而是直接终止（Node 平台行为）。因此**外部信号**路径无法用来验证处理器退出码；退出码是通过**同进程内 `process.emit('SIGINT','SIGINT')`**（必须带信号名参数）验证的。
- `startServer` 额外提供 `entryFile` / `execPath` 两个可选参数，**仅供负向测试**使用。
- harness 的 `StartServerOptions` **没有 `env` 字段**（见 §4 待办 2）。

### 3.2 阶段 2 第一批：4 个缺 `finally` 的脚本 —— **已完成改造，并已动态验证**（见 §1.1 验收结论）

| 文件 | 改造内容 | 类型检查 |
|---|---|---|
| `server/verify-recipe-batch1.ts` | `startServer` + `waitForReady`（30s）+ 新增 `try/finally`；原 `stdio:'ignore'` → `'pipe'` | **EXIT=0**【已实测】 |
| `server/verify-recipe-batch2.ts` | 同上；自建 `serverLog` 改为 harness 的 `stderr()`/`output()`，**保留原诊断输出** | **EXIT=0**【已实测】 |
| `server/verify-recipe-batch3.ts` | 同上；**保留结尾的临时库 `rmSync`** | **EXIT=0**【已实测】 |
| `server/verify-recipe-transaction-rollback.ts` | **3 个服务**（`server1/2/3`）顺序启停；`server2/3` 提升到顶层；3 个 `waitFor*` → `waitForReady`；末尾**统一幂等清理**（`server3?.stop()` → `server2?.stop()` → `server1.stop()`） | **EXIT=0**【已实测】 |

**业务断言零改动**【已实测】：4 个脚本的 diff 中，新增行含 `ok(`/`info(` = **0**，删除行含 `ok(`/`info(` = **0**。

**~~未进行动态验证的原因（阻塞项）~~ —— 已于 B1b 后续批次解除**（2026-10-13 更新）：
> 原阻塞原因：这 4 个脚本的临时库路径**硬编码**为
> `resolve(process.cwd(), 'data', '<prefix>-<Date.now()>.db')`，
> 即**必然在 `server/data/` 下创建文件**。
> （更准确的表述：脚本内部自己拼 `dbPath` 并作为 `HOME_CHEF_DB_PATH` 传给子进程，
> 所以从外部再设 `HOME_CHEF_DB_PATH` 无效——这是**脚本写死了 `process.cwd()/data/`**，
> 而不是服务端不支持该变量。）
>
> **解除方式**：为 4 个脚本新增 `HOME_CHEF_TEST_DB_DIR` 隔离入口，
> 未设置时回退 `data/`（行为不变），设置时全部临时库改写到 `%TEMP%` 隔离目录。
> 4 个脚本随后**各在独立 `%TEMP%` 目录中动态运行通过**：
> batch1 `PASS=83/FAIL=0`、batch2 `PASS=103/FAIL=0`、batch3 `PASS=106/FAIL=0`、
> transaction-rollback `PASS=27/FAIL=0`，退出码均为 0，受保护区域核对未变。
> 详见 `docs/dev-notes/B1b-harness-lifecycle.md`。

**残留进程 / 端口**【已实测】：真实服务进程 **0**，4 脚本端口区间（63000–65499）监听 **0**。
（注意：这是"**未运行**"的必然结果，**不能**作为"清理有效"的证据。）
> 2026-10-13 更新：4 个脚本已各自实际运行一次，运行后**端口区间监听数仍为 0**、
> **无 HomeChef 相关残留进程**——此时该观测才构成"清理有效"的证据。

### 3.3 信息分级汇总

| 类别 | 内容 |
|---|---|
| **【已实测】本轮/本会话验证过** | Git 状态；5 个文件的 diff 规模与类型检查 EXIT=0；业务断言零改动（ok/info 计数）；阶段 1 的 10 项场景测试；数据库/备份/遗留文件未变；受保护脚本 14/14 |
| **【仅静态】只读码/类型检查，未运行** | 阶段 2 第一批 4 个脚本的**运行时行为**、`finally` 在真实失败路径的清理效果、3 服务顺序启停语义 |
| **【待核实】此前报告、本轮未复验** | 阶段 1 中 SIGINT/SIGTERM 的退出码诊断细节（本会话实测过，但**未在本轮重新跑**）；B1b 之前清理过的「17 组 / 68 个孤儿进程」的具体数字 |
| **【未验证】** | 阶段 2 第二~四批（剩余 12 个脚本）**完全未开始**；harness 在真实 Ctrl+C 场景下的表现 |
| **【待决策】** | 是否给 harness 加可选 `env`；是否做「临时库路径可注入」改造；是否继续剩余 12 个脚本 |

---

## 4. 关键待办事项（**本轮未执行，需用户批准**）

> **✅ 2026-10-13 状态更新（验收后）**：
>
> - 下文的 **1（临时库路径可注入）** 已实施：5 个脚本均新增 `HOME_CHEF_TEST_DB_DIR` 入口，
>   并已在隔离目录中动态验证通过（见 §1.1）。
> - 下文的 **3（动态验证第一批 4 个脚本）** 已完成。
> - 下文的 **2（harness 增加可选 `env`）**、**4/5（其余脚本、回归入口等）**
>   **仍属后续独立工作，本次验收未覆盖、未解决**。
> - 因此本节其余条目保留原样，仅作历史上下文；**后续事项清单以 §1.1 末段与
>   `docs/dev-notes/B1b-harness-lifecycle.md` §6 为准。**

1. **设计不会触碰 `server/data/` 的安全动态验证方案。**
   目标：让 4 个（及后续）脚本能在 `%TEMP%` 的 GUID 专属目录中运行。
   思路候选：为脚本的 `dbPath` 增加**可注入前缀**（如读取 `HOME_CHEF_TEST_DB_DIR`，缺省回退 `data/`），
   或由测试驱动以 `HOME_CHEF_DB_PATH` 覆盖（**当前脚本内部写死，此路不通**）。
   **必须先汇报方案与副作用，等批准。**

2. **评估是否为公共 harness 增加可选 `env` 参数。**
   现状：`transaction-rollback` 需要注入 `HOME_CHEF_FAULT_INJECT`，但 `StartServerOptions` 无 `env` 入口，
   脚本内只能用**临时改写 `process.env`** 的变通做法（`startServerWithEnv()`）——
   依赖 harness 内部 `{ ...process.env }` 的实现细节，属**隐式耦合**，且并发启动不同 env 的服务会互相污染。
   建议：加 `env?: Record<string,string>`（与 `process.env` 合并）。**属范围外，需批准。**

3. **动态验证第一批 4 个脚本**，覆盖：三个服务的顺序启停、正常结束、失败路径清理。

4. **第一批验收通过后**，再由用户决定是否继续**剩余 12 个脚本**（第二批起）。

5. **任何动态验证方案在实施前**必须先汇报「涉及哪些文件、可能产生哪些副作用、如何避免触碰 `server/data/`」，**等批准**。

---

## 5. 必须保留的保护规则（**违反即失败**）

### 5.1 Git 操作

- ❌ 禁止 `git add .`、`git add -A`、`git reset --hard`、force push。
- ❌ **不得擅自 commit 或 push**。
- ✅ 允许只读：`git status`、`git diff`、`git log`、`git rev-parse`、`git show`。

### 5.2 受保护的 14 个未跟踪诊断脚本（**保持原样：不得修改、删除、移动、暂存或提交**）

1. `server/_backup-db.ts`
2. `server/_backup-prerebuild.ts`
3. `server/_crosscheck-migration.ts`
4. `server/_readonly-migration-check.ts`
5. `server/_rebuild-cleanup.ts`
6. `server/_verify-rebuild.ts`
7. `server/_inspect-seed-tables.ts`
8. `server/_release-facts.ts`
9. `server/_diag-500.ts`
10. `server/seed/_analyze-data.ts`
11. `server/seed/_audit-shelf.ts`
12. `server/seed/_audit-units.ts`
13. `server/seed/_list-aliases.ts`
14. `server/seed/_verify-alias-update.ts`

> 交接时实测：**14/14 存在且未被改动**。

### 5.3 其他受保护文件

- ❌ 不得修改 `TECH_STACK.md`。
- ❌ 不得修改 `client/src/components/SortControls.tsx`。
- ❌ 不得触碰**数据库、备份、WAL/SHM、日志**，以及 `server/data/` 中的**任何历史文件**。
- ❌ 不得擅自执行**迁移、重建、恢复、重置或清理**。
- ❌ 不得运行全量 verify 回归套件。

### 5.4 三个历史遗留文件（**不得擅自处理**）

> 2026-10-13 补充：这三者只是 `v011-p3-*` 遗留的**一组**。实测该前缀在
> `server/data/` 中共 **96 个**文件（34 个 `.db` + 31 个 `-shm` + 31 个 `-wal`，
> 时间跨度 2026-10-05 ~ 2026-10-12），**全部保持原样**。
> 产生它们的 `verify-phase3-search.ts` 已于 B1b 收尾批次加上路径隔离入口，
> 之后不再新增；**已有遗留未被清理**（用户明确要求保留）。

```
server/data/v011-p3-1791806323565.db       155648 B  2026-10-12 19:58:45
server/data/v011-p3-1791806323565.db-shm    32768 B  2026-10-12 19:58:46
server/data/v011-p3-1791806323565.db-wal   206032 B  2026-10-12 19:58:46
```
这是阶段 1 运行 `verify-phase3-search.ts` 时产生的遗留，**用户明确要求保持原样**。

### 5.5 有效数据库备份

- 路径：`D:\HomeChef\server\data\homechef.db.bak-20261011-full`
- **SHA-256**：`224412c2772d7dba8e88cf346d8984a138b4985985a847f465cd11ea4e1bd127`
- 交接时实测：**匹配** ✅
- ⚠️ 较旧的 `homechef.db.bak-20261011` **不完整**，**不得**作为回滚依据。

### 5.6 目录与权限

- `server/data/` 当前 **1823 个文件**（含 **450** 个 `.db`，原文误记为 449）；`homechef.db` 为 `233472 B / 2026-10-10 13:34:42`（**未变**）。
- **任何新的测试方案必须先确认：是否会写入或删除受保护区域中的文件。**
- 当前 DSH 会话为 **`danger-full-access`** 模式，权限较广，**执行前必须核对操作范围**；
  **不得**擅自修改 ACL、提权、关闭沙箱或关闭安全软件。
- 建议：动态测试一律在 `%TEMP%\hc-b1b-<GUID>\` 下进行，且**删除前先用规范化绝对路径校验目标确实位于该测试根目录内**；校验失败立即终止。

---

## 6. 相关技术背景（只保留后续工作必需的部分）

1. **为什么必须修**
   `spawn('npx', ['tsx','src/server.ts'], { shell: true })` 在 Windows 下会插入 `cmd.exe`：
   `npx-cli(L1) → cmd.exe(L2) → tsx cli(L3) → node(preflight)(L4)`。
   脚本持有的 `proc` 指向 **L1**，`proc.kill()` **只杀 L1**，L2–L4 逃逸成孤儿。
   **曾经实测残留 17 组 × 4 层 = 68 个孤儿进程**（每组 L1 父进程已死、孙子进程仍在监听高位端口）。

2. **现在 harness 的做法**
   直接用 `process.execPath` 启动 Node，经 tsx 的 `preflight.cjs`/`loader.mjs` 加载 TS 入口，
   **进程层级 1 层**，`proc.pid` 即真实服务进程；配合就绪等待（绝对超时）、幂等停止、信号处理与 exit 同步兜底。

3. **`transaction-rollback` 的特殊性**
   它有**三个服务**轮换启动，且依赖 `HOME_CHEF_FAULT_INJECT` 环境变量（故障注入点 `recipe_full_save_after_links`）
   来验证「事务中途失败 → 整体回滚」。因此它需要**按次注入额外 env**，这正是 §4 待办 2 的由来。

4. **临时库路径隔离是当前动态验证的最大障碍**
   `verify-*.ts` 普遍把库建在 `server/data/<prefix>-<Date.now()>.db`；
   而 `server/data/` 属受保护区，导致**难以在不写受保护区的前提下运行它们**。

---

## 7. 新会话第一步（**请严格按顺序执行**）

1. **先读本文件** `D:\HomeChef\HANDOFF_B1B.md`（即本文）。

2. **只读核验**：
   - `git rev-parse HEAD` / `git status --short` / `git ls-files --others --exclude-standard`
   - 对照 §2，确认 5 个未暂存改动仍在、`server/harness/server-lifecycle.ts` 仍在、
     未跟踪计数与 `git ls-files --others --exclude-standard` 的实际输出一致
     （§2 已更正为 **18**：3 个文档 + 1 个公共 harness + 14 个受保护脚本；
     该数字会随文档增减而变化，**以实测为准，不要照抄本文数字**）。
   - 确认 14 个受保护脚本仍为 14/14，`TECH_STACK.md` 与 `SortControls.tsx` 未被改动。
   - 确认数据库/备份/3 个遗留文件状态未变（对照 §5.4 / §5.5）。
   - **若与本文件描述不符 → 停止，先报告差异，不要覆盖或重置任何内容。**

3. **不要重新实施已完成的改动**（阶段 1 与阶段 2 第一批见 §3）——它们已在工作区，不需要重做。

4. **不要直接开始剩余 12 个脚本**（阶段 2 后续批次），未获批准不得继续。

5. **先提出安全的动态验证方案**，必须说明：
   - 会涉及哪些文件（读 / 写）；
   - 可能产生哪些副作用；
   - **如何避免触碰 `server/data/`**（含 `%TEMP%` 专属目录、GUID、删除前的规范化路径校验）；
   - 如果方案需要修改脚本的路径逻辑或给 harness 加 `env`，**明确标注为「需批准的范围扩展」**。

6. **等用户明确确认后**再执行。

> **第一条要记住的事**：**未经批准不要写任何文件、不要运行任何会写盘的脚本**——
> 尤其是 `verify-*.ts`（它们默认会往 `server/data/` 建临时库）。
