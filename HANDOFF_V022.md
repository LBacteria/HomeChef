> 发布收尾：用户于 2026-10-16 验收通过并授权以 v0.2.2 提交、推送。下文“未提交/未推送/版本号未改”为夜间验收时点的历史状态，当前版本及提交以 Git 和 CHANGELOG 为准。

> 最终验收补记：Sol在第三轮后补齐了旧方案错误恢复（实际重新请求并禁用过期确认）、界面文案、演示种子保护和本地日期；独立测试与浏览器证据、完整变更清单和准确启动步骤以 [SOL_ACCEPTANCE_V022.md](./SOL_ACCEPTANCE_V022.md) 为准。

# HomeChef v0.2.2 交接说明（本地规则算法整餐推荐）

> 生成时间：**2026-10-16（Asia/Shanghai）**
> 状态：**代码完成、隔离验证通过；未提交、未推送、未改版本号**
> 版本归属（经用户与 Lumi 确认）：`v0.2.1` 烹饪流程与结算 ｜ **`v0.2.1.1` 烹饪记录管理 + 中式灶台主页改版 + 扇形白框修复 + 导航高亮修复** ｜ **`v0.2.2` 本地规则算法整餐推荐（不接入 AI）** ｜ `v0.3` DeepSeek AI 接入。
> ⚠️ 本文件独立于 [`HANDOFF_B1B.md`](./HANDOFF_B1B.md)、[`HANDOFF_V0211.md`](./HANDOFF_V0211.md)、[`HANDOFF_HOME_UI.md`](./HANDOFF_HOME_UI.md)，不覆盖它们。
> **本文件§2 记录了 Sol 第一轮验收 13 条问题的修复与证据。**

---

## 1. 目标与范围

**做什么**：输入人数，基于**已有菜谱 + 可用库存**，推荐 3–5 套完整的一餐（通常 2–3 菜），每套给出菜品、人数、**每道菜缩放后的配料与步骤**、合并整餐需求、库存满足/明确缺少数量、分数与**中文可解释理由**。算法**纯本地、确定性、可复现**，**不接入任何 AI 或网络请求**。

**没做**：不接 AI（留给 v0.3）；不预扣库存（扣减仍由既有结算负责）；不做营养数据；不做菜谱替换建议/购物清单/分页。

**保留未破坏**：v0.2.1.1 的烹饪记录管理（多选/批量删除/改名）与中式灶台主页、扇形白框修复、导航高亮修复全部原样保留。

---

## 2. Sol 第一轮验收 13 条 —— 逐条修复与证据

