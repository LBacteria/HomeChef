# HomeChef v0.2.3 内容包：30 道家常菜 + 136 + 96 个食材定义

> **本目录是「纯新增」的可审查导入包**：不含数据库迁移，不改 `server/src/**`，
> 不读、不写、不枚举 `server/data/**`（真实库）。
>
> **当前状态（2026-10-16）：正式库追加已由 Sol 在用户授权下完成** ——
> 已先做在线备份（`homechef-before-library-fill-2026-10-16T07-35-24-820Z-bd84ac09.db`），
> 并在**受保护事务**内实际新增 **108 个食材定义 / 29 道菜谱**（追加后 **337 定义 / 36 菜谱**），
> **正式库存仍为 7 行、未改动**，20 张表旧业务行逐字段保留，schema 与迁移历史未变，重复导入零变化。
> ⚠️ 因此第 4 节的操作步骤属于**已执行的历史指引**，
> **不要再次对真实库盲目执行**；如需再导入，请重新走"备份 → dry-run → 事务"流程。

## 0. 交付物清单

| 文件 | 作用 |
| --- | --- |
| **`importer.ts`** | **唯一核心实现**：导出 `importRecipeContent(db, options)`。推荐调用方式：`db.transaction(() => importRecipeContent(db, {...}))()` |
| `import-v023-content.ts` | **薄 CLI 兼容入口**：不含导入逻辑，仅参数解析 + 再导出上述核心。**默认 dry-run（零写入）**，`--apply` 才写库，`--db` 必须绝对路径且**经 `assertSafeDbPath` 拒绝真实库**（退出码 2） |
| `content.json` | 内容数据①：136 个食材定义 + 30 道菜（含来源 URL、核对状态、两人份用量、自行改写的步骤、`synonyms` 同义名） |
| `content-extra.json` | 内容数据②：**96 个补充食材定义**（无菜谱；已按真实库既有名称/别名清单去重） |
| `verify-importer.ts` | 隔离测试：内存 fixture 的规则测试（dryRun 零写入、dry==apply、包内重名、别名冲突、非法单位拒绝、`verified=false` 拒绝） |
| `verify-content-acceptance.ts` | 隔离测试：**真实两包**在全新 0012 库的 dry/apply/第二遍幂等 + 旧业务行与库存逐字段保护 + 同义名去重 + 单位计数一致 |
| `verify-content-e2e.ts` | 隔离测试：**完整烹饪闭环**（导入两包 → 推荐 → apply → done → preview → 按 `confirm_reason` 确认 → settle 真实扣减） |
| `verify-content-import.ts` | 隔离测试：建库 → 写旧数据 → 两遍导入 → 断言（已适配统一核心的统计结构） |
| `README.md` | 本文件 |

---

## 1. 数据来源与核对状态

- 核对时间：**2026-10-16**（与来源清单 `checkedOn` 一致）。
- 核对方式：用带浏览器 UA 的 HTTP 抓取逐条打开每个 URL（`curl.exe`，返回 **HTTP 200**），
  校验 ① 页面可访问；② `<title>` 与菜名一致；③ 解析页面「食材明细」区块，
  逐条比对主料 / 辅料 / 调料清单；④ 确认步骤区块存在（页内步骤条数与关键工艺）。
- **步骤正文全部为本次自行改写**（每道菜 ≤ 200 字，实际最长 95 字），
  未复制来源的长文、图片或健康宣传文案。
- 用量为**两人份家庭参考量**；来源多数标注「适量」，凡属整理值均在菜谱 `note` 中说明。

### 核对结果统计

| 结果 | 数量 |
| --- | --- |
| `verified: true`（页面可达 + 标题匹配 + 食材明细比对） | **30 / 30** |
| `verified: false` | **0** |

### 来源清单

