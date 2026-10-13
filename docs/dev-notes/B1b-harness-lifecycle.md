# B1b 详细开发记录：verify 脚本进程生命周期修复与测试库隔离

> 记录时间：2026-10-13
> 对应总日志：[`../DEVELOPMENT_LOG.md`](../DEVELOPMENT_LOG.md)
> 基线：分支 `main`，HEAD `96fff9cbc3c61bf5dd501f3a6d0dbca60affe974`（tag `v0.2.0`）
>
> **状态：✅ 已验收通过（2026-10-13，按原定范围）。** 验收结论与保留的限制见 §7。
> **已验收 ≠ 已提交或已推送**：改动仍全部处于未暂存状态。

---

## 1. 批次目标与修改原因

### 1.1 问题

`server/verify-*.ts` 用
`spawn('npx', ['tsx', 'src/server.ts'], { shell: true })` 启动被测服务。
Windows 下 `shell: true` 会插入 `cmd.exe`，实际进程链为 4 层：

```
npx-cli (L1) → cmd.exe (L2) → tsx cli (L3) → node/preflight (L4)
```

脚本持有的 `proc` 指向 **L1**，`proc.kill()` 只杀 L1，L2–L4 逃逸成孤儿进程，
继续占用高位端口与临时数据库文件。

### 1.2 目标

- 服务进程层级降为 1 层，`proc.pid` 即真实服务进程。
- 就绪等待改为**绝对超时**，能区分"spawn 失败 / 服务提前退出 / 就绪超时"。
- 停止幂等；异常路径（断言失败、父脚本异常退出）也能清理。
- 测试数据库可重定向，避免写入受保护的 `server/data/`。

---

## 2. 修改文件清单

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `server/harness/server-lifecycle.ts` | **新增**（537 行） | 公共生命周期模块 |
| `server/verify-phase3-search.ts` | 修改 | 代表脚本接入 harness（**未**做路径隔离） |
| `server/verify-recipe-batch1.ts` | 修改 | 接入 harness + 路径隔离 |
| `server/verify-recipe-batch2.ts` | 修改 | 接入 harness + 路径隔离 |
| `server/verify-recipe-batch3.ts` | 修改 | 接入 harness + 路径隔离（含 legacy 分支） |
| `server/verify-recipe-transaction-rollback.ts` | 修改 | 接入 harness + 路径隔离（3 个服务） |

**未做任何 Git 暂存 / 提交 / 推送。** 上述改动全部停留在工作区。

---

## 3. 关键实现与设计选择

### 3.1 动态解析 tsx 钩子（不硬编码路径）

`resolveTsxHooks()` 通过 `require.resolve('tsx')` 定位 `preflight.cjs` 与
`loader.mjs`，再用
`node --require <preflight> --import <loader> src/server.ts` 启动。
**不使用 `shell: true`**，进程层级 = 1。

### 3.2 `assertSafeDbPath()`：spawn 之前的最后一道闸

- 拒绝空串 / 纯空白（空值会让服务回退到真实库）。
- 解析基准**必须是 `serverRoot` 而非 `process.cwd()`**：因为子进程 cwd 被设为
  `opts.cwd`，后端 `db/index.ts` 用 `resolve(process.env.HOME_CHEF_DB_PATH)`
  即基于**子进程 cwd**。基准不统一会让校验时指向 A、实际打开时指向 B。
- 规范化（含软链接解析、Windows 大小写）后拒绝指向真实库
  `server/data/homechef.db` 及其 `-wal` / `-shm`。
- 不安全时**在 spawn 之前抛错**，绝不静默回退默认库。

> ⚠️ **能力边界（重要）**：该校验**只**拒绝"恰好等于真实库"的路径，
> **不阻止**在 `server/data/` 里**新建**临时库。因此"不碰 `server/data/`"
> 是靠**脚本的路径隔离**实现的，不是靠这道校验。

### 3.3 就绪等待 `waitForReady()`

- 绝对超时（`deadline`），每次 `fetch` 用 `AbortSignal.timeout` 单独限时，
  避免单次挂起拖死整个期限。
- 三种失败可区分：① spawn 失败 ② 服务提前退出（带 stderr/stdout 尾部）
  ③ 就绪超时（带最后错误）。
- 输出缓冲有 200 KB 上限，超出后保留尾部 100 KB。

### 3.4 停止与信号处理

