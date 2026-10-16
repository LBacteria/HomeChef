# HomeChef v0.2.3 交接文档（Tag 五分类 + 本地推荐算法优化）

> **生成时间**：2026-10-16（Asia/Shanghai）
> **生成者**：DSH（大肥鱼）
> **证据等级**：✅ 本次实际执行并取到输出｜📜 历史记录｜❓ 未验证
>
> ⚠️ **本文件不修改版本号、CHANGELOG、TECH_STACK.md，也没有提交 / 推送 / 打 tag。**
> ⚠️ **真实库 `server/data/homechef.db` 未迁移、未写入**：本轮全部测试都指向独立临时库；
> **未对真实库做任何内容 / 哈希核查**（唯一一次 `Get-FileHash` 尝试被自动审批拒绝，
> **没有取得任何哈希证据**，因此本文件不据此宣称任何"未变"结论）。详见 §8。

---

## 1. 本次做了什么（一句话）

在 v0.2.2 整餐推荐之上，补齐 **v0.2.3 后端全部规则**与 **前端标签 / 评价 / 推荐解释界面**：
Tag 五大固定分类（系统预设 + 自定义，可增改删）、单菜点赞点踩、烹饪历史降权、
每日确定性轮换、临期与库存利用率、标签化粗略搭配、不足方案缺口清单，
并修复 v0.2.2 审计发现的调味品 presence 漏洞与"跨单位相加"缺陷。

**不接入任何 AI / 网络请求；推荐路径仍然零写库存。**

---

## 2. 数据模型（迁移 `0012_v023_tags_preference.sql`）

### 2.1 `recipe_tag` 增补列

| 列 | 类型 | 含义 |
|---|---|---|
| `category` | TEXT NULL | 五大分类 code；**NULL = 未分类** |
| `code` | TEXT NULL UNIQUE | 系统预设的**稳定身份**（如 `dish_type.staple`）；自定义为 NULL |
| `is_system` | INTEGER NOT NULL DEFAULT 0 | 1 = 迁移播种的系统预设 |
| `sort_order` | INTEGER NOT NULL DEFAULT 0 | 预设展示顺序 |

索引：`recipe_tag_category_idx(category)`、`recipe_tag_code_unique(code)`。

**五大分类 code（固定，不可新增）**：
`dish_type` 菜品类型 · `flavor` 口味 · `cooking_method` 烹饪方式 · `meal_scene` 用餐场景 · `feature` 菜品特点

**系统预设 32 个**（`INSERT OR IGNORE` 播种，**绝不覆盖**用户同名 Tag）：
主食/荤菜/素菜/半荤半素/汤/凉菜/甜点；辣/麻辣/酸甜/清淡/咸鲜/蒜香/五香；
炒/煎/蒸/炖/烤/煮/炸/凉拌/焖/煲；早餐/午餐/晚餐/夜宵；快手菜/低脂/高蛋白/高纤维。

### 2.2 新表 `recipe_preference`

| 列 | 说明 |
|---|---|
| `id` | 主键 |
| `recipe_id` | **UNIQUE**，FK → `recipe(id)` ON DELETE CASCADE |
| `value` | `'like' \| 'dislike'`（CHECK 约束） |
| `created_at` / `updated_at` | 时间戳 |

**取消偏好 = 删除该行**（不写 `none` 占位）。只针对**单道菜谱**，不支持整餐评价。

### 2.3 旧数据兼容

- 旧 Tag 保持原 `id` / 原 `name` / 原关联，`category` 落 **NULL（未分类）**，界面单列一组；
  **不回填、不重命名、不删除**任何旧 Tag。
- 名称仍然**全局归一唯一**（`name_normalized` UNIQUE，跨分类也不允许同名）。
- 名称校验（长度 ≤ 60、非空白、拒控制字符）由 **Service 层统一**执行，
  数据库层**刻意不加** `category` 的 CHECK（SQLite 无法给已有表补 CHECK，且规则容易两边走偏）；
  `is_system` / `sort_order` / `code` 的约束与 drizzle schema **一致**。
- **迁移内不提供回滚指令**（早先草稿里的 `DROP COLUMN` 顺序不安全且从未验证，已整段删除）。

---

## 3. API 契约（v0.2.3 新增 / 变更）

### 3.1 Tag

```jsonc
// 新增：分类字典（**前端唯一来源**，不得另写中文字典）
GET /api/tag-categories
→ 200 {
  "categories": [
    { "code": "dish_type",       "label": "菜品类型" },
    { "code": "flavor",          "label": "口味" },
    { "code": "cooking_method",  "label": "烹饪方式" },
    { "code": "meal_scene",      "label": "用餐场景" },
    { "code": "feature",         "label": "菜品特点" }
  ],
  "unclassified": { "code": "unclassified", "label": "未分类" }
}

// 变更：返回体**增补字段**，原有 id / name / created_at 语义不变
GET /api/tags
→ 200 [{ id, name, category, code, is_system, sort_order, recipe_count, created_at }]

// 变更：category 可选（省略/null = 未分类），返回体仍是 { id }（兼容 v0.2.2）
POST /api/tags        { name, category? }            → 201 { id } / 400 / 409 DUPLICATE_NAME

// 新增：改名 / 改分类（部分更新，至少一个字段）
PATCH /api/tags/:id   { name?, category? }           → 204 / 400 / 404 / 409 DUPLICATE_NAME

// 不变：删除 Tag（保留菜谱本身）
DELETE /api/tags/:id                                 → 204 / 400 / 404
```

### 3.2 单菜偏好

```jsonc
GET /api/recipe-preferences
→ 200 [{ recipe_id, value: "like"|"dislike", created_at, updated_at }]

PUT /api/recipes/:id/preference   { "value": "like" | "dislike" | null }
→ 200 { recipe_id, value }        // null = 已取消
→ 400 / 404
```

> ⚠️ 单独接口，**不改变** `GET /api/recipes` 的返回结构，也**不改变列表排序**。

### 3.3 推荐

```jsonc
POST /api/recommendation/meal-plans
{ "people": 2, "tags"?: ["快手菜"], "tag_mode"?: "and"|"or" }   // v0.2.3 新增标签筛选
→ 200 {
  people, base_servings, multiplier, dish_count, ...,
  tag_filter: { tags, tag_mode, matched_recipe_count },       // v0.2.3
  history:    { window_days: 14, settled_meals, cooked_recipes }, // v0.2.3
  plans: [{
    plan_id, snapshot_id, level, score,
    score_breakdown: {                                        // v0.2.3 评分分项
      ready_bonus, coverage, utilization, expiring, structure, shared, diversity,
      missing_penalty, seasoning_penalty, unknown_penalty,
      stock_total, preference, history, rotation, total
    },
    signals: {                                                // v0.2.3 软信号明细
      preference, history, rotation, liked[], disliked[], cooked_recently[], repeated_meal
    },
    shortages: [{ definition_id, definition_name, unit, required_quantity,
                  available_quantity, missing_quantity, status, is_seasoning, note }], // v0.2.3
    dishes, requirements,
    summary: { ..., quantity_coverage, utilization, expiring_ratio,
               shared_requirement_count, structure_score, dish_roles[], feature_tags[] }, // v0.2.3
    reasons[]
  }],
  notes[]
}

// 不变：确认进入烹饪
POST /api/recommendation/apply   { people, dishes[], snapshot_id, request_id }
→ 200 { session_id, dish_count, people, expected_multiplier, snapshot_id, idempotent_replay? }
→ 400 / 404 / 409 SNAPSHOT_STALE / 409 IDEMPOTENCY_CONFLICT
```

**快照语义（重要）**：`snapshot_id` **有意不含**偏好、烹饪历史与标签筛选 ——
它们只影响**排序**，不影响「用什么、用多少」，因此改评价 / 改历史**不会**让用户已确认的用量失效；
但**配料数量、单位、相关库存、食材分类、临期设置、当天日期**任一变化 → `apply` 仍返回 **409**。
前端对**标签筛选变化**采取更严策略：直接作废旧结果并要求重新生成。

---

## 4. 算法与公式（全部集中在 `recommendationConfig.ts`）

### 4.1 权重