| # | 菜名 | 来源 URL | 核对状态 |
| --- | --- | --- | --- |
| 1 | 番茄炒鸡蛋 | https://home.meishichina.com/recipe-70001.html | verified: true |
| 2 | 蒜蓉西兰花 | https://m.meishichina.com/recipe/244955/ | verified: true |
| 3 | 清炒西葫芦 | https://home.meishichina.com/recipe-60974.html | verified: true |
| 4 | 青椒肉丝 | https://home.meishichina.com/recipe-93695.html | verified: true |
| 5 | 可乐鸡翅 | https://home.meishichina.com/recipe-307491.html | verified: true |
| 6 | 土豆炖牛肉 | https://home.meishichina.com/recipe-425979.html | verified: true |
| 7 | 香菇滑鸡 | https://home.meishichina.com/recipe-541623.html | verified: true |
| 8 | 麻婆豆腐 | https://home.meishichina.com/recipe-97145.html | verified: true |
| 9 | 家常豆腐 | https://home.meishichina.com/recipe-16611.html | verified: true |
| 10 | 清蒸鲈鱼 | https://home.meishichina.com/recipe-220959.html | verified: true |
| 11 | 香煎鸡胸肉 | https://m.meishichina.com/recipe/534320/ | verified: true |
| 12 | 冬瓜排骨汤 | https://home.meishichina.com/recipe-329446.html | verified: true |
| 13 | 玉米排骨汤 | https://home.meishichina.com/recipe-99724.html | verified: true |
| 14 | 紫菜蛋花汤 | https://home.meishichina.com/recipe-34843.html | verified: true |
| 15 | 冬瓜虾皮汤 | https://home.meishichina.com/recipe-405641.html | verified: true |
| 16 | 拍黄瓜 | https://home.meishichina.com/recipe-386511.html | verified: true |
| 17 | 凉拌木耳 | https://home.meishichina.com/recipe-416424.html | verified: true |
| 18 | 芹菜炒香干 | https://home.meishichina.com/recipe-377480.html | verified: true |
| 19 | 清炒油麦菜 | https://home.meishichina.com/recipe-505726.html | verified: true |
| 20 | 蚝油生菜 | https://home.meishichina.com/recipe-579509.html | verified: true |
| 21 | 番茄鸡蛋面 | https://m.meishichina.com/recipe/481838/ | verified: true |
| 22 | 小米南瓜粥 | https://home.meishichina.com/recipe-170028.html | verified: true |
| 23 | 香菇鸡肉粥 | https://home.meishichina.com/recipe-384494.html | verified: true |
| 24 | 鸡蛋羹 | https://m.meishichina.com/recipe/498107/ | verified: true |
| 25 | 土豆鸡蛋饼 | https://home.meishichina.com/recipe-63554.html | verified: true |
| 26 | 清炒胡萝卜丝 | https://home.meishichina.com/recipe-202144.html | verified: true |
| 27 | 酸辣土豆丝 | https://home.meishichina.com/recipe-414145.html | verified: true |
| 28 | 手撕包菜 | https://china-kitchen.lkk.com.cn/kitchen/zh-CN/recipe/0/c4/5f/ | verified: true |
| 29 | 肉末茄子 | https://m.xiachufang.com/recipe/104625616/ | verified: true |
| 30 | 香菇扒菜心 | https://m.meishichina.com/recipe/549527/ | verified: true |

### 与来源清单的偏离（均为显式替换，已单独核对）

| 菜名 | 偏离内容 | 原因 |
| --- | --- | --- |
| 鸡蛋羹 | 来源由 `home.meishichina.com/recipe-610513.html`（**微波炉版**）替换为 `m.meishichina.com/recipe/498107/`（「家常鸡蛋羹」，**蒸制**，同站同菜名） | 原选来源是非常规做法（微波炉），不符合「常规做法」要求；替换来源同样已逐页核对 |
| 香菇滑鸡 | 原方的市售浓缩调味料「红99麻辣烧鸡浓缩调味料」以蚝油、生抽、白糖替代 | 商业复合调味料不便入食材库，且非通用 |
| 麻婆豆腐 | 原方的「鸡汤 1 小碗」在菜谱步骤中写作清水/高汤，未列为食材 | 避免为一道菜的辅料新增一个定义 |
| 芹菜炒香干 / 香菇扒菜心 / 拍黄瓜 等 | 香干→`豆干`、干葱头→`洋葱`、青蒜→`小葱`、味极鲜生抽→`生抽`、南豆腐→`嫩豆腐`、干淀粉/水淀粉→`淀粉`、白砂糖→`白糖` | 沿用食材库既有定义（含其既有别名），不制造同名重复定义；对应关系写在菜谱食材行的 `note` |

### 使用但未入库的项

`水` / `清水` 不作为食材定义（无库存含义），仅在步骤中出现；
「烧烤料」「泡辣椒（源文写泡辣椒，本文用 `泡椒`）」等个别复合或方言名称按上表做了等价替换。

---

## 2. `content.json` 字段说明

### 顶层

| 字段 | 说明 |
| --- | --- |
| `version` | 内容包版本，当前 `v023-content-1`（导入时会写进菜谱备注） |
| `generated_at` | 整理日期 |
| `servings_note` | 全局份量说明：`按两人份家庭参考量整理，非原方精确份量` |
| `source_check_note` | 来源核对方式摘要 |
| `ingredients[]` | 食材定义（136 条） |
| `recipes[]` | 菜谱（30 道） |