| # | 问题 | 修复 | 验证 |
|---|---|---|---|
| **1** | 同单位「已知量 + null 数量」混合时 `has_unknown_line` 被忽略，会假称 ready | `unknown_count` 改为在需求循环**开头统一计数**（只要出现过未指定用量），不再只在 `known_required<=0` 时计 | 仓库测试 A15；独立用例第 3 项 |
| **2** | coverage 分子含调味品、分母不含，可 >1 | 分子分母**同口径**（都只算非调味品且已知用量），并显式 `clamp` 到 [0,1] | 仓库测试 A17；独立用例第 4 项 |
| **3** | `main_missing_count=0` 就写「都够，可以直接开做」，与未知用量冲突 | 改为三分支：只有**三者全为 0**才说「可以直接开做」；否则分别说明「主要食材已知用量够」+「N 项用量未指定，**不能算作完全确定**」+「缺 N 项调味品」 | A15 断言 note 含「未指定用量」；E2E 文案 |
| **4** | `ready_bonus` 只看 `main_missing_count`，未知/缺调味品可压过真正 ready；排序未先比等级 | ①`ready_bonus` 仅在**真正 ready**（主缺口、缺调味品、未知三者皆 0）时给；②排序**先等级（ready→nearly→missing）再分数**；③新增 `planLevelRank()` | 仓库测试 A20、A21 |
| **5** | 截断前 40 按 id 丢弃后新增的可用菜谱；top5 几乎相同 | ①候选**先按单菜库存匹配排序**（等级→主缺口→覆盖比例→临期消耗→recipe_id）**再截断**；②top N 用**等级优先的贪心 + 重叠惩罚**（`OVERLAP_PENALTY=60`）；③新增 `considered_recipe_count` / `candidate_truncated`，并在 `notes` 明确说明截断与「可能错过更优组合」 | 仓库测试 B12；E2E 中 5 套方案 |
| **6** | `used_expiring` 在未满足的需求上也标「消耗」，用字不保守 | 只有需求**被满足**时才计 `used_expiring` / `expiring_used_count`；理由文案改为「**会用掉** N 项临期食材」（未满足一律 `false`） | 仓库测试 A22 |
| **7** | 推荐移交份量与 per-dish 配料显示；未知项不得当全足 | 每道菜返回**已按份数倍数缩放**的 `ingredients`，界面明确展示倍量；未知项仍标「用量未指定」 | 仓库测试 B11；E2E 详情「番茄 3 个」= 2×1.5 |
| **8** | 核对页可改倍数但合并需求仍是旧值，误导确认 | **MVP 直接去掉此处编辑**：核对页固定展示服务端倍率与说明「进入烹饪页后仍可逐道调整份数」 | E2E `noEditableServingsOnReview: true` |
| **9** | 缺每道菜详情与所需配料 | 每道菜返回 `ingredients`（缩放后）与 `steps`；核对页每道菜可**展开详情**（配料 + 步骤） | 仓库测试 B11；E2E `perDishDetailRendered: true` |
| **10** | 确认 await 时仍可导航，结果不明重试可能重复建会话 | ①新增 **`request_id` 有界幂等**：同 key 同 payload → 返回**同一 session**（并标注 `idempotent_replay`）；同 key 不同 payload → **409 IDEMPOTENCY_CONFLICT**；②前端一次「确认意图」固定一个 key，失败**沿用同一 key 重试**；③成功/过期/冲突后才作废旧 key；④**卸载后不再导航**；⑤网络结果不明时文案明确引导**先查看烹饪记录**；⑥**绝不自动重试**写操作 | 仓库测试 B9（含「重放不再建会话」）；E2E `singleSessionCreated` |
| **11** | 菜谱/库存变化后服务端应重新核对，不能静默用新配方 | meal-plans 每套方案返回 **`snapshot_id`**（服务端指纹，覆盖：当天日期、临期设置与 `allow_expired_for_recipe`、选中菜谱的 `content_revision` 与全部配料行、相关食材的分类/调味品属性与**全部库存批次**）；apply 时**服务端重算**并比对，不一致 → **409 SNAPSHOT_STALE** | 仓库测试 B10（伪造指纹 + **真实改配料**后旧指纹均被拒，且**不创建会话**） |
| **12** | 结算对过期库存的行为与推荐不一致；`allow_expired_for_recipe` 实际未被使用 | **确认属实并修复（两处）**：<br>**(a) 实际扣减**：`availableStockRows` 此前只过滤 `quantity>0`，且排序让最早到期（含过期）排最前 → **有鲜批次也会优先扣过期**，而 `allow_expired_for_recipe`（默认 false）**从未被读取**。现改为：**默认排除过期批次**；设为 true 时保留原语义。仅靠过期库存时结算以 `INSUFFICIENT_STOCK` **显式失败并整体回滚**。<br>**(b) 结算预览**（Sol 第二轮发现）：`previewSettlement` 仍**直接 sum 全部库存**，把过期也算进"可扣"，于是「过期 100 + 新鲜 20」预览成 **120** 而实际只能扣 20 —— **预览虚报充足**。现改为复用**同一个** `availableStockRows`（函数签名由 `Tx` 放宽为 `Queryable`，其余逻辑未动） | 仓库测试 D（实际扣减）与 **E（预览）**：默认设置下过期批次 **10→10 未扣**且结算 409；开启后 **10→8** 且结算 200。预览：默认 **20（不是 120）**、允许过期后 **120**、**「今天到期」不算过期**（20+7=27）、结算只从新鲜+今天到期扣（127→125，过期 100 未被动）。Sol 独立 HTTP 用例 `independent-api-v022.cjs` **9/9 通过**（修前 8/1，失败项正是「结算预览默认排除过期批次」） |
| **13** | 测试缺真实烹饪步骤→确认→结算回归 | 新增 C 段：推荐 → apply → **`PATCH .../progress` 标完成** → **`POST .../settle`**，并校验**库存扣减量与合并需求完全一致（共享库存不超扣）**；C2 校验库存不足时**整体回滚**（库存不变、会话未 settled、**无结算凭证**） | 仓库测试 C1 / C2 |