- `stop()` **幂等**：内部缓存 `stopPromise`，重复调用返回同一 Promise。
- 终止流程：温和 kill → `SIGKILL` → **限定自身 PID** 的 `taskkill /T`。
- `installSignalHandlers()`：SIGINT / SIGTERM 处理器带 `handling` 标志防并发，
  `await stopAll()` **完成后**才 `process.exit(130 / 143)`。
- `process.on('exit')` 只做**同步**强杀兜底（该钩子不能 await）。

### 3.5 测试库路径隔离（B1b 后四个批次新增）

四个 recipe 脚本统一新增：

```ts
const dataRoot = resolve(
  process.env.HOME_CHEF_TEST_DB_DIR || resolve(process.cwd(), 'data'),
)
```

- 未设置该变量时 `dataRoot` 与改造前**逐字符等价**，行为不变。
- 设置时全部测试库（含 batch3 的 `legacy-*` 分支）改写到隔离目录。
- 文件名规则（`recipe-b1-<ts>.db` 等）保持不变。

### 3.6 `transaction-rollback` 的故障注入

`HOME_CHEF_FAULT_INJECT` 经 `startServerWithEnv()` 临时注入 `process.env`，
由 harness 的 `{ ...process.env }` 带给子进程，**`finally` 中恢复原值**
（原本不存在则 `delete`）。全文件仅此一处 `process.env` 写入点。

> ⚠️ 这是**隐式耦合**：依赖 harness 内部 `{ ...process.env }` 的实现细节，
> 且并发启动不同 env 的服务会互相污染。本批次约定**不改公共模块**，
> 故保留此变通写法。建议后续为 `StartServerOptions` 增加可选 `env` 字段。

---

## 4. 实际执行的测试命令与结果

所有运行均在 `D:\HomeChef\server` 下执行，动态运行时显式设置
`$env:HOME_CHEF_TEST_DB_DIR = <本次随机 %TEMP% 目录>`。

### 4.1 静态：独立类型检查（4 个脚本 + 1 个代表脚本）

```powershell
npx tsc --noEmit --target ES2022 --lib ES2022 --module NodeNext `
  --moduleResolution NodeNext --types node --strict --esModuleInterop `
  --forceConsistentCasingInFileNames --resolveJsonModule --skipLibCheck <file>
```

结果：**EXIT=0，无输出**（4 个脚本各自独立通过）。

### 4.2 动态：实际运行结果

| 脚本 | 命令 | 结果 | 退出码 | 隔离目录 |
| --- | --- | --- | --- | --- |
| `verify-recipe-batch1.ts` | `npx tsx verify-recipe-batch1.ts` | `PASS=83 FAIL=0` | 0 | `%TEMP%\hc-b1b-1992cb62-b230-4891-80bd-b6d6699990ea` |
| `verify-recipe-batch2.ts` | `npx tsx verify-recipe-batch2.ts` | `PASS=103 FAIL=0` | 0 | `%TEMP%\hc-b1b-b2-f02e13cc-629c-4c67-9ede-3f8b90621dd3` |
| `verify-recipe-batch3.ts` | `npx tsx verify-recipe-batch3.ts` | `PASS=106 FAIL=0` | 0 | `%TEMP%\hc-b1b-b3-289fcc79-874a-4f62-94b4-2f9bda23ebe4` |
| `verify-recipe-transaction-rollback.ts` | `npx tsx verify-recipe-transaction-rollback.ts` | `PASS=27 FAIL=0` | 0 | `%TEMP%\hc-b1b-b4-c408d364-fd33-4823-af57-c2c9a596ccfe` |

- batch3 与 transaction-rollback **自带结尾清理**（`rmSync` 临时库），
  故其隔离目录中运行后**看不到** `.db` 文件——这是脚本原有设计行为。
- 四个脚本运行后：`63000–65499` 各区间监听数 = 0，**无 HomeChef 相关残留进程**。

### 4.3 阶段 1（代表脚本 + harness）的动态场景

来自阶段 1 报告，**当前仓库内没有持久化的测试脚本**（grep
`emit('SIGINT')` / `EXIT_HOOK` 无命中），因此以下项目属于**报告声明、
未能在本次审查中独立复现**：