### `ingredients[]`

| 字段 | 约束 |
| --- | --- |
| `name` | 定义名；导入时按 `normalizeName`（`trim().toLowerCase()`）判重 |
| `category` | **必须是数据库 `category` 表里已存在的分类名**（本包只用既有 19 个分类，不新建 / 改名 / 合并） |
| `allowed_units` | 必须是既有枚举 `个/克/千克/毫升/升/包/袋/瓶/盒/罐`；普通食材至少 1 个，调味品允许 0 个 |
| `estimated_shelf_life_days` | 未知一律 `null`，**不编造天数**；见下方说明 |
| `aliases` | 可空；与库中已有名称 / 别名冲突时会被跳过并记录原因 |

**136 条的构成**：124 条的元数据（分类 / 单位 / 保质期 / 别名）**直接沿用仓库既有的
`server/seed/builtin-ingredients.ts`**，保证同一食材在真实库里能按名称或别名复用；
12 条为本次新增：`食用油`、`大葱`、`豆豉`、`花椒粉`、`孜然`、`白芝麻`、`白醋`、`干辣椒`、
`小米椒`、`泡椒`、`油麦菜`、`菜心`。

**保质期口径**：沿用既有 seed 的条目，`estimated_shelf_life_days` 与 `builtin-ingredients.ts`
完全一致（如番茄 7、鸡蛋 30、生抽 365）；**12 条新增条目没有任何既有参考值，一律为 `null`**
（含 `食用油` 这类常识上"能量出天数"的项——本项目没有批准过的口径，就不写数字）。

### `recipes[]`

| 字段 | 说明 |
| --- | --- |
| `name` | 菜名（入库为 `recipe.name` / `name_normalized`） |
| `source_url` | 来源 URL，原样写进菜谱备注 |
| `verified` | 是否已按来源页核对（本包 30/30 为 `true`） |
| `servings_note` | 固定为 `按两人份家庭参考量整理，非原方精确份量`（导入器会校验，缺失即跳过该菜） |
| `note` | 与该来源的差异说明（替换、折算、等价食材） |
| `tags` | 只用**已有标签名**（0012 的 32 个系统预设或用户自建）；命中不到时不新建，只记录原因 |
| `ingredients[]` | `definition`（定义名或别名）/ `quantity`（数字，可为 `null`）/ `unit`（枚举）/ `note` |
| `steps[]` | 步骤正文数组，按顺序写为 `recipe_step.step_no = 1..n` |
| `synonyms`（可选） | 常见同义菜名，任一命中即视为已存在 → 跳过 |

**用量口径**：所有菜谱的主料都有可计算数字；调味品在确有来源量时给数字
（如麻婆豆腐的豆瓣酱、香菇扒菜心的蚝油），其余为 `quantity: null`，
交给项目的「用户确认跳过」路径处理——**绝不把「适量」编成数字**。

---

## 3. 幂等规则（导入器行为）

1. **名称解析**：`normalizeName = trim().toLowerCase()`，与 `src/services/normalize.ts` 同源（直接 import）。
2. **食材定义**：先按 `name_normalized` 命中 → 复用；再按 `alias_normalized` 命中 → 复用（记录
   `notes: definition_resolved_by_alias:*`）；都没有才新增（同时写 `ingredient_definition_unit`
   与 `ingredient_alias`）。
3. **别名**：新增定义时逐个检查，若该别名已被任何定义的**名称或别名**占用 → 不写，记入
   `aliases_skipped`（形如 `定义名 ← 别名（已被主名或其他别名占用）`）。
4. **分类**：只按归一名称查 `category`，查不到 → 跳过该定义并记入 `definitions_skipped`；
   **从不新建分类**。
5. **标签**：只按归一名称查 `recipe_tag`，查不到 → 记入 `tags_missing`，不建标签、不建关联。
6. **菜谱**：按归一菜名 + `synonyms` 判重，命中即记入 `recipes_skipped`（原因含「已存在同名或同义名」），
   **不覆盖、不 UPDATE、不 DELETE**；所有食材必须能解析，否则整道菜跳过
   （原因含「食材无法解析」）。`verified !== true` 的菜谱**默认跳过并报告**。
7. **单位**：先**过滤非法单位**（不在枚举内 → 拒绝该定义），再对合法单位 `Set` 去重，
   保证 dry-run 与 apply 的计数完全一致。