| 参数 | 值 | 说明 |
|---|---|---|
| `ready_bonus` | 1000 | 只有**真正 ready**（无主缺口 / 无缺调味品 / 无未知用量）才给 |
| `coverage` | 100 | 满足比例（条数口径） |
| `utilization` | 40 | **可用库存消耗比例**（减少浪费） |
| `expiring_each` | 12 | 每用到一项临期食材（v0.2.2 为 6） |
| `expiring_ratio` | 25 | 临期可实耗比例 |
| `diversity` | 8 | 食材分类 + 标签多样性 |
| `structure` | 1 | 结构搭配得分（分值内部已含系数） |
| `shared_each` | 6 | 被 ≥2 道菜共享的项（口径见 §4.3） |
| `missing_each` | 40 | 每缺一项主料 |
| `seasoning_missing_each` | 10 | 每缺一项调味品 |
| `unknown_each` | 8 | 每项「用量未指定」 |
| `preference_like_each` | +40 | 每道点赞 |
| `preference_dislike_each` | −80 | 每道点踩（**不排除**该菜） |
| `recently_cooked_each` | 120 | 每道近期做完的菜（按半衰期衰减） |
| `rotation_amplitude` | 15 | 每日轮换幅度 |

### 4.2 无量纲比率（**逐条需求算，再取平均** —— 绝不跨单位相加）

对**合并后**的每条需求（同 `definition_id` + **同单位**）：

```
quantity_coverage_i = min(需求, 可用) / 需求                       ← 需求满足比例（排序用）
utilization_i       = 满足时 需求 / 可用，缺口时 0                 ← 库存消耗比例（减少浪费）
expiring_ratio_i    = 满足且无未知用量时 min(需求, 临期可用) / 需求，否则 0
```

- `quantity_coverage = mean(quantity_coverage_i)`（无已知需求时为 1）
- `utilization = mean(utilization_i)`（缺口 / 调味品 / 未知 / 无需求 = 0）
- `expiring_ratio = mean(expiring_ratio_i)`
- **口径固定**：满足比例只在**同单位**上比较，因此「1000 克 + 1 个」与「1 千克 + 1 个」得到**相同**指标。

### 4.3 软信号

```
decay(days)       = 2^(−days / 7)          // 半衰期 7 天；days 夹到 >= 0（未来时间戳不产生加分）
history_penalty   = Σ −120 × decay(距今天数)  // 同一道菜只按最近一次算，不叠加次数
repeat_penalty    = −60 × decay(最近一次完全重合的 days_ago)
rotation          = (hash(today|signature) − 0.5) × 2 × 15 + repeat_penalty   // 无随机数
preference        = 40 × 点赞数 − 80 × 点踩数
```

- **烹饪历史口径**：只统计 `cooking_session.status = 'settled'` **且** `cooking_session_dish.status = 'done'`；
  放弃的会话、未完成的菜**一律不惩罚**。天数按**本地日历**计算（与前端一致），
  时间戳无效 → 跳过；落在未来 → 夹到 0 天（绝不产生负天数）。
- **轮换**：`hash` 是 FNV-1a 稳定哈希，同一天同一方案必然同值，**不写任何曝光记录**。

### 4.3b 共享奖励口径（Sol 审查项，已按此实现并加测试锁定）

`shared_requirement_count` **只**统计**同时满足下列全部条件**的合并需求：

1. 以**合并键**（`definition_id` **+ 单位**）为口径，出现在 **≥2 道不同菜谱**里
   —— 同一道菜里的重复行**不算**跨菜共享；
2. 该需求是**非调味品**（调味品 presence-only，没有可比数量，不给共享奖励）；
3. 该需求**没有未知用量**；
4. 该需求**已被满足**（缺料 / 单位不匹配 → **0**，绝不给"库存不足奖励"）；
5. 计数按**需求**计，不按菜数计（三道菜共享同一需求仍只算 1）。

> 同一种定义但**单位不同**（1 个 vs 1 克）**不能**互当共享（合并键不同）。

### 4.4 排序（硬档在前，软评分只在最后）

```
① level_rank         : ready(0) < nearly(1) < missing(2)
② main_missing_count : 主料缺口少者优先
③ quantity_coverage  : **分桶（0.05 一档）**后高者优先
④ soft_total         : 偏好 + 历史 + 轮换
⑤ signature          : 完全确定
```

- **候选 40 截断之前**已计入「单菜偏好 + 历史」（`compareCandidateOrder`），
  避免偏好只作用在最后导致失效。
- top-N 的贪心只在**同一档**（等级 + 主缺口 + 覆盖分桶完全相同）内比较，
  因此重叠惩罚 / 软评分**不会**把"库存更缺"的方案顶到前面。
- ⚠️ 排序**必须**用 `quantity_coverage` 而**不是** `utilization`：
  后者在库存越缺时反而可能越大，会造成「越缺越优先」的反向偏好。

### 4.5 结构调整（`STRUCTURE_SCORE`，标签层面粗略搭配，**不是营养计算**）

- 每多一种不同菜品类型 +12；同时有荤（或半荤半素）与素 +10；有主食 +8；有汤或凉菜 +6；
- **全是主食 −60**（至少避免全主食）；全是荤菜 −30；每个不同「菜品特点」标签 +3（最多 4 个）；
- **标签缺失时全部为 0**（正常降级，不惩罚）。
- 结构语义按 `resolveDishRole` 判定，**顺序不可颠倒**：
  1. **先要求 `category === 'dish_type'`** —— 分类是用户可见的归属；
     把预设**改成别的分类或清空成未分类** → **立即停止类型推断**（界面本就不再当它是菜品类型，
     否则会产生"看不见的隐形类型"加分）；
  2. 仍是 `dish_type` 时，优先按**稳定 `code`** 判定 → **重命名**预设不影响结果；
  3. 仍是 `dish_type` 但无 `code`（用户自建）→ 按名称回退；
  4. 都解析不出 → 该菜不计入结构搭配（正常降级，不惩罚）。
  ⚠️ 例外：`rolesOfDish` 在**完全没有 `tag_refs`** 时（纯函数单测/兼容路径）
  仍按名称直接回退 —— 那条路径没有分类信息可用，与本规则不冲突。

### 4.6 保留的 v0.2.2 硬规则（未改动）

先合并跨菜 / 菜谱内重复配料再比库存 · **单位必须完全相同、绝不换算** ·
未知用量不计入「够用」且不判 ready · 过期库存一律不计入可用（但仍报告） ·
调味品 presence-only · 确定性与可复现 · 推荐路径零写入。

### 4.7 本次修复的两个 v0.2.2 缺陷

1. **调味品 presence**：旧实现用 `lots.length > 0`，导致**只剩过期批次**的调味品也被判「有」
   （与"过期不可用"自相矛盾）。现改为「存在**任一未过期**批次才算有」，
   并保留 `quantity = 0` 未过期批次仍算「有」的语义。
2. **跨单位相加**：旧实现累加 `sumRequired / sumSatisfied / sumExpiringConsumed` 再相除，
   1000 克会压过 1 个。现改为**逐条需求算比率再平均**。
3. 同 key 混有「未指定用量」时，**不再**声称消耗临期、也**不**计入库存利用率与共享奖励。

---

## 5. 前端改动

| 文件 | 内容 |
|---|---|
| `types/api.ts` | Tag 分类 / 字典 / 偏好、推荐评分分项 / 软信号 / 缺口类型 |
| `api/tags.ts` | `getTagCategories` / `createTag(name, category)` / `updateTag` / `deleteTag` |
| `api/recipes.ts` | `listPreferences` / `setPreference` |
| `api/recommendation.ts` | `getMealPlans(people, tags, tagMode)` |
| `components/TagPicker.tsx`（新） | 按后端字典分组的分类多选 + 就地新建（含分类）+ 跳转管理 |
| `components/TagManagerModal.tsx`（新） | 五分类下改名 / 改分类 / 新建 / 删除（**删除前展示关联菜谱数并确认**） |
| `components/PreferenceButtons.tsx`（新） | 喜欢 / 不喜欢 / 取消；同步互斥防连点；失败明确报错；**不乐观改写状态** |
| `components/TagSelectDialog.tsx` | 改为复用 `TagPicker`（分组 + 分类新建 + 管理入口），保留草稿语义与 AND/OR |
| `components/RecipeCreateForm.tsx` | 标签多选改为分类分组、可就地新建、**无固定数量上限** |
| `components/RecipeDetailView.tsx` | 新增「我的评价」区块；标签按分类分组展示 |
| `pages/RecipesPage.tsx` | 加载分类字典与偏好；「管理标签」入口；**改名/删除后同步筛选条件与持久化设置** |
| `pages/RecommendPage.tsx` | 标签筛选（弹窗复用）；评分分项与缺口清单展示；每道菜评价；**筛选/评价变化立即作废旧结果并重新生成** |
| `styles.css` / `recommend.css` | 上述组件样式 + 窄屏适配（420px 纵向堆叠，不横向溢出） |