**同时**：把 Sol 独立用例里同样有意义的边界**补入仓库测试**（A15–A22，断言未弱化）。

---

## 3. 产品自主决定（集中配置，可逐项调整）

| 决定 | 取值 | 理由 |
|---|---|---|
| 菜谱基准人数 | **2 人份**（`DEFAULT_RECIPE_BASE_SERVINGS`） | 菜谱表无基准人数字段；人数÷基准=倍数，**推荐与会话共用同一倍率** |
| 菜品数量 | 1 人→2 菜；≥2 人→3 菜（可被可用菜谱数下调为简餐） | 需求「通常 2–3 菜」 |
| 过期食材 | **一律不计入可用**（`COUNT_EXPIRED_AS_AVAILABLE=false`）；仅提示 | 需求明确；与结算侧 `allow_expired_for_recipe` 是**两件事**，推荐从严 |
| 调味品 | presence-only；缺调味品扣分 10（远低于主料 40） | 单缺盐不应判为做不了 |
| 未知用量 | 记 `unknown_quantity`，**不计入够用**，且**不得让方案判为 ready** | 需求「不将未知用量视为充分」 |
| 单位 | 必须完全相同，绝不换算 | 需求 |
| 同一食材 | 同 definition + 同 unit **先合并** | 需求「不能重复占库存」 |
| 复杂度上限 | 候选 ≤40、组合 ≤20000（超出截断并在 notes 说明） | 防组合爆炸 |
| 方案数 | 最多 5 套；不足 3 套照实返回并注明 | 需求「3–5 套」 |
| 人数 / 份数上限 | 1–12 整数 / 倍数 ≤20 | 校验 |
| 重叠惩罚 | `OVERLAP_PENALTY=60`（等级内贪心，保证多样性） | 条目⑤ |
| 幂等 | TTL 10 分钟、上限 200 条、**进程内 Map** | 不迁库；局限见 §9 |

**评分公式**：`(真正ready ? 1000 : 0) + 100×满足比例 + 6×临期消耗 + 8×多样性 − 40×主缺口 − 10×缺调味品 − 8×未知用量`；排序：**等级 → 分数 → 主缺口 → 签名**。

---

## 4. 文件清单

**新增**：`server/src/services/recommendationConfig.ts`（集中参数）、`recommendationAlgorithm.ts`（纯算法）、`recommendationService.ts`（取数/快照/理由）、`server/src/routes/recommendation.ts`、`server/verify-v022-recommendation.ts`（**119 项**）、`server/seed/seed-v022-demo.ts`（演示种子，拒绝真实库）、`client/src/api/recommendation.ts`、`client/src/pages/RecommendPage.tsx`、`client/src/recommend.css`

**修改**：`server/src/server.ts`、`services/cookingService.ts`（新增 `createSessionWithDishes`）、**`services/settlementService.ts`（条目⑫）**、**`services/errors.ts` + `routes/http.ts`（新增 `SNAPSHOT_STALE` / `IDEMPOTENCY_CONFLICT` → 409）**、`client/src/App.tsx`、`pages/CookingPage.tsx`、`pages/HomePage.tsx`、`components/MoreToolsPanel.tsx`、`types/api.ts`、`main.tsx`

---

## 5. API 契约