8. **只 INSERT**：全流程无任何 `UPDATE` / `DELETE`；**不写 `standard_ingredient`**（不引入虚构库存）。
9. **重复运行**：第二次运行必然 `definitions_added = 0`、`aliases_added = 0`、`units_added = 0`、
   `recipes_added = 0`、`tags_linked = 0`，`recipes_skipped` = 全部菜谱条目（各带「已存在同名或同义名」）。
10. **返回值**（统一核心 `importer.ts` 的结构）：

```ts
{
  dry_run: boolean,
  definitions_added, definitions_reused,
  definitions_skipped: string[],      // 「名称（原因）」
  aliases_added,
  aliases_skipped: string[],
  units_added,
  recipes_added,
  recipes_skipped: string[],          // 「菜名（原因）」
  ingredients_added, steps_added,
  tags_linked, tags_missing: string[]
}
```
> ⚠️ 旧版统计字段（数值型 `recipes_skipped`、`skipped_reasons`、`skipped_reason_counts`、`tags_reused`）
> **已不存在** —— 跳过项一律是**字符串数组**（附原因），请用 `.length` 计数量。

---

## 4. 导入步骤

### 4.1 先跑 dry-run（默认，不写库）

```powershell
cd D:\HomeChef\server
npx tsx seed/v023-content/import-v023-content.ts --db "C:\Temp\hc-copy\homechef-copy.db"
# 等价于显式 --dry-run；只打印统计，不写任何一行
```

### 4.2 真实导入（**已于 2026-10-16 由 Sol 在用户授权下执行完毕，本节为历史记录**）

> ⚠️ **不要再按本节对真实库盲目执行**：正式追加**已经完成** ——
> 先做了在线备份 `homechef-before-library-fill-2026-10-16T07-35-24-820Z-bd84ac09.db`，
> 再在**受保护事务**内实际新增 **108 个食材定义 / 29 道菜谱**（「番茄炒鸡蛋」因已存在同义菜谱「西红柿炒鸡蛋」按 `synonyms` 跳过）；
> 追加后 **337 定义 / 36 菜谱**；**正式库存仍 7 行、未被改动**；20 张表旧业务行逐字段保留；schema 与迁移历史未变；重复导入零变化。
> 如需**再次**导入新内容，请重新执行"备份 → dry-run → 事务"完整流程，不要直接复用旧命令。

历史步骤（当时实际执行的顺序，供未来参考）：

```powershell
# ① 备份（当时由 Sol 执行：SQLite 在线备份 + 完整性/业务表摘要核对）
#    产物：homechef-before-library-fill-2026-10-16T07-35-24-820Z-bd84ac09.db

# ② 确认真实库版本：已完成 0012（recipe_tag 有 category/code/is_system/sort_order）
#    本包不含迁移，也不修改 drizzle/**

# ③ 受保护事务内写入：调用 importer.ts 的 importRecipeContent(db, { dryRun: false })，
#    两包依次导入（content.json + content-extra.json）；CLI --apply 等价但走副本
```

> **注意（仍然有效）**：CLI 的 `--db` 必须通过 `src/db/safe-db-path.ts#assertSafeDbPath` 校验，
> 该校验**默认拒绝**真实库 `server/data/homechef.db` 及其 `-wal` / `-shm`；
> 本 CLI 也**不提供**放开该限制的开关（`allowRealDb` 恒为 `false`），且只接受**绝对路径**。
> CLI 不会启动任何服务，也不会自动连接 `data/homechef.db`。

### 4.3 在代码里调用（**推荐**：直连唯一核心实现）

```ts
import Database from 'better-sqlite3'
// ⚠️ importer.ts 是唯一核心实现（import-v023-content.ts 只是薄 CLI 入口 + 再导出）
import { importRecipeContent } from './seed/v023-content/importer.js'

const sqlite = new Database(dbPath)          // dbPath 必须先过 assertSafeDbPath
sqlite.pragma('foreign_keys = ON')
const stats = sqlite.transaction(() => {
  const a = importRecipeContent(sqlite, { contentPath: 'seed/v023-content/content.json', dryRun: false })
  const b = importRecipeContent(sqlite, { contentPath: 'seed/v023-content/content-extra.json', dryRun: false })
  return { a, b }
})()                                          // 抛错 → better-sqlite3 整体回滚
```

`importRecipeContent(db, options)` 的 `db` 可以是 **better-sqlite3 原生连接**，
也可以是 **drizzle 实例**（薄入口 `import-v023-content.ts` 会代为解包；直接调用核心时请传原生连接）；
函数内部不会自行开事务，以便调用方把整批导入包进同一个事务。`options.dryRun` **默认 true**（安全默认）。

### 4.4 回滚

导入只做 INSERT，回滚方式：恢复 4.2 ① 的备份副本。
（不要依赖"反向 UPDATE"；本包不提供迁移式回滚。）