**筛选一致性要点（易踩坑）**：列表设置里存的是 Tag **名称**。
改名后若不同步，会筛到一个不存在的名字 → 空列表；重新保存菜谱时甚至可能"复活"旧名。
`RecipesPage` 的 `applySelectedTags()` 统一保证「界面 + 列表请求 + 持久化」三处同时更新。

### 5.1 首轮前端审查后的修正（Sol review）

1. **草稿不再丢失**：从「新建 / 编辑菜谱」里点「管理全部标签」时**不再关闭表单**
   （旧实现 `setCreateOpen(false)+setEditing(null)` 会让名称 / 配料 / 步骤 / 标签草稿全部蒸发）。
   管理弹窗通过 `.tag-manager-backdrop { z-index: 200 }` 盖在表单之上，关闭后自然回到原草稿。
2. **标签改名 / 删除的三处同步**：`handleTagRenamed` / `handleTagDeleted` 现在
   **无条件**更新 ① 当前详情 ② 编辑器草稿 ③ 筛选与持久化设置
   （旧实现 `if (!selectedTags.includes(...)) return` 会漏掉前两处 →
   打开详情→改名→再编辑保存会**自动重建旧标签**）。
   编辑器侧通过**单次事件** `TagMutation{kind,token}` **只 remap / filter `selectedTags`**，
   名称、配料、步骤等未保存内容一律不碰；用 token 去重，避免重挂载重复应用。
3. **真正的同步互斥锁**：`PreferenceButtons` 改用 `useRef` 锁，在 `await` **之前**置位、
   `finally` 释放（与 `applyLock` / `submittingRef` 同一模式）；
   `TagManagerModal` 增加全局忙碌锁 + `lockRef`：创建 / 改名 / 改分类 / 删除在途时
   禁止切换编辑行、关闭弹窗或再次新建。
4. **加载失败必须可见、可重试**：
   - 偏好加载失败 → `prefReady=false`，详情页显示错误 + 重试，
     评价控件**禁用**（绝不把"未知"当成 `null`，否则点「取消评价」会覆盖真实偏好）；
   - 分类字典加载失败 → 记录 `tagDictError`，`TagPicker` 顶部明确说明
     「分类字典加载失败（…），下面暂按未分类展示」并提供「重新加载分类」，
     不再静默把所有标签显示成"未分类"。
5. **推荐页与菜谱页对齐（Sol 最终复核）**：`RecommendPage` 此前对
   `listPreferences` / `getTagCategories` 的失败是**静默 catch**，评价按钮只 `disabled={applying}`。
   现改为与菜谱页同一套语义：
   - 偏好加载失败 → `prefReady=false` + 明确错误 + 「重试」，
     评价控件**禁用**（未知 ≠ 无评价）；分类字典失败 → `dictError` 透传给
     `TagSelectDialog`/`TagPicker` 显示错误并重试；
   - **评价写入期间的整页同步锁**：新增 `prefWriteLock`（`useRef`，`await` 前置位、
     `finally` 释放），在途时**禁止确认 apply 与换方案** ——
     绝不能在评价尚未保存时就创建"旧方案"的烹饪会话；
   - **成功**才作废旧结果并**真正重新生成**；**失败保留原结果**，
     页面与按钮同时显示错误，**不自动重试**写操作（原有幂等与"网络结果不明"
     的处理逻辑保持不变）；
   - `invalidateForFilterChange` 增加 `plansSeq.current++`：让**在途的旧推荐请求**
     自行作废，具备完整失效语义，而不只是依赖界面禁用。

---

## 5.5 隔离演示种子 `server/seed/seed-v023-demo.ts`（安全体验入口）

想**看效果又不碰真实库**时用它：生成一个全新的临时库并播入足够演示 v0.2.3 全部特性的数据。

```powershell
cd D:\HomeChef\server
# 父目录需先存在，目标文件必须**不存在**
New-Item -ItemType Directory -Force "$env:TEMP\homechef-v023-demo" | Out-Null
node --import tsx seed/seed-v023-demo.ts "$env:TEMP\homechef-v023-demo\demo.db"

# 窗口1：用这个临时库起一个**隔离后端**（不要用正式端口/正式库）
$env:HOME_CHEF_DB_PATH = "$env:TEMP\homechef-v023-demo\demo.db"
$env:PORT = '3010'
Remove-Item Env:HOME_CHEF_ALLOW_REAL_DB -ErrorAction SilentlyContinue
node --import tsx src/server.ts

# 窗口2：隔离前端指向它
cd D:\HomeChef\client
$env:HOME_CHEF_API_TARGET = 'http://127.0.0.1:3010'
npm run dev -- --host 127.0.0.1 --port 5180 --strictPort
# 打开 http://127.0.0.1:5180/
```

**种子内容**：7 个食材定义 · 6 道菜谱（覆盖荤/素/半荤半素/汤/甜点 + 炒/炖/蒸/煮）·
7 条库存（含**临期**鸡蛋/猪肉与**已过期**牛奶，青椒刻意偏少以演示缺口）·
**32 个系统预设 + 2 个自定义标签**（其中一个未分类）·
**喜欢 1 道 / 不喜欢 1 道** · **3 个已结算会话 + 1 个放弃会话**（验证"放弃不惩罚"）。

**安全保护（与 `seed-v022-demo.ts` 同一套，不得放宽）**：
① 只认**绝对路径**且先过 `assertSafeDbPath`；② **拒绝覆盖**已存在文件；
③ 显式拒绝真实库路径；④ 父目录必须已存在；⑤ **绝不设置** `HOME_CHEF_ALLOW_REAL_DB`；
⑥ **不启动任何服务、不打开浏览器**。
⚠️ **绝不能为了演示去迁移或写入真实库**。

**本次实测**（✅ 实际执行）：种子脚本执行成功（`食材定义 7 · 菜谱 6 · 库存 7`，
`标签 34（预设 32 / 自定义 2 / 未分类 1）`，`喜欢 1 · 不喜欢 1`，
`settled 3 个会话 / 计入完成 4 道（另有 1 个放弃会话不惩罚）`）；
相对路径 / 已存在文件 / 父目录不存在三种情况**均按预期拒绝（exit 1）**。
随后在**隔离端口 3010** 上对该演示库做了一次真实接口冒烟：

| 检查 | 实测结果 |
|---|---|
| `GET /api/tag-categories` | 5 类，中文 label 全部来自后端 |
| `GET /api/tags` | total 34 = preset 32 + custom 2 |
| `GET /api/recipe-preferences` | `3:dislike`、`6:like` |
| `POST meal-plans {people:2}` | 5 套方案；`history` 命中 4 道菜 / 3 餐 |
| 首选方案软信号 | `liked=[6]`、`cooked_recently=[1,5,6]`、`history=−329.159657348217` |
| 衰减核对 | 今天 2 道（2×120=240）+ 3 天前 1 道（120×2^(−3/7)=89.16）≈ **329.16** ✅ |
| 评分分项 | `utilization/expiring/structure/shared` 均有非零值 |
| `tags:["快手菜"]` 筛选 | `matched_recipe_count=2`，方案只含「番茄炒蛋 + 青椒炒蛋」 |
| 收尾 | 进程已杀，`3010` 无监听；临时目录已清理 |

---

## 6. 实际测试证据 ✅（全部使用隔离临时库 / 临时目录，未触碰真实库）

| 命令（`server/` 目录） | 结果 |
|---|---|
| `node --import tsx verify-v023-tags-preference.ts` | **PASS=134 FAIL=0**（exit 0）｜⚠️ 评审收尾新增 R1/R8/R3/R4 与 R2/零需求/调味确认用例后为 **173/0**（见文末《评审收尾实施》与《测试计数口径》） |
| Sol 独立纯算法 `work/sol-v023-pure.cjs` | **14/14 PASS**（含 5 项此前失败的边界 + 预设改分类停止推断） |
| `node --import tsx verify-v022-recommendation.ts` | **PASS=127 FAIL=0** |
| `verify-recipe-batch1.ts` | **83/0** |
| `verify-recipe-batch2.ts` | **103/0** |
| `verify-recipe-batch3.ts` | **106/0** |
| `verify-v0211-cooking-records.ts` | **65/0** |
| `server`：`npx tsc --noEmit -p tsconfig.json` | **exit 0** |
| `client`：`npx tsc --noEmit -p tsconfig.json` | **exit 0** |
| `client`：`npm run build` | **exit 0**（`71 modules transformed`，产物 288.01 kB js / 48.31 kB css） |