### `POST /api/recommendation/meal-plans` —— **纯读，零写入**
请求 `{ "people": 2 }` → 响应含：
```jsonc
{
  "people": 2, "base_servings": 2, "multiplier": 1, "dish_count": 3,
  "candidate_recipe_count": 6, "considered_recipe_count": 6, "candidate_truncated": false,
  "combinations_evaluated": 20, "truncated": false, "today": "2026-10-16",
  "plans": [{
    "plan_id": "1x1,2x1,6x1", "snapshot_id": "1093b4d58592618c13e0ac65",
    "level": "ready", "score": 1163.33,
    "dishes": [{
      "recipe_id": 1, "recipe_name": "番茄炒蛋", "servings": 1,
      "tags": [], "content_revision": 0,
      "ingredients": [{ "definition_id": 1, "definition_name": "番茄",
                        "quantity": 2, "unit": "个", "note": null, "is_seasoning": false }],
      "steps": [{ "step_no": 1, "content": "..." }]
    }],
    "requirements": [ /* status: ok|insufficient|unit_mismatch|unknown_quantity|seasoning_missing */ ],
    "summary": { "required_count": 4, "satisfied_count": 4, "missing_count": 0,
                 "main_missing_count": 0, "seasoning_missing_count": 0, "unknown_count": 0,
                 "expiring_used_count": 1, "expired_excluded_count": 0,
                 "coverage": 1, "categories_used": ["蔬菜"], "tags_used": [] },
    "reasons": ["3 道菜的主要食材库存都够，可以直接开做。"]
  }],
  "notes": ["菜谱按 2 人份为基准；2 人时每道菜按 1 倍量做。"]
}
```
错误：**400**。

### `POST /api/recommendation/apply` —— **原子写，不预扣库存**
请求：
```jsonc
{ "people": 2,
  "dishes": [{ "recipe_id": 1, "servings": 1.5 }],
  "snapshot_id": "1093b4d58592618c13e0ac65",   // ← 来自 plan.snapshot_id，必填
  "request_id": "<uuid>" }                      // ← 一次性幂等键，必填
```
响应：`{ "session_id": 5, "dish_count": 3, "people": 2, "expected_multiplier": 1, "snapshot_id": "...", "idempotent_replay"?: true }`

| 状态 | 场景 |
|---|---|
| **200** | 成功；或**同 key 同 payload 重放**（返回首次会话，带 `idempotent_replay: true`） |
| **400** | 人数/份数非法、重复菜谱、空数组、缺 `snapshot_id`/`request_id` |
| **404** | 菜谱不存在 |
| **409 `SNAPSHOT_STALE`** | 菜谱配料、相关库存、分类或临期设置**在确认后发生变化** |
| **409 `IDEMPOTENCY_CONFLICT`** | 同一个 `request_id` 用于**不同内容** |

> 服务端**只信 `recipe_id` 与份数**；分数、需求、缺口、指纹全部重算。会话 + 全部菜品在**同一事务**创建，失败整体回滚。
> 校验顺序：参数 → 幂等 → 菜谱存在 → **快照一致** → 原子创建。

---

## 6. 可体验方式（隔离，绝不动真实库）

```powershell
$run = Join-Path $env:TEMP ("hc-v022-try-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $run -Force | Out-Null
$db = Join-Path $run "try.db"
cd D:\HomeChef\server
npx tsx seed/seed-v022-demo.ts $db            # 演示种子（拒绝真实库）

$env:HOME_CHEF_DB_PATH = $db; $env:PORT = "64700"
Start-Process -FilePath "C:\Program Files\nodejs\node.exe" -WorkingDirectory "D:\HomeChef\server" `
  -ArgumentList @("--require","D:\HomeChef\node_modules\tsx\dist\preflight.cjs",
                  "--import","file:///D:/HomeChef/node_modules/tsx/dist/loader.mjs","src/server.ts")

$env:HOME_CHEF_API_TARGET = "http://127.0.0.1:64700"
Start-Process -FilePath "C:\Program Files\nodejs\node.exe" -WorkingDirectory "D:\HomeChef\client" `
  -ArgumentList @("D:\HomeChef\node_modules\vite\bin\vite.js","--port","5189","--strictPort")
# 打开 http://localhost:5189/ → 中央「开始烹饪」
```