---

## 5. 隔离测试（可复现）

```powershell
cd D:\HomeChef\server
$env:HOME_CHEF_TEST_DB_DIR = "C:\Users\<你>\AppData\Local\Temp\hc-v023-<随机>"
npx tsx seed/v023-content/verify-content-import.ts
```

脚本行为：

1. 在 `HOME_CHEF_TEST_DB_DIR`（未设置时用系统 tmp 新建独立目录）中建全新库，
   用 `server/drizzle/*.sql` 跑 drizzle migrator；
2. 写入「旧数据」：1 个自定义食材定义（`老王家秘制酱`，含 2 个单位与 1 个别名）、
   1 个自定义标签（`传家菜`）、1 道用户菜谱（`王家秘制酱蒸蛋`，含食材行 / 步骤 / 标签关联）、
   3 条库存行（500 克 / 250 毫升 / 100 克）；
3. 导入**两遍**，并对旧数据做**逐字段快照比对**；
4. 断言分类数、标签数、库存行数不变；标签全部命中已有标签。

实测结果（2026-10-16，`verify-content-import.ts`，系统 tmp 自建隔离库）：

```
第一遍：definitions_added 136 · aliases_added 94 · recipes_added 30 · recipes_skipped 0
第二遍：definitions_added 0   · aliases_added 0  · recipes_added 0  · recipes_skipped 30（全部为「已存在同名或同义名」）
旧数据：定义 / 单位 / 别名 / 标签 / 菜谱（含 content_revision）/ 菜谱食材行（含 line_key）/
        步骤 / 标签关联 / 3 条库存行 —— 全部逐字段一致；分类 19→19、标签 33→33
结果：PASS=46 FAIL=0（退出码 0）
```
> 注：统计结构已统一到核心实现 —— `recipes_skipped` / `definitions_skipped` / `aliases_skipped`
> 是**字符串数组**（取 `.length` 计数量），不再有旧版的 `skipped_reason_counts`。
> `verify-content-acceptance.ts` 另在**两包合并**场景实测：菜谱 **+29、跳过 1**（既有「西红柿炒鸡蛋」时「番茄炒鸡蛋」按 `synonyms` 跳过）。

CLI 行为实测（另一独立临时库）：

```
默认（不带 --apply）: DRY-RUN，两包合计 definitions_added 232 / recipes_added 30（或 29，视既有同义菜谱），未写库
--apply           : 两包合计写入 232 定义 + 30 菜谱（全新空 0012 库口径）
--apply（再来一次）: definitions_added 0 / definitions_reused 232 / recipes_added 0 / recipes_skipped 30
--db "data\homechef.db": 拒绝（非绝对路径），退出码 2
缺少 --db            : 拒绝（不会回退到 server/data/homechef.db），退出码 2
```

---

## 6. 未做 / 存疑

### 明确没有做的事

- **没有**读取、写入或枚举 `server/data/**`（真实库）—— 本内容包的开发与隔离测试全程未接触真实库，
  也**没有**由开发方对真实库运行过 CLI；
  **正式追加另由 Sol 在用户授权下完成**：在线备份 + 受保护事务内实际新增 108 定义 / 29 菜谱、
  库存未改动（详见第 4.2 节与实际结果）；
- **没有**修改 `server/src/**` 任何文件（只读引用 `normalize.ts`、`schema.ts`、`safe-db-path.ts` 的既有实现）；
- **没有**新增 / 修改迁移（`server/drizzle/**` 未改动）；
- **没有** git commit / push；
- **没有**写任何库存（`standard_ingredient`）行。

### 存疑项

1. `白芝麻` 归类到「干货/菌菇」（与 `枸杞`/`红枣` 同类），也可以考虑「调味品」；分类名必须先存在，故未新建分类。
2. 12 条新增定义的 `estimated_shelf_life_days` 一律 `null`（含食用油、白醋等），
   不是"漏填"，而是本项目没有批准过的口径就不写数字；若要补，应由你确认数值后另行 UPDATE。
3. `香菇滑鸡` 用蚝油/生抽/糖替代了市售浓缩调味料，口味与原方不会完全一致。
4. `麻婆豆腐` 的鸡汤、`水`/`清水` 未入食材库（只在步骤里出现）。
5. 用量均为两人份整理值；来源页大多只写「适量」，因此**不等于原方精确份量**
   （每道菜 `servings_note` 已固定写明）。
6. 「鸡蛋羹」的来源已按第 1 节替换，替换后的来源与菜名一致但作者/做法与原选来源不同。