- 进程层级 1 层（原 4 层）
- spawn 失败 306 ms 即报错、无残留
- 就绪超时 4000 ms 阈值 → 3731 ms 结束
- 断言失败 → `finally` 清理
- 父脚本异常退出 → exit 钩子清理
- 连续 / 并发 `stop()` 幂等
- `assertSafeDbPath` 8 例全通过
- SIGINT / SIGTERM 退出码 130 / 143（同进程合成事件路径）

> ⚠️ **已知平台限制**：Windows 上从**其他进程** `child.kill('SIGINT')`
> 不会触发目标进程的信号处理器，而是直接终止（Node 平台行为）。
> 因此**外部信号**路径无法用来验证处理器退出码；上述退出码是通过
> **同进程内 `process.emit('SIGINT','SIGINT')`**（必须带信号名参数）验证的。
> 真实 Ctrl+C 场景**尚未验证**。

### 4.4 收尾批次：`verify-phase3-search.ts` 路径隔离（2026-10-13 晚）

**批次目标**：消除 B1b 自身最后一个"已接入 harness 但仍会写入 `server/data/`"的脚本。

**改造前的越界证明**（实施前完成，未凭猜测）：

| 检查 | 结果 |
| --- | --- |
| 文件内删除类调用（`rmSync`/`unlink`/`rmdir`/`rename`/`copyFile`/`writeFile`/`mkdir`） | **仅 1 处**：原第 23 行 `rmSync(\`${dbPath}${s}\`)` |
| `dbPath` 赋值次数 | **1 次**，且为 `const`（后续无重新赋值） |
| `dbPath` 全部引用点 | 原 L23（删除预清理）、L26（`new Database`）、L68（传给 `startServer`） |
| 文件末尾是否有"结尾删除临时库" | **没有**（与 batch1–3、transaction-rollback 不同） |

结论：**所有文件系统副作用都以 `dbPath` 为唯一基准**，因此只要把 `dbPath` 的根
改为 `dataRoot`，删除必然同步落在隔离目录内，**不可能越界**。

> ⚠️ 顺带记录一个脚本差异：`verify-phase3-search.ts` **只在开头做预清理
> （`rmSync(..., {force:true})`），运行结束时不删除临时库**。这正是
> `server/data/` 中会累积 `v011-p3-*` 遗留文件的原因（本次实测该前缀共 **96 个**文件：
> 34 个 `.db` + 31 个 `-shm` + 31 个 `-wal`，时间跨度 2026-10-05 ~ 2026-10-12）。
> 本批次**未改变**这一清理语义（按要求不动清理逻辑）。

**修改内容**（唯一修改文件：`server/verify-phase3-search.ts`）：

```ts
// 临时库根目录：默认 server/data/（行为与改造前一致）；
// 设置 HOME_CHEF_TEST_DB_DIR 时改写到隔离目录，避免在受保护区内建库。
const dataRoot = resolve(
  process.env.HOME_CHEF_TEST_DB_DIR || resolve(process.cwd(), 'data'),
)
const dbPath = resolve(dataRoot, `v011-p3-${Date.now()}.db`)
```

diff 账目：改造前 `23 insertions / 18 deletions` → 改造后 `29 / 19`，
差额 **+6 / +1**，即上面 6 行新增 + 1 行替换；`ok(` / `info(` / SQL 关键字
的新增删除数**均为 0**。

**静态验证**：

```powershell
npx tsc --noEmit --target ES2022 --lib ES2022 --module NodeNext `
  --moduleResolution NodeNext --types node --strict --esModuleInterop `
  --forceConsistentCasingInFileNames --resolveJsonModule --skipLibCheck verify-phase3-search.ts
```
结果：**TSC_EXIT=0**，无输出。

**动态验证**：

| 项 | 值 |
| --- | --- |
| 命令 | `npx tsx verify-phase3-search.ts`（`workdir=D:\HomeChef\server`） |
| 隔离目录 | `%TEMP%\hc-b1b-p3-3c09a307-b600-4c2f-8b83-0e76f321593e` |
| 结果 | `PASS=39 FAIL=0` |
| 退出码 | **0** |
| 覆盖 | 准备 4 个定义 + Case 1–8 + 搜索边界（LIKE 转义、首尾 trim） |

**隔离生效的直接证据**（与 batch1–3 不同，本脚本不自我清理，因此测试库可见）：

```
hc-b1b-p3-…\v011-p3-1791889698323.db        155648 B
hc-b1b-p3-…\v011-p3-1791889698323.db-shm     32768 B
hc-b1b-p3-…\v011-p3-1791889698323.db-wal    206032 B
```