> ⚠️ 旧脚本默认 dataRoot 是 `server/data`。本次回归**显式**设置
> `HOME_CHEF_TEST_DB_DIR=<临时目录>` 后才运行，避免把测试库写进受保护目录。

### 6.0 Sol 最终后台验收（**以下为 Sol 亲自执行的结果，不是 DSH 的自测**）

Sol 复核时点的仓库测试 —— **合计 708 全部通过**：

| 脚本 | 通过 |
|---|---|
| `verify-v023-tags-preference.ts` | 129 |
| `verify-v022-recommendation.ts` | 127 |
| `verify-v0211-cooking-records.ts`（记录） | 65 |
| `verify-recipe-batch1/2/3.ts`（菜谱） | 83 / 103 / 106 |
| `verify-v012-settings-expiry.ts`（设置） | 68 |
| `verify-recipe-transaction-rollback.ts`（事务） | 27 |
| **小计** | **708 / 708** |

Sol 独立测试（不复用仓库断言）—— **合计 48 全部通过**：
纯算法 14 · HTTP 26 · 跨日轮换 2 · Drizzle 升级 2 · demo 4。

> ⚠️ 数字口径说明（避免误读）：
> - Sol 验收时点的 v023 是 **129** 项；**其后**我又追加了
>   共享奖励 7 项边界（A17f–A17l）、迁类停止推断 3 项（A7d/A7e/B16×3）等，
>   因此**当前仓库** v023 是 **134** 项（上表已按当前值列出）。
> - `verify-recipe-transaction-rollback.ts` 的**预设兼容改动由 Sol 本人完成**
>   （把"固定全表 1 个 tag"改为"比较事务前后完整 tag 表内容"，27/27 通过），
>   DSH **未编辑**该文件，仅保留。
> - `verify-recipe-batch1.ts` 的 4 处预设感知最小适配由 DSH 完成（见 §6.1）。

v023 测试覆盖（134 项）包括：五分类字典与预设 code 漂移检查、
结构语义**分类优先**判定（**重命名保留 / 迁类或清空分类后停止推断并结构降级**，
纯函数 A7b–A7e + 接口层 B16）、调味品仅过期批次不算可用、跨单位尺度不变性、
库存消耗比例区分浪费、混合未知量不虚报、
**共享奖励 7 项边界**（同菜重复行 / 缺料 / 单位不同 / 含未知量 / 调味品 / 正例 / 三菜计 1）、
缺口清单、Tag CRUD 与名称统一校验（含**菜谱统一保存入口绕过测试**）、偏好 CRUD、
软信号与历史半衰期、轮换确定性与重复组合衰减、排序硬档优先级、
快照对偏好/历史变化不失效 / 对配料变化必须 409、幂等回放、推荐零写入。

### 6.1 对既有测试的最小适配（**不是弱化**）

`server/verify-recipe-batch1.ts`（v0.2.0 旧脚本，受版本库跟踪）原本断言
「空库 `/api/tags` 返回空数组」「只返回 2 个 Tag」。v0.2.3 会播种 32 个系统预设，
该前置不再成立，因此做了 **4 处最小适配**：

1. 「空库返回空数组」→「空库**只有系统预设**、无任何用户自建 Tag」（**更具体**，仍拦住用户态泄漏）；
2. 「返回 2 个 Tag」→「返回 2 个**用户自建** Tag」（原意图不变）；
3. Tag 名称断言改为只看用户自建部分；
4. 「删除菜谱不删 Tag」→ 统计 `is_system = 0` 的用户自建 Tag 仍为 2。

**没有删除任何断言、没有跳过失败、没有改动其他业务语义验证。**
另：预设清单中删除了我最初自行加入的「家常菜」（**不在确认规格内**，
且与既有夹具同名冲突）；规格要求的五类预设全部保留。

---

## 7. 已知限制与未验证项 ❓

1. **真实库未迁移**：`server/data/homechef.db` 仍是 v0.2.2 结构（无 `category` 等列）。
   用户正式启动前需自行执行迁移（见 §8），**DSH 未代劳**。
2. **前端只做了类型检查与构建**，**没有浏览器 E2E**（本轮明确不打开浏览器/不启动正式服务）。
   交互正确性（键盘可达、窄屏布局、评价后重新生成的真实观感）**待 Sol 独立验收**。
3. **推荐排序的可解释性做了服务端分项**，但前端「评分依据」面板只做静态展示，未做数值编辑。
4. **`utilization` 语义变更**：v0.2.3 中 `utilization` = **可用库存消耗比例**（减少浪费），
   新增 `quantity_coverage` = **需求满足比例**（排序用）。字段名与 Sol 独立测试
   （断言 `utilization` 能区分"用一点点 / 用掉大半"）一致；若下游另有期望请告知。
5. **幂等仍是进程内有界缓存**（v0.2.2 原样保留）：重启 / 淘汰 / 多实例失效，
   前端**禁止自动重试**写操作。
6. **全局两人份假设**、候选 40 截断、组合 20000 上限（v0.2.2 原样保留）。
7. **历史口径**：只要「会话 settled 且该菜 done」就算做过；用户只"打开没做"的菜不会被计入，
   但**已 settlement 的会话即便之后被批量删除记录**，历史也随之消失（符合"清理历史"语义）。

---

## 8. 真实库与安全边界

- `server/data/homechef.db` **未被读写**：本轮全部验证都通过 `HOME_CHEF_DB_PATH` /
  `HOME_CHEF_TEST_DB_DIR` 指向**全新独立临时库**；**未设置** `HOME_CHEF_ALLOW_REAL_DB`；
  **未执行** `db:migrate`。
  （按当前边界要求：**不对真实库做任何内容 / 哈希核查**，故此处不给出哈希。）
- 未 commit / push / tag / rebase / 历史改写；未改版本号、CHANGELOG、TECH_STACK.md；
  未改动 14 个受保护诊断脚本中的任何一个。

### 记录：一次测试隔离配置遗漏（已纠正，不需要清理）

本轮**早期**（09:29）我在运行 `verify-recipe-batch1.ts` / `verify-recipe-batch2.ts` 时
**漏设 `HOME_CHEF_TEST_DB_DIR`**，而这两个旧脚本的默认 dataRoot 正是 `server/data`，
因此在该目录下产生了 4 个测试库文件（`recipe-b1-*.db{,-shm,-wal}`、`recipe-b2-*.db`）。

- 这只是**生成了临时测试库**，与「真实库被修改」是两件事，**不能据此推断真实库被动过**；
- 按当前要求：**不做真实库核查，也不清理 `server/data` 下任何文件**，此处**仅作记录**；
- ✅ **已纠正的流程约束**（后续一律遵守）：
  1. 任何测试**先**显式设置 `HOME_CHEF_TEST_DB_DIR=<全新独立临时目录>`；
  2. 使用 `HOME_CHEF_DB_PATH` 时**先过 `assertSafeDbPath`**；
  3. **绝不设置** `HOME_CHEF_ALLOW_REAL_DB`。

### 待处理（**保留**，不清理）

以下 4 个文件是本轮测试生成的临时库，**保持原样、不删除**（真实库 / 备份 / 受保护脚本一律不动）：

```
server/data/recipe-b1-1792114177251.db
server/data/recipe-b1-1792114177251.db-shm
server/data/recipe-b1-1792114177251.db-wal
server/data/recipe-b2-1792114182158.db
```

> ⚠️ 关于"真实库未变"的证据边界：本轮**没有任何**关于真实库的实测证据 ——
> 唯一一次 `Get-FileHash` 尝试被审批拒绝，**没有产出哈希值**。
> 因此本文件**只在"所有测试都指向独立临时目录"这一层**陈述隔离事实，
> **不声称**真实库的字节或哈希状态。需要该结论时，应由用户在允许的方式下自行核对。

### 用户自行启动步骤（DSH 不代劳）