> ⚠️ **必须用上面的单进程方式启动后端**。`Stop-Process` 只杀 `npx.cmd` 包装**不会**杀掉真正的 node 后端，会留下**占端口的孤儿进程**（曾因此产生「临时库里有幽灵会话」的假象）。收尾请按端口核对：
> ```powershell
> Get-NetTCPConnection -State Listen -LocalPort 64700,5189 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
> ```

演示数据：6 菜谱 / 7 库存，**鸡蛋临期**（演示「优先消耗临期」）、**牛奶已过期**（演示「过期不计入可用」→ 含牛奶的菜判为缺料）。

---

## 7. 隔离验证命令

```powershell
cd D:\HomeChef\server
npx tsx verify-v022-recommendation.ts        # ← 本次扩展，119 项
npx tsx verify-v0211-cooking-records.ts      # ← 既有回归 65
$env:HOME_CHEF_TEST_DB_DIR = "$env:TEMP\hc-reg"
npx tsx verify-recipe-batch1.ts              # ← 既有回归 83
npx tsx verify-recipe-batch2.ts              # ← 既有回归 103
npx tsx verify-recipe-batch3.ts              # ← 既有回归 106（烹饪/结算）

# Sol 的独立纯算法用例（11 项，不连库）
node --import file:///D:/HomeChef/node_modules/tsx/dist/loader.mjs `
  "C:\Users\guoqi\.codex\.chatgpt-projects\g-p-6ace4cdc0754819184e11c76c67d17c8\dsh-experiment\independent-v022.ts"