三个文件确实生成在 `%TEMP%` 隔离目录内；同时 `server/data/` 中
**当天新增文件数 = 0**、`v011-p3-*` 数量保持 **96** 不变。

**进程与端口**：运行端口 28132 监听数 **0**；`27000–28999` 区间仅剩
Steam 占用的 27036（与 HomeChef 无关，未处理）；无 HomeChef 相关残留进程。

> ⚠️ **已知偶发风险**：该脚本端口取 `27000 + rand(0,2000)`，而 Steam 常驻监听
> **27036**。命中概率约 1/2000；一旦命中，脚本的端口预检会打印
> `[FAIL] 端口 … 已被占用` 并非零退出（这是脚本**原有**的防护行为，不是本次改造引入）。
> 本次运行未命中。

**保护范围核对（运行前后，CHANGED_ITEMS = 0）**：

| 项 | 前 | 后 |
| --- | --- | --- |
| `server/data/` 总文件数 | 1823 | 1823 |
| `.db` 数量 | 450 | 450 |
| `homechef.db` | 233472 B / 2026-10-10 13:34:42 | 同 |
| `v011-p3-*` 数量 / 清单 SHA-256 | 96 / `d336a56b…4aed759` | 同 |
| 全目录清单 SHA-256 | `b6ec3b76…2703e102` | 同 |
| 备份 SHA-256 | `224412c2…4e1bd127` | 同 |
| 受保护 14 脚本 | 14/14 未跟踪未改动 | 同 |
| `TECH_STACK.md` / `SortControls.tsx` | 未改动 | 未改动 |


### 4.6 失败路径清理的控制流核对与 R3 隔离测试（2026-10-13）

> 本节补记两项此前只存在于当轮报告中、未落盘的内容：
> ① 对五个脚本清理控制流的**逐行只读核对**（用于更正一处错误推断）；
> ② R3 隔离生命周期测试 D1–D7 的结果。

#### 4.6.1 各脚本清理位置（**只读代码核对**，非运行时验证）

| 脚本 | `process.exit` 位置 | `stop()` 位置 | 说明 |
| --- | --- | --- | --- |
| `verify-phase3-search.ts` | L82、L94（提前退出）、L242（末尾） | L81、L93、L238 | **两处提前退出均在其前一行 `await server.stop()`** |
| `verify-recipe-batch1.ts` | **仅** L519（文件末尾） | **仅** L513（`finally` L511 内） | 无提前退出；清理位于统一 `finally`，`process.exit(1)` 在清理之后 |
| `verify-recipe-batch2.ts` | **仅** L534 | **仅** L528（`finally` L526 内） | 同上 |
| `verify-recipe-batch3.ts` | **仅** L568 | **仅** L559（`finally` L557 内） | 同上 |
| `verify-recipe-transaction-rollback.ts` | **仅** L345 | L184、L241、L334–336 | 使用统一清理路径；文件末尾按 `server3 → server2 → server1` **逆序**停止 |

**⚠️ 一处推断更正**：批次讨论中曾提出"batch1/2/3 就绪失败时**直接 `process.exit(1)`**、无显式 `stop()`、仅靠 exit 钩子兜底"。上述逐行核对表明**该说法不成立**——这三个脚本**只有一处 `process.exit`，位于文件最末尾**，就绪失败路径只做 `fail++` 然后继续走到统一 `finally`，因此 `stop()` **会**被执行；exit 钩子只是第二道防线。

#### 4.6.2 R3 隔离测试 D1–D7（**动态实测**）