```powershell
# 窗口1：后端（迁移后才会创建 v0.2.3 的新列/新表）
cd D:\HomeChef\server
$env:HOME_CHEF_DB_PATH = 'D:\HomeChef\server\data\homechef.db'
$env:HOME_CHEF_ALLOW_REAL_DB = '1'      # 迁移真实库需要这条一次性授权
npm run db:migrate
Remove-Item Env:HOME_CHEF_ALLOW_REAL_DB

# 窗口2：前端
cd D:\HomeChef\client
$env:HOME_CHEF_API_TARGET = 'http://127.0.0.1:3002'
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

---

## 9. 下一轮建议

1. Sol 对前端做独立浏览器验收（重点：标签管理改名/删除后筛选同步、评价后推荐确实重新生成、
   窄屏与键盘可达、评分依据面板可读性）。
2. 决定是否需要一个"历史 / 偏好不参与快照"的产品说明页或帮助文案。
3. 版本号、CHANGELOG、tag 全部留给用户与 Lumi 决定（DSH 未改动）。
4. 若未来要把 `verify-recipe-batch1/2/3` 等旧脚本纳入统一回归入口，
   可顺手把它们的默认 dataRoot 从 `server/data` 改为**强制要求 `HOME_CHEF_TEST_DB_DIR`**
   （本次只记录，未改这些脚本的目录逻辑）。

## Sol 最终复核补记（2026-10-16，Asia/Taipei）

- DSH 最后一轮新增测试后，Sol重新运行 `verify-v023-tags-preference.ts`：**134通过、0失败**；八组仓库验证最终共 **713通过、0失败**。此前708是v023尚为129项时的验收快照，不是当前总数。
- Sol独立验收最终 **48/48通过**：算法14、HTTP26、跨日轮换2、Drizzle增量迁移2、演示种子与保护4。
- Sol补充两处推荐页并发保护：筛选失效时同步释放加载态；评价写入入口同时检查确认锁与偏好已加载状态。最终再次 `npm run build` 通过，`git diff --check` 通过。前后端单独 `tsc --noEmit` 亦已通过。
- `server/verify-recipe-transaction-rollback.ts` 是Sol的必要测试维护：比较事务前后完整标签表（含预设），27/27通过。
- Git HEAD仍为 `2f9f6dcd5d65db50de69f3910bf6a0342d200ac7`，没有提交、推送、暂存或修改版本号。21个受保护源码/版本/文档文件与开工内容摘要一致。
- 本轮**没有浏览器交互、窄屏、键盘实测**；前端结论限于代码审查、类型检查与生产构建。真实数据库未执行本次迁移，不代表已经正式部署。
- 请优先使用§5.5隔离演示库体验。§8真实库迁移命令仅可作为**未来另获用户批准后的参考**，不属于本轮授权操作。早期测试目录配置遗漏和四个测试产物已如实记录，不读真实库内容/哈希、不清理历史库或备份。

## 后续授权：真实数据库迁移已完成（2026-10-16，Asia/Taipei）

用户在推荐报错后明确授权先备份、核查并迁移真实数据库。已执行 `0012_v023_tags_preference`，不再是“真实库未迁移”的状态；此前未迁移的描述保留为验收时点记录。

- 备份：`D:\HomeChef\server\data\backups\homechef-before-v023-2026-10-16T02-15-26-042Z-a48f7f0e.db`。通过SQLite在线备份生成，完整性与原库业务表摘要核对通过。
- 迁移前后18张原有业务表数据摘要一致；9个旧标签身份、名称与关联保留，新增32个系统预设后共41个标签；库存、菜谱和烹饪历史未被迁移改变。
- 迁移后数据库 integrity_check 与 foreign_key_check 均通过。
- 在真实数据库的 `query_only` 连接上，使用实际Fastify路由做进程内注入验证：标签接口200，推荐接口200，7道候选菜谱生成5套方案。未创建烹饪会话或扣库存。
- 检查时HomeChef正式服务未在常用端口运行；3001为其他服务且未操作。未启动软件、浏览器或正式服务；用户自行重新启动后体验。
- 没有提交、推送、修改版本号或CHANGELOG。

## 评审收尾实施（R1 / R8 / R3 / R4；R2 待决策）—— DSH，2026-10-16

> 授权范围：外部评审报告的 **R1/R2/R3/R4/R8**（**R5/R6/R7/R9 未做**）。
> 未 commit/push/tag，未改版本号/CHANGELOG/TECH_STACK，未启动正式服务、未开浏览器，
> 未访问真实库；全部测试使用 `HOME_CHEF_TEST_DB_DIR` 指定的**系统临时目录**。

### R1 统一「逐行缩放舍入再合并」（新口径唯一实现处）

- 新增 `quantity.ts` → `scaleLineQuantity(quantity, servings)`
  = `quantity === null ? null : roundQuantity(quantity × servings)`。
- 接入 `recommendationAlgorithm.ts`（合并需求时**逐行**调用）与
  `settlementService.ts:collectDemands`（等价改写为同一函数）。
- 效果：`0.001 / 0.019`（`servings=0.5`、库存 `0.010 千克`）
  **两种配料顺序都得 `0.011`** → 推荐与结算**同时**判「不够」；
  修复前 `0.010`（误判 ready）/ `0.011` 取决于**行顺序**。不引入 Decimal。

### R8 显式 0 = 零需求

`evaluateCombination` 用 `has_known_line` / `has_unknown_line` 区分：
有具体数量且合计 0 → `ok` + `required_quantity: 0` + 「用量为 0，按零需求处理」+ 不占库存 + 不拿共享奖励；
只有 `null` 行或 `0+null` 混合 → 仍 `unknown_quantity` 且**不得 ready**。

### R3 临期收益按结算同款 FEFO 实际分配

- `StockLotInput` 增 `lot_id` / `expiry_date`，`buildStockIndex` 填充。
- 新增纯函数 `fefoCompare`（有到期在前 → `expiry_date` 升 → `lot_id` 升，与结算 SQL 排序一致）
  与 `allocateByFefo`；`expiring_ratio` / `used_expiring` / `expiring_used_count`
  只统计**真正被扣到**的临期批次。
- 反例已修复：`normal`(10-18) + `expiring`(10-20)、需求 50 → **实际临期消耗 0**。
- 附带更正：**调味品 presence-only 不再声称消耗临期**（结算不按量扣，收益无法兑现）。

### R4 预览：库存副本 + 真实顺序 + FEFO

- `previewSettlement` 不再逐行取全量可用；改为**内存副本**按需求顺序做 FEFO 分配，
  `available_quantity` = 处理到该行时的**剩余**量；跳过项（已确认 `user_choice`/`null_quantity`/`unit_mismatch`、
  以及 `quantity === null`）**不占库存**。
- 新增 `items[].skipped` 与顶层 **`stock_sufficient`**；`ready` 明确为「**待确认项 0**」，
  与「库存充足」**分开**。**预览绝不写库**。
- 前端同步：`types/api.ts`（新增字段 + 注释）、`CookingPage.tsx`
  （状态列区分「已跳过（不扣库存）/需确认/可扣减/库存不足」；`!stock_sufficient` 时禁用结算按钮并提示**合计**不足）。

### R2 已实现（**无迁移**，Sol 已审核批准该路径）

现有 `SETTLEMENT_OUTCOMES`（`consumed`/`skipped_null_quantity`/`skipped_unit_mismatch`/`skipped_user`/`insufficient`）
**没有**任何取值能真实表达「调味品已备、不按量扣减」，而它正是结算明细 `outcome` 的 CHECK 来源 →
新增取值**需要重建表迁移**。本轮**既未伪造 `skipped_user`，也未把正需求写成 `consumed` 且实际 0**。

- **已实现（方案 A，无迁移）**：把「同单位 presence 哨兵」的调味品行纳入**必需确认**
  （复用既有 `user_choice`），用户确认后记 `skipped_user`（语义真实）。
  代价：`requiredSkipsOf` / `confirmed_revision` 行为变化 + 前端多一步确认 + 既有测试同步。
- **（未采用）方案 B**：新增专用 outcome（如 `seasoning_presence_only`），
  重建 `cooking_settlement_item` 并保留旧凭证 + 扩展 API 结果枚举；**真实库迁移须另行授权**。

### 本轮实测（全部隔离临时库；实际执行）

| 命令 | 结果 |
|---|---|
| `verify-v023-tags-preference.ts` | **173 / 0**（+R1×4、R8×4、R3×5、调味品×2、B17×8、R2/R8 边界 B18×7、验收点 A49–A52、调味确认 B19×5） |
| `verify-v022-recommendation.ts` | 127 / 0 |
| `verify-recipe-batch1/2/3.ts` | 83 / 103 / 106 |
| `verify-v0211-cooking-records.ts` | 65 / 0 |
| `verify-v012-settings-expiry.ts` | 68 / 0 |
| `verify-recipe-transaction-rollback.ts` | 27 / 0 |
| Sol 独立纯算法 `work/sol-v023-pure.cjs` | 14 / 14 |
| server / client `tsc --noEmit` | 0 / 0 |
| client `npm run build` | exit 0 |

→ 仓库八组合计 **752 / 0**（= 173 + 127 + 83 + 103 + 106 + 65 + 68 + 27；口径与依据见文末《测试计数口径》）。
→ Sol 独立验收（`work/sol-v023-fix-acceptance.cjs`，Sol 自跑）**12 / 12**；
   Sol 独立纯算法 14/14；server `tsc --noEmit` **0**；`git diff --check` **0**。

覆盖要求矩阵：精度半值 / 奇数人数（`servings=1.5`）/ 重复行 / **排列不变**；
`0` / `null` / `0+null` / 缩放为 0；调味品有无、同异单位、`0` 与正数、过期；
percentage FEFO 反例 / 混合批次 / 默认过期排除；**共享不足**、跳过项不占库、
推荐零写入、**预览零写入**（B17f）、**结算回滚**（B17h）、
**推荐→apply→done→preview→settle 一致性**（B17 全节）。

### 仍未做 / 风险

- R2 **已实现**（无迁移）；F2/F3/F5/F6/F7 均未动。
- 前端只有类型检查与生产构建，**无浏览器 E2E**。
- 真实库的 v0.2.3 迁移此前已由用户在授权后完成（见上一节）；**本轮没有对真实库执行任何操作**。

## 内容扩充包（v0.2.3 第二包：食材定义）—— DSH，2026-10-16

### 交付
- `server/seed/v023-content/content-extra.json`：**96 个常用食材定义**（名称/分类/可用单位/别名，`estimated_shelf_life_days` 一律 `null`）。
  规划方式：用户候选 195 → 与 `work/existing-definition-names-for-content.json`（229 定义 + 144 别名）及 `content.json` 自身去重 → 可新增 155 → 精选 96，**不制造同义重复**。
- 分类只用数据库已有 19 类（含 `主食/谷物`、`干货/菌菇`、`其他/饮品`）；单位只用既有枚举（个/克/千克/毫升/升/包/袋/瓶/盒/罐）——初稿里的 `只/条/块` 已修正（否则会被导入器正确拒绝）。
- 菜名同义名仅作为**判重说明**记录在 `recipe_aliases`（番茄炒鸡蛋/西红柿炒鸡蛋/番茄炒蛋 等），**不写库、不改已有菜谱**。
- 未加"低脂/高蛋白/高纤维"等营养特征标签（无营养核定）；保留类型/口味/工艺/场景/快手既有标签。

### 预计真实库新增
`content.json` 的 136 项中 124 项已存在 → 新增 12；`content-extra.json` 的 96 项已按排除清单过滤 → 新增 ≈ 96。**合计预计真实新增 ≈ 108 项**（Sol 已备份、由其执行真实导入）。

### 隔离验收（两次都真跑，`HOME_CHEF_TEST_DB_DIR` → 系统 tmp）
| 脚本 | 结果 | 要点 |
|---|---|---|
| `verify-importer.ts` | **13 / 0** | 内存 fixture 的规则测试（dryRun 零写入、dry==apply、包内重名、别名冲突、非法单位拒绝、`verified=false` 拒绝） |
| `verify-content-acceptance.ts` | **23 / 0** | 真实两包：`content.json` dry=136/apply=136、第二遍 0 新增；`content-extra.json` dry=96/apply=96、跳过 0、别名冲突 0、第二遍 0 新增；旧数据/库存逐字段未变 |
| `verify-content-e2e.ts` | **13 / 0** | 完整闭环：导入两包 → 推荐（目标菜谱在方案中）→ apply 建会话 → 逐道 done → 预览（11 项需确认，含 `seasoning_presence → confirm_reason=user_choice`）→ 按 `confirm_reason` 确认 → `nc=0` → settle 200 → 真实扣减 `小米 100/100`、`南瓜 200/200`，outcomes `consumed / skipped_user / skipped_unit_mismatch`，会话终态 `settled` |

`server` `tsc --noEmit` **0**；`git diff --check` **0**（仅 LF/CRLF 警告）。

### 导入器（Sol 在已备份库、事务内调用）
```ts
import { importRecipeContent } from './seed/v023-content/importer.js'
const stats = db.transaction(() => {
  const a = importRecipeContent(db, { contentPath: 'seed/v023-content/content.json', dryRun: false })
  const b = importRecipeContent(db, { contentPath: 'seed/v023-content/content-extra.json', dryRun: false })
  return { a, b }
})()
```
只新增、幂等、可重复运行；`dryRun` 默认 true 且**零写入**；分类/标签只复用不新建；`recipe.note` 保存来源 URL + 两人份说明；每条配料带非空唯一 `line_key`。

### 与子代理的文件分工（各自保留，未越界）
本路：`importer.ts` / `content-extra.json` / `verify-importer.ts` / `verify-content-acceptance.ts` / `verify-content-e2e.ts`；
子代理：`content.json`（未被我覆盖）/ `import-v023-content.ts`（CLI）/ `verify-content-import.ts` / `README.md`。
⚠️ 同目录存在**两套导入器实现**，最终保留哪一套需 Sol 决定；我未删除对方文件。

### 内容包收尾修订（DSH，2026-10-16 晚）
- **移除无核定的健康宣称标签**：`content.json` 中原有 `高蛋白/低脂/高纤维` 共 **7 处、涉及 6 道菜**已删除；现用标签 **24 个**（类型/口味/工艺/场景/快手），**无营养宣称**。文件 SHA256：`5745E7CF73707600C3C68F2A58D0CC2FBA49B01C839038C3CF3BD2B327F64230`（30 菜 / 136 定义不变）。
- **导入实现统一为一套**：`import-v023-content.ts` 已改写为**薄封装**（CLI + 兼容再导出），唯一实现是 `importer.ts` 的 `importRecipeContent`。CLI 契约保持：默认 dry-run 零写入、`--apply` 才写、`--db` 必须绝对路径（缺失/相对 → 退出码 2）、`--dry-run`/`--db=`/`--content=` 形式等价、`--content` 可重复、`assertSafeDbPath(..., { allowRealDb: false })`；**新增**前置检查：目标库未迁移 → 明确提示并退出 2（不再抛 `no such table`）。
- **dry/apply 预测一致性修复**：`importer.ts` 增加单位计划索引（`planUnits`）。此前"同一食材重复列同一单位"会让 dry 计数比 apply 多 1（214 vs 213）；现两包 dry 与 apply **完全一致**（136/96 定义、别名 94/42、单位 400/213）。
- `content-extra.json`：96 个新增食材定义（dry=96/apply=96、跳过 0、别名冲突 0、二遍 0 新增）。
- CLI 实测：dry-run 后 `recipe=0 definitions=0`（零写入）→ `--apply` 得 `ingredient_definition=232 别名=136 单位=613 recipe=30 配料=241 步骤=126 标签关联=125` → 第二遍 0 新增、30 菜谱全 skipped。
- ⚠️ **已知问题（我的回归，待处理）**：子代理的 `verify-content-import.ts` 在统一实现后**导入期报错退出**（它原先直接测那一份重复实现）。权威验收为我的三套：`verify-importer.ts 13/0`、`verify-content-acceptance.ts 23/0`、`verify-content-e2e.ts 13/0`。请或给我其报错首行以修兼容导出，或直接移除该脚本（其验证目标已不存在）。

### 内容包最终收尾（DSH，2026-10-16 晚 · 二）
- **同义名真正生效**：`content.json` 的 `synonyms` 已按 `recipe_aliases` 同步（4 道：番茄炒鸡蛋/清炒西葫芦/小米南瓜粥/手撕包菜）。既有「西红柿炒鸡蛋」时，「番茄炒鸡蛋」按真实字段被跳过 → **菜谱 +29（跳过 1）**，不再是 30。`synonyms_note` 已写入文件说明。
- **单位计数一致**：`importer.ts` 改为「**先过滤非法单位（拒绝该定义）→ 再 `new Set()` 去重合法单位**」；数据侧修掉唯一重复项（`content-extra.json` 的 鹌鹑 `["个","个"]` → `["个","克"]`）。dry/apply 单位数**完全一致**（400/400、213/213）。
- **旧测试修复并保留**（不删不跳）：`verify-content-import.ts` 的 CLS 缺省包路径问题由薄封装提供 `DEFAULT_CONTENT_PATH` 默认值解决；其统计断言改用统一核心的**新结构**（`recipes_skipped`/`definitions_skipped`/`aliases_skipped` 取 `.length`，`tags_reused`/`skipped_reason_counts` 换成 `tags_linked`/`tags_missing`，并移除统一核心不接受的 `now` 选项）。**未为大改过的旧测试伪造第二套 stats**。
- 该脚本现独立跑 **46 / 0、exit 0**（系统 tmp 自建隔离库）。
- 最终文件指纹：`content.json` 87,275 B `674B82DFE8A1CA6FE3B900173CE364CD27B5E9B173F99B4E994F69C617505266`；`content-extra.json` 11,451 B `B3CEB7951EDD889166C9364A9C43B73F14D11EB8A2C2A1774394E88752B9BAAE`。
- 四套验收：`verify-content-import 46/0`、`verify-content-acceptance 25/0`、`verify-content-e2e 13/0`、`verify-importer 13/0`；`tsc --noEmit` 0。

---

## 最终验收记录（Sol 独立执行 · 2026-10-16）

### 分工
- **主要开发：DSH（大肥鱼）** —— v0.2.3 修复（R1 统一逐行缩放舍入、R2 调味品 presence 确认、R3 FEFO 临期收益、R4 预览总量感知、R8 显式零需求）与内容包导入器、隔离验收、本交接文档。
- **独立验收：Sol** —— 算法独立验收 **12 / 12**；内容独立验收 **6 / 6**。

### 既有回归（与内容验收分开计）
仓库八组回归 **752 / 0**（各组最近一次实测输出之和）：
`verify-v023-tags-preference 173`、`verify-v022-recommendation 127`、`verify-recipe-batch1 83`、`batch2 103`、`batch3 106`、`verify-v0211-cooking-records 65`、`verify-v012-settings-expiry 68`、`verify-recipe-transaction-rollback 27`。
Sol 独立纯算法 14/14；`server tsc --noEmit` 0；`git diff --check` 0。

#### 测试计数口径（数字修正说明）
- 本文先前一处误写为 **743**：该值对应 `verify-v023-tags-preference = 164` 时的快照
  （164 + 127 + 83 + 103 + 106 + 65 + 68 + 27 = 743）；Sol 验收记录中的 **713** 对应 v023 = 134
  （134 + 127 + 83 + 103 + 106 + 65 + 68 + 27 = 713）。两者都是**历史快照**，不是当前总数。
- 当前 v023 = **173**（在 164 基础上新增「验收点 A49–A52」与「调味品确认 B19×5」；实跑输出
  `PASS=173 FAIL=0`）→ 算术和应为 **752**，故本文统一改为 752。
- 各组计数**最后一次实测的时间点并不相同**（最后一次改动后未重跑全部八组）：
  `v023 173`、`v022 127`、`v0211 65` 是 **R2（调味品 presence / 显式零需求）改动之后**的输出；
  `batch1 83`、`batch2 103`、`batch3 106`、`v012 68`、`rollback 27` 是**较早一轮**的输出
  （其后的代码改动集中在内容包 `server/seed/**`，未触及这些脚本覆盖的 `server/src/**` 逻辑）。
  因此 **752 是「各组最近一次实测之和」，不等于一次全量重跑的结果**；若需单一批次口径，
  请在最终验收时重跑八组并以那次输出为准。

### 内容验收（四套脚本，合计 **97 / 0**）
| 脚本 | 通过 |
|---|---|
| `seed/v023-content/verify-content-import.ts` | 46 |
| `seed/v023-content/verify-content-acceptance.ts` | 25 |
| `seed/v023-content/verify-content-e2e.ts` | 13 |
| `seed/v023-content/verify-importer.ts` | 13 |
| **合计** | **97 / 0** |

### 正式内容追加实际结果（Sol 执行，已备份）
- 新增 **108 项食材定义**、**29 道菜谱**（「番茄炒鸡蛋」因已存在同义菜谱「西红柿炒鸡蛋」按 `synonyms` **跳过**）。
- 追加后总量：**337 个食材定义 / 36 道菜谱**。
- **正式库存仍为 7 行**；**全部 20 张表**的旧业务行**逐字段保留**；schema 与迁移历史未变；外键检查与完整性检查通过。
- 重复导入 **零变化**（幂等已验证）。
- 备份：`homechef-before-library-fill-2026-10-16T07-35-24-820Z-bd84ac09.db`（已存在）。

### 状态
- **没有 commit / push**；**版本仍为 0.2.2**（`package.json` 未改，CHANGELOG/TECH_STACK 未动）。
- **本轮未执行新的数据库迁移**（沿用既有 0012 结构）。
- 早前误入 `server/data` 的测试产物按 Sol 指示**未清理、仅记录**；后续测试一律显式 `HOME_CHEF_TEST_DB_DIR` 指向系统 tmp。

—— 交接完成，等待用户验收。

## 截图验收修复 + 测试库存准备（DSH，2026-10-16 晚 · 三）

### A. Tag 选择弹窗 CSS 根因与最小修复（已改，前端构建通过）
**根因（此前我"flex 压缩换行"的猜测是错的，以下为实际代码依据）**：
- `client/src/styles.css:239` `.modal label { display:flex; flex-direction:column; gap:4px; margin-bottom:8px }`
  —— 特指度 (0,1,1) **高于** `.tag-select-item` (0,1,0)，把标签项强制成**纵向**：勾选框跑到文字上方、卡片被拉高并多出 8px 下边距；
- `client/src/styles.css:247` `.modal input, .modal select, .modal textarea { width:100%; padding:7px 10px; border-radius:6px }`
  —— 把 `checkbox` 拉成整行宽 → 视觉上是"高椭圆卡片"；
- 弹窗内**两个**滚动容器：`.tag-select-list-wrap`（`max-height:260px`）与 `.tag-picker-groups`（`max-height:46vh`），
  而 `.modal`（`styles.css:208`）**自身没有** max-height/overflow → 两层嵌套滚动条；
- 分类标题 `.tag-picker-group-title` 是滚动内容里的普通元素，没有 `position: sticky` → 一滚就被裁。

**修复（全部作用域化，未改任何全局规则；无 `!important`）**：
- 保留**唯一**内容滚动容器 `.tag-select-list-wrap`（`max-height: min(52vh, 380px)`），
  内层 `.tag-picker-groups { max-height:none; overflow:visible }` → 嵌套滚动消除；
- `.tag-picker-group-title { position: sticky; top:0; background:#fff }` → 标题不再被裁；
- `.tag-picker .tag-select-item { display:inline-flex; flex-direction:row; align-items:center; margin-bottom:0 }`
  —— 用 (0,2,0) 压过 `.modal label`(0,1,1)，勾选框回到文字左侧；
- `.tag-picker .tag-select-item input[type=checkbox] { width:auto; flex:0 0 auto; margin:0; padding:0; border:none }`
  —— 压过 `.modal input{width:100%}`；
- `@media (max-width:420px)`：列表降到 `46vh`、超长标签名允许换行（`overflow-wrap:anywhere`）→ 360px 不溢出，下方「确认 / 取消」始终可达；
- **未隐藏「预设」徽章**，其他普通表单标签样式完全未动（`.modal label` 原样保留，已在构建产物中核对）。

### B. 测试库存准备脚本（待 Sol 审查后执行，DSH 未执行真实写入）
- 脚本：`<work>/homechef-test-stock.cjs`；隔离验证 setup：`<work>/_isolate-stock-setup.ts`；
  隔离 dry-run 计划：`<work>/test-stock-plan.isolated.json`。
- 以 Sol 提供的**权威定义清单** `<work>/test-stock-definition-plan.json`（337 定义，含 `already_stocked`）为准：
  不读真实库即可确定允许单位与需跳过项；**6 项已有库存必须跳过**（番茄、白萝卜、肘子、虾仁、鸡蛋、嫩豆腐）。
- 约束：只新增（INSERT）；已有任何库存的食材一律跳过；只复用现有定义与允许单位；不新增调味品哨兵；
  `note` 固定 `用户授权测试库存 2026-10-16`；`purchase_date` = 执行当日（不虚构历史）；无过期批次，
  仅安全临期（`今天+2`、`expiry_date_source='manual'`，默认 `days/3` 下判 expiring）；
  `storage_method ∈ 常温/冷藏/冷冻`。
- 隔离实测（`%TEMP%` 临时库，用后删除）：dry-run 计划 **30 批**、跳过 **7 项**（番茄/鸡蛋/虾仁 = already_stocked；
  生姜/猪肉/牛肉/火腿肠 = 权威清单中不存在）→ **零写入**；仅 `--apply` 被拒（exit 2）；
  `--apply --confirm-real-write` 写入 30 批，自检 外键 ok / 完整性 ok / 非法单位 0 / 本批次过期 0；
  **复跑 0 新增**（幂等）。真实库写入须经双重开关 `--apply --confirm-real-write`
  （目标为真实库路径时还需 `--allow-real-db`），由 Sol 备份后执行。

### C. 记录更正：疑似验收标签的来源**未知**
- 经 Sol 从新备份核实：疑似 5 个验收命名标签均为 **2026-10-11 创建**，其中 **4 个已关联菜谱**，
  **不是**本次内容导入（2026-10-16）产生的；**本轮不删除**任何标签。
- **撤回**我此前"仓库与 `work/` 全库 grep 无命中，因此不可能是脚本创建"的推断 —— 该结论**过强**：
  grep 无命中只能说明"未见落盘证据"，**不能排除**脚本、UI 手工、其他工具或更早会话创建。
  **来源未知就是未知**；任何清理都必须基于 `recipe_tag.created_at` 等真实字段逐条复核并由用户批准。

### D. Tag 弹窗 CSS 二次修复（按 Sol 无界面静态测量结论）
Sol 用 `work/tag-ui-qa.cjs`（隔离 headless，不连真实 API）测得两处残余问题：`1002x670` 横向溢出、`778x302` 底部按钮不可见；
根因是 `.tag-picker-list li` 缺 `max-width/min-width`、`span` 默认 `nowrap` 且仅 ≤420px 才断行、短屏固定 `52vh` 列表 + 固定头/按钮总高超出视口。

**修复（全部作用域化，未动任何全局规则）**：
- 宽度：`.tag-picker-list, .tag-picker-list li { max-width:100%; min-width:0 }`；
  `.tag-picker .tag-select-item { max-width:100%; min-width:0 }`；
  `.tag-picker .tag-select-item > span { min-width:0; white-space:normal; overflow-wrap:anywhere }`
  —— 常规名自然紧凑，≤60 字上限的长名自动换行、绝不横向溢出；
- 高度预算：`.tag-select-dialog { display:flex; flex-direction:column; min-height:0; max-height:calc(100dvh - 48px) }`；
  唯一滚动容器 `.tag-select-list-wrap { flex:1 1 auto; min-height:0; max-height:none; overflow-y:auto }`（取消固定 52vh）；
  `.tag-select-dialog > h2 / .tag-select-mode / .modal-actions { flex-shrink:0 }`；
- `@media (max-width:480px)`：`max-height:calc(100dvh - 24px)`，模式行 `flex-wrap:wrap`（窄屏不裁按钮）。

**复测（`work/tag-ui-qa.cjs`，三档视口）**：
```
360,640  {direction:row, checkboxWidth:13, scrollRegions:1, horizontalOverflow:false, actionsVisible:true}
1024,768 同上一律通过
800,400  同上一律通过
```
⚠️ 口径说明：Chrome CLI 有最小宽度（请求 360 实际约 512 渲染），本文件**不声称已在真实 360px 下验证**；
`client npx tsc --noEmit = 0`、`npm run build = 0`（CSS 49.37 kB）。
普通表单不受影响：`styles.css:239 .modal label` / `:247 .modal input{width:100%}` 原样保留；
非作用域残留的 `.tag-select-mode` 规则是**改动前既有**的基础样式（`:1789`，display/gap），本次未触碰。

## 发布准备（v0.2.3）—— DSH，2026-10-16

### 用户验收
- 用户已**验收通过 v0.2.3**，并授权补齐版本号与 GitHub tag；**v0.2.4 暂停**。
- 独立验收：Sol **算法 12/12**、**内容 6/6**；仓库回归 v023 `173`、v022 `127`、菜谱三组 `83/103/106`、
  烹饪记录 `65`、设置临期 `68`、事务回滚 `27`；内容包四套隔离测试 `46+25+13+13 = 97`。

### 本轮（发布准备）改动
| 文件 | 改动 |
|---|---|
| `package.json` / `client/package.json` / `server/package.json` | `version` → **0.2.3**（**只改版本字段**，未安装/升级任何依赖） |
| `package-lock.json` | 4 处版本（根、`packages[""]`、`packages["client"]`、`packages["server"]`）→ **0.2.3** |
| `README.md` | 当前版本 → v0.2.3；新增 v0.2.3 功能段（五分类 Tag / 喜欢·不喜欢 / 历史衰减与轮换 / 库存优先与临期优先 /
  粗略结构非精确营养 / 本轮精度·FEFO·共享·预览·调味确认修复 / 内容包为**可选导入**且测试库存不入仓库） |
| `CHANGELOG.md` | 新增 `[0.2.3] - 2026-10-16`；**补 `[0.2.1.1] - 2026-10-15`**（烹饪记录管理 + 中式灶台主页改版 + 0011 迁移）；既有历史条目事实未改 |
| `HANDOFF_V023.md` | 本节（验收 / 发布准备 / 迁移状态 / 布局口径更正） |

### 迁移状态（写入 CHANGELOG 的口径）
- v0.2.3 **需要迁移 `0012_v023_tags_preference`**；**新安装按现有迁移流程执行**；
  **既有真实库此前已迁移到 0012，本轮不执行任何迁移**（本轮未触碰数据库与备份）。

### 布局验证口径更正（重要）
- 本文此前"Chrome CLI 最小宽度约 512，故未真正验证 360px"的说法**已过时**。
- Sol 用**隔离 iframe** 实测 **360×640 / 1024×768 / 800×400** 三档：均为**单滚动容器、无横向溢出、
  底部按钮可见**（`direction=row`、`checkboxWidth=13`、`scrollRegions=1`）。以此为准。

### 验证（本轮实际执行）
- `server` `tsc --noEmit` = **0**；`client` `tsc --noEmit` = **0**；`client npm run build` = **0**（CSS 49.37 kB / JS 288.35 kB）。
- 版本一致性：根 / client / server `package.json` 与 `package-lock.json` **全部 0.2.3**；代码与锁文件已无 `0.2.2` 残留。
- 未重复跑全部业务回归（按用户要求）。

### 待提交文件清单
见本次交付消息中的完整清单（`git status --short` 共 47 条）。其中：
- `HANDOFF_DSH_V022.md` 疑为**旧冗余草稿**，建议**不提交**（**未擅自删除**，由 Sol 决定）；
- `server/seed/v023-content/` 为**可选内容包**（含 9 个文件），是否随版本提交由 Sol 决定。

### 未做
- **未执行任何 Git 操作**（无 `add` / `commit` / `tag` / `push`）——由 Sol 负责；
  历史 tag 目标（Sol 决定）：`v021 = e6c7521`、`v0211 = 61722f6`、`v022 = 2f9f6dc`。
- 未改 `TECH_STACK.md`、未碰数据库/备份/本机脚本；未接入 AI；未开始 v0.2.4 开发。

### 发布准备段的现状覆盖（以本节为准；前文历史快照不回改）
- 前文各分节中出现过的「正式库存仍 7 行」「版本仍 0.2.2」「没有 commit/push」「未执行迁移」等表述，
  均为**当时阶段快照**，作为过程记录保留、**不回改**；现状以本节为准：
  - **版本**：根 / `client` / `server` `package.json` 与 `package-lock.json` **已统一为 0.2.3**（仅版本字段，未安装/升级依赖）；
  - **Git**：**仍未 commit / push / tag**（由 Sol 执行提交与打 tag）；
  - **迁移**：v0.2.3 需要 `0012_v023_tags_preference`；既有真实库此前已迁移到 0012，**本轮未执行任何迁移**。
- **库存属纯本机测试数据**：用户后续明确"原有库存也全部是测试数据"；Sol 在此基础上**新增 61 个测试批次**，
  现共 **68 行库存、56 种有正余量的食材**。这些**只存在于本机数据库，不进入 Git，也不属于默认安装内容** ——
  仓库**不分发任何库存 / 测试库存数据**（内容包亦为可选导入）。
- `HANDOFF_DSH_V022.md` 为**旧历史快照**，**保留本地、不纳入本次提交**；**不删除**、也**不加入 `.gitignore`**。
- 本轮文件准备到此结束；后续 Git 提交、tag（`v0.2.3`）与 push 由 Sol 执行。