cd D:\HomeChef\client; npx tsc --noEmit; npm run build
cd D:\HomeChef\server; npx tsc --noEmit
```

---

## 8. 实际执行结果（2026-10-16 00:2x–00:4x）

| 项目 | 结果 |
|---|---|
| `verify-v022-recommendation.ts`（仓库，扩展后） | **PASS=127 FAIL=0**，exit 0 |
| **Sol 独立 HTTP 验收** `independent-api-v022.cjs` | **PASS=9 FAIL=0**（修前 **8/1**） |
| Sol 独立纯算法 `independent-v022.ts` | **PASS=11 FAIL=0**（修复前 8/2：A15、A17 两条失败） |
| `verify-v0211-cooking-records.ts` | **PASS=65 FAIL=0** |
| `verify-recipe-batch1.ts` | **PASS=83 FAIL=0** |
| `verify-recipe-batch2.ts` | **PASS=103 FAIL=0** |
| `verify-recipe-batch3.ts`（烹饪/结算） | **PASS=106 FAIL=0** |
| `tsc --noEmit`（client / server） | **0 / 0** |
| `npm run build`（client） | **0** |
| **真实浏览器端到端**（Chrome headless + CDP，隔离栈 64700 + 5189） | **12/12 全 true，exit 0** |

**浏览器端到端实测**（截图为证）：主页 → 中央「开始烹饪」→ 选 3 人 → 生成 5 套 → 展开合并食材 → 选这套 → **核对页无份数输入框**、每道菜可**展开详情**（配料已按 1.5 倍缩放：「番茄 3 个」；含步骤区）→ 确认 → **既有烹饪页直接打开新会话**（3 道菜）。
同时实测：**一次确认只创建一个会话**、**确认前会话数未变**、手动选菜仍可达、390px 无横向溢出。

**隔离与安全**：推荐阶段前后数据库摘要完全一致（零写入断言）；**真实库 `server/data/homechef.db` 写前写后逐表对比完全一致**（5 会话 / 6 dish / 7 recipe / 7 stock，352256 B、mtime 未变）；全程未设置 `HOME_CHEF_ALLOW_REAL_DB`、未执行真实库迁移。

---

## 9. 已知局限（不隐瞒）

1. **幂等表在进程内**：服务端重启后同一个 `request_id` 会被当成新请求，**可能再建一个会话**；多实例部署也各自独立。因此前端**禁止自动重试**写操作，只允许用户看到明确提示后手动重试。TTL 10 分钟、上限 200 条。
2. **快照只覆盖「会影响用量或可用性」的事实**：不包含菜谱**改名**、标签等不影响数量的字段（改名不会让 `snapshot_id` 失效，属有意为之）。
3. 核对页**不再支持调整份数**（条目⑧的 MVP 取舍）；倍数调整需进入既有烹饪页进行。
4. 候选超过 40 个只评估排序后的前 40 个，**可能错过更优组合**（`notes` 已明确说明）。
5. 组合枚举到 20000 上限即截断，同样会在 `notes` 说明。
6. 调味品缺料只提示、不阻止；结算时既有规则仍可能要求逐项跳过确认。
7. **结算的过期策略**：默认排除过期批次后，若某需求**只能**由过期库存满足，结算是 `INSUFFICIENT_STOCK` **整体失败**（而不是扣过期或跳过）。目前没有单独的「过期跳过」原因码，用户只能先补货或在设置中打开 `allow_expired_for_recipe`。
8. ~~**与本次改动无关的既有测试问题**：`server/verify-v012-settings-expiry.ts` 在北京时间 00:00–08:00 之间会失败 11 项~~ —— **已由 Sol 修复并验证**：该测试原用 `new Date().toISOString()`（**UTC**）算「今天」，而 `dates.ts` 的 `todayDateString()` 用**本地**日期，跨日时相差一天。Sol 已把 `shiftDays()` 改为「以本地日历今天为锚点、仅用 UTC 做纯日期加减」；**实测 `PASS=68 FAIL=0`**。⚠️ 该文件的改动**不是本次 v0.2.2 工作产生的**。

---

## 10. 正式服务现状与安全启动步骤

**实测现状（2026-10-16 00:5x，只读检查）**：

| 端口 | 状态 |
|---|---|
| **3002**（正式后端） | **无监听 —— 未运行** |
| **5173**（正式前端） | **无监听 —— 未运行** |
| 3001 | PID 29064（**QQ Agent，非 HomeChef**，勿动） |

> ⚠️ **不得声称正式服务已运行 v0.2.2 代码** —— 本轮**没有**启动任何正式服务，也没有对真实库做任何操作。3002/5173 当前都没有进程监听。

**安全启动步骤**（由使用者自行决定何时执行；本轮未执行）：

```powershell
# ① 先检查本地工作区（本轮代码已经在本地，无需先提交或拉取）
git -C D:\HomeChef status --short

# ② 启动后端（**真实库**：不设置 HOME_CHEF_DB_PATH，也不设置 HOME_CHEF_ALLOW_REAL_DB）
cd D:\HomeChef\server
$env:PORT = "3002"
npx tsx src/server.ts

# ③ 另开一个终端启动前端，代理到该后端
cd D:\HomeChef\client
$env:HOME_CHEF_API_TARGET = "http://127.0.0.1:3002"
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort  # http://127.0.0.1:5173/
```

**安全要点**：
- **不要**跑 `Start-HomeChef.bat` 做验证 —— 它会探测区间端口，在 3001 被 QQ Agent 占用时另开后端实例。
- **不要**设置 `HOME_CHEF_ALLOW_REAL_DB`；该开关只在真正要迁移真实库时才临时使用。
- v0.2.2 **不需要任何新迁移**（无 schema 变更），启动即用；真实库迁移与否与本功能无关。
- 启动后先访问 `http://127.0.0.1:3002/health` 确认 `{"status":"ok"}`，再打开前端。
- 若 3002/5173 已被别的程序占用，先查清归属再决定，**不要**强杀不明进程。

---

## 11. Git 状态

```
branch : main
HEAD   : 61722f6（本轮**未提交任何内容**）
origin : origin/main = 61722f6（本轮**未 push**）
```
未改版本号、未改 CHANGELOG、未打 tag、未提交、未推送。