驱动与桩服务均位于 `%TEMP%\hc-b1b-failpath-75796be4-06a3-4059-b555-1b125247a82a\`，
通过相对路径导入既有 harness，**未修改任何项目文件**。服务数据库路径均指向 `%TEMP%`。

| 用例 | 场景 | 结果 | 关键实测证据 |
| --- | --- | --- | --- |
| D1a | 启动失败（入口文件不存在）+ 显式 `stop()` | PASS | 异常类型 `ServerStartupError`（"服务进程在就绪前已退出"）；耗时 **331ms**（远低于 30s 超时）；服务 PID 事后**已消失**；端口监听 0 |
| D1b | spawn 失败（解释器不存在）+ 显式 `stop()` | PASS | `ServerStartupError`（`…ENOENT`）；耗时 **346ms**；`spawnError` 被捕获 |
| D2a | 启动失败 + **不调** `stop()` | 无残留 | 退出码 3；**但子进程在 `stop()` 之前已自行退出** |
| D2b | spawn 失败 + **不调** `stop()` | 无残留 | 退出码 3；`spawn` 从未成功，无子进程 |
| D3 | **活进程**就绪超时 + 显式 `stop()` | PASS | `超时前进程是否仍存活=true`；`stop()` **21ms** 完成；服务 PID 事后已消失；端口监听 0 |
| D4 | **活进程**就绪超时 + **不调** `stop()` | PASS | `退出前进程是否仍存活=true`，随即 `process.exit(4)`；事后服务 PID 已消失、端口监听 0 |
| D5 | 模拟断言失败 → `finally` 是否执行 `stop()` | PASS | 落盘日志依次出现「进入 finally，开始 stop()」→「finally 中 stop() 已完成」→ `finallyRan=true` |
| D6 | `stop()` 重复与并发调用的幂等性 | PASS | 5 次并发/重复调用全部 resolve；最终已停止；`unhandledRejection=0` |
| D7 | `assertSafeDbPath()` 四个拒绝用例 | PASS | 空串 / 纯空白 / 真实库 / 真实库 `-wal` **4/4 被拒**；正向对照隔离路径被接受；**未打开任何数据库** |

**关于 `stop()` 返回值的一个特性（实测）**：harness 的 `stop` 是 `async function`，
async 函数返回 Promise 时**总用新的外层 Promise 包装**内部的 `stopPromise`。
因此**每次调用的返回值引用必然不同**（实测 `Object.is(a,b)=false`），但这**不代表幂等性失效**：
内部 `stopPromise` 被复用 ⇒ `terminateProcess` **只执行一次**。
幂等性的正确判据是"全部 resolve + 最终进程已退出 + 无 unhandledRejection"（D6 已满足）。
另有实测：**首次 `await stop()` 确实会等待进程退出**（补充实验 D6b：await 耗时 16ms 且随后 `hasExited=true`）。

#### 4.6.3 这些测试**不能**证明什么（边界限制）

- **D2a / D2b 不能**作为"exit 钩子清理了仍存活进程"的证据——两者的被测子进程在清理前**已自行退出**。
- **D4 仅覆盖单层进程**（harness 直启、无孙子进程），**未验证完整进程树**的清理能力。虽然 `syncKill()`（L180–189）与 `terminateProcess()`（L320–332）都带 `taskkill /T /F` 的树杀参数，但**该路径未构造条件验证**。
- **完整脚本端到端失败注入仍未验证**（未在 `verify-recipe-batch1/2/3.ts` 中制造真实的就绪失败）——继续列为 **V5**。
- 真实外部 Ctrl+C 仍未验证（平台限制，见 §4.3）。
- 未验证 `stop()` 自身抛错的变体，以及 `taskkill` 失败后的行为。

> 因此本节结论**不可**被表述为"所有失败路径均已端到端验证"。
---

## 5. 保护范围核对（每次动态运行前后均执行）

| 项 | 结果 |
| --- | --- |
| `server/data/` 总文件数 | 1823 → 1823（四次运行后均未变） |
| `.db` 数量 | 450 → 450 |
| `homechef.db` | 233472 B / 2026-10-10 13:34:42（未变） |
| 有效备份 `homechef.db.bak-20261011-full` SHA-256 | `224412c2772d7dba8e88cf346d8984a138b4985985a847f465cd11ea4e1bd127`（未变） |
| 历史残留 `v011-p3-*`（3 个） | 大小 + mtime 逐项一致 |
| 历史残留 4 组 `recipe-b1/b2/b3/tx-*`（12 个） | 大小 + mtime 逐项一致 |
| 受保护 14 个诊断脚本 | 14/14 保持未跟踪未改动 |
| `TECH_STACK.md` / `client/src/components/SortControls.tsx` | 未改动 |

**量尺教训（记录备查）**：核对文件名清单时曾用
`.NET String.GetHashCode()` 做指纹，导致误报一次"清单变化"。
该 API **每进程随机化**（实测 `'abc'.GetHashCode()` 在不同进程得到
`-1819839326` / `-2102508175`），跨进程比较无意义。
后续一律使用 **SHA-256**。

---

## 6. 未解决问题、风险与未执行的验证

### 6.1 已证实的问题

1. ~~**`server/verify-phase3-search.ts` 仍会写入 `server/data/`**~~
   —— **已于 B1b 收尾批次修复**（见 §4.4）。原状：第 21 行为
   `resolve(process.cwd(), 'data', \`v011-p3-${Date.now()}.db\`)`，且**没有**
   `HOME_CHEF_TEST_DB_DIR` 入口；实证为 `server/data/` 中累积的 `v011-p3-*` 遗留文件。
   > 数量更正：原文写"现存 3 个"，实测该前缀共 **96 个**文件
   > （34 个 `.db` + 31 个 `-shm` + 31 个 `-wal`）。原文只看了交接文档点名的那一组。
   <br>修复后该脚本可重定向到 `%TEMP%`，并在隔离目录中跑通（`PASS=39 FAIL=0`）。

2. **其余 19 个脚本仍使用 `spawn('npx', ['tsx','src/server.ts'], { shell: true })`
   启动服务**：`_diag-500.ts`、`_diag-cross.ts`、`_repro-u1.ts`、
   `finalverify-04-phases.ts`、`p5-review-edge-cases.ts`、`p5b-audit-batch2.ts`、
   `p5c-final-review-v012.ts`、`verify-dates.ts`、`verify-phase31-change-definition.ts`、
   `verify-phase4-merge.ts`、`verify-v012-settings-expiry.ts`、
   `verify-v012-sort-expiry.ts`、`verify-v012b3-definition-sort.ts`、
   `verify-v013-cross-category.ts`、`verify-v013-u1-seasoning-switch.ts`、
   `verify-v013.ts`、`verify-v014-category-change.ts`、
   `verify-v014-category-color.ts`、`verify-v014-full-save.ts`。
   它们**都**注入了 `HOME_CHEF_DB_PATH`（指向自己的临时库），但该临时库落在
   `server/data/` 下——这正是该目录里存在数百个测试 `.db` 的原因。

3. **seed 子进程仍是 `shell: true`**：四个 recipe 脚本与 phase3-search 都调用
   `spawn('npx', ['tsx', 'seed/seed.ts'], { ... shell: true })`。
   Node 会打印 `DEP0190` 弃用警告。该子进程同样存在"逃逸成孤儿"的结构性风险，
   只是它不是被测服务、且 `stdio: 'ignore'`，因此不在本批次修复范围内。

### 6.2 未执行的验证

- **全量回归套件**：仓库**没有**统一的回归入口（`package.json` 只有
  `dev/build` 脚本，无 test 脚本；README 亦说明"尚未配置自动化测试框架"）。
  B1b 期间**未**运行任何全量回归，**也未**运行上述 19 个旧脚本中的任何一个。
- 真实 Ctrl+C（外部信号）场景。
- **完整脚本端到端失败注入（V5）**：未在 `verify-recipe-batch1/2/3.ts` 中制造真实的
  就绪失败。失败路径清理已于 §4.6 做过**控制流只读核对**与**公共机制层面的隔离测试
  （D1–D7）**，但**脚本端到端**仍未验证。
- 前端 `tsc` 与 production build。

### 6.3 风险分级

| 级别 | 事项 |
| --- | --- |
| **高** | 无（受保护区域在所有已执行的运行中经核对未变化） |
| **中** | 19 个旧脚本仍会生成孤儿进程并写入 `server/data/`（`verify-phase3-search.ts` 已于收尾批次修复） |
| **低** | seed 子进程的 `shell: true` + `DEP0190`；`startServerWithEnv` 对 harness 的隐式耦合 |
| **仅缺证据** | ① 阶段 1 的场景测试（无持久化脚本，无法独立复现）；② 完整脚本端到端失败注入（V5）；③ exit 钩子对完整进程树（孙子进程）的清理能力（V1）；④ `stop()` 抛错与 `taskkill` 失败路径（V2/V3）。失败路径清理的控制流核对与 D1–D7 隔离测试见 §4.6 |

---

## 7. 当前验收状态

> ## ✅ B1b 已验收通过（2026-10-13）
>
> **验收结论**：B1b **按原定范围正式验收通过**。
>
> **验收依据**（均为已有记录，本次**未重新运行任何测试**）：
> ① 对五个脚本与公共 harness 的静态只读核查；
> ② 五个脚本第二阶段的 **358 条断言**（`PASS` 39/83/103/106/27，`FAIL` 全 0，退出码全 0）；
> ③ **R3 隔离测试 D1–D7**；
> ④ 五文件**合并 TypeScript 检查**（退出码 0、无诊断）；
> ⑤ 全部运行前后的**保护范围**核对（`server/data/` 计数与哈希、`homechef.db`、备份 SHA-256 均未变）。
>
> **验收范围 = 原定 B1b 范围**，未扩大。以下限制**在验收时被明确保留**，不得因本次通过而视为已解决：
>
> - **R3 结论的范围限制**：R3 的证据**限于「控制流只读核对」与「公共机制层面的动态验证（D1–D7）」**。
> - **V1**：exit 钩子对**完整孙子进程树**的清理能力**尚未验证**（D4 仅覆盖单层进程）。
> - **V5**：**完整脚本端到端失败注入尚未验证**（未在 `verify-recipe-batch1/2/3.ts` 中制造真实就绪失败）。
> - **R1、R2、R4、R5、R6、R7** 等遗留事项**继续按原分类处理**（§6.1/§6.2/§6.3），不因 B1b 通过而视为已解决。
> - **不得声称"所有失败路径均已端到端验证"**——该表述与现有证据不符。
>
> **已验收 ≠ 已提交或已推送**：本次改动仍全部处于**未暂存**状态。

| 批次 | 执行状态 | 验收状态 |
| --- | --- | --- |
| 公共 harness（阶段 1） | 完成改造 | **已验收通过**（2026-10-13） |
| `verify-phase3-search.ts` 代表脚本改造（阶段 1） | 完成改造 | **已验收通过**（2026-10-13） |
| `verify-phase3-search.ts` 路径隔离（**收尾批次**） | 改造 + 动态验证通过（`PASS=39 FAIL=0`） | **已验收通过**（2026-10-13） |
| `verify-recipe-batch1.ts`（阶段 3 第一步） | 改造 + 动态验证通过 | **已验收通过**（2026-10-13） |
| `verify-recipe-batch2.ts`（阶段 3 第二步） | 改造 + 动态验证通过 | **已验收通过**（2026-10-13） |
| `verify-recipe-batch3.ts`（阶段 3 第三步） | 改造 + 动态验证通过 | **已验收通过**（2026-10-13） |
| `verify-recipe-transaction-rollback.ts`（Batch 4） | 改造 + 动态验证通过 | **已验收通过**（2026-10-13） |
| 失败路径清理（控制流核对 + R3 隔离测试 D1–D7，见 §4.6） | 公共机制层面动态验证通过；**脚本端到端失败注入未做（V5）** | **已验收通过**（V5 仍在验收时被保留为未验证） |

> 表中"动态验证通过"仅指**脚本自身断言全绿且退出码为 0**，以及**保护范围经核对未变化**。
> 各行的"**已验收通过**"依据上方的验收结论；其**限制条件以该结论中列出的 V1/V5/R1/R2/R4–R7 为准**。

---

## 8. Git 状态（记录时）

```
分支        : main
HEAD        : 96fff9cbc3c61bf5dd501f3a6d0dbca60affe974   (tag: v0.2.0)
origin/main : 96fff9cbc3c61bf5dd501f3a6d0dbca60affe974   (领先/落后 0/0)
暂存区      : 0 项
未暂存      : 5 个（上述 5 个 verify 脚本）
未跟踪      : 16 项 = HANDOFF_B1B.md + docs/ 下新增记录
              + server/harness/server-lifecycle.ts + 14 个受保护诊断脚本
未完成的 Git 操作: 无（无 rebase / merge / cherry-pick，stash 为空）
```

**未执行**：`git add`、`git commit`、`git push`、任何 `git reset --hard`。

---

## 9. 后续建议（**待用户批准，未实施**）

1. 为 `server/verify-phase3-search.ts` 增加 `HOME_CHEF_TEST_DB_DIR` 入口
   —— 与 B1b 四个脚本保持同一模式，消除它对 `server/data/` 的写入。
2. 视需要为 `StartServerOptions` 增加可选 `env` 字段，替换
   `startServerWithEnv()` 的临时改写 `process.env` 写法。
3. 再考虑是否逐个迁移其余 19 个旧式 `npx + shell` 脚本。
