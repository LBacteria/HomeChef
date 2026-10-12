# HomeChef Phase 3 实施计划 —— 菜谱模块

> **目标版本**：v0.2.0
> **当前基线**：v0.1.4（提交 `424b26e`）
> **状态**：**规划中，尚未开始实施**
> **产品需求**：见 [`PROJECT_SPEC.md`](./PROJECT_SPEC.md) 第 **4.2 节**

---

## 0. 本文件的作用

本文档**固化 Phase 3 已确认的产品决策与实施顺序**，用于：

* 避免上下文丢失导致需求漂移
* 明确每批的**允许修改范围**与**验收标准**
* 明确**禁止提前实施**的内容

⚠️ **本文档不改变任何既有产品规则**；如与 `PROJECT_SPEC.md` 冲突，
以 `PROJECT_SPEC.md` 为准并先报告。

---

## 1. 已确认的产品决策（**不得擅自更改**）

### 1.1 功能范围

**实现**：

1. 菜谱**列表、详情、新建、编辑、删除**
2. 菜谱**关联食材定义**
3. **多 Tag 标签系统**（自由创建 + 复用已有）
4. 菜谱**名称搜索**（⚠️ 按产品决策：Tag 名称**不参与**搜索）
5. 按 Tag **筛选**，支持 **AND / OR** 两种模式
6. 菜谱列表**排序**及**排序方向**切换
7. 菜谱管理的**基本 UI**

**不实现**（详见 §6 禁止清单）：

* 根据库存判断能否制作
* 菜谱推荐、每日菜单、营养平衡分析
* DeepSeek 或其他 AI 功能
* 库存扣减
* 购物清单
* 份数系统
* 照片上传
* 完整制作流程编辑

### 1.2 菜谱字段规则

| 字段 | 必填 | 规则 |
|---|---|---|
| 菜谱名称 | ✅ | **同名不允许重复**（归一化后唯一，后端 + DB 双重保证） |
| 菜谱整体备注 | ❌ | 可为空 |
| 菜谱食材 | ✅ | **至少一个食材** |
| Tag | ❌ | 可以没有任何 Tag |
| 制作流程 | ❌ | **本阶段不实现**，预留扩展空间 |
| 照片 | ❌ | **本阶段不实现上传**，预留扩展空间 |

### 1.3 食材关联规则

| 规则 | 说明 |
|---|---|
| 排序 | 食材**固定按用户添加顺序**展示（`sort_order`） |
| **重复关联** | ✅ **允许**同一菜谱重复添加同一种食材 |
| 独立字段 | 每条食材记录**独立保存**数量、单位、备注、顺序 |
| **禁止约束** | ❌ **不得**设置「同一菜谱不可重复关联同一食材」的 UNIQUE 约束 |
| 删除食材定义 | 被菜谱引用时 → **HTTP 409**，错误码 **`HAS_RECIPE`** |
| 删除菜谱 | 删除菜谱**本身 + 食材关联 + Tag 关联** |
| 删除菜谱的边界 | ❌ **不得**删除食材定义或 Tag 本身 |

### 1.4 食材的数量 / 单位 / 备注规则

| 字段 | 必填 | 说明 |
|---|---|---|
| 数量 | ❌ | 可为空 |
| 单位 | ❌ | 可为空 |
| 食材备注 | ❌ | 可为空 |

**关键约束**（用户明确要求）：

* ✅ 数量、单位、备注**三者相互独立**
* ❌ **不得**因为食材是调味品就**强制清空**数量或单位
* ❌ **不得**因为食材是调味品就**强制要求**填写数量
* ✅ 调味品用量**直接写在食材备注**中，例如「适量」「2 勺」
* ❌ **不得**为了支持「勺」等写法而**修改现有 10 个单位枚举**
  （`个 克 千克 毫升 升 包 袋 瓶 盒 罐`）

### 1.5 Tag 规则

| 规则 | 说明 |
|---|---|
| 创建 | ✅ 支持**自由创建** |
| 复用 | ✅ 支持**复用已有** Tag |
| 唯一性 | **同名 Tag 不得重复创建** |
| 删除 Tag | 删除该 Tag 及其**菜谱关联**，**保留菜谱** |
| 关联数量 | 一个菜谱可关联**多个** Tag，也**可以没有** |
| 系统定位 | ✅ **灵活的多 Tag 系统**；❌ **不是**独立的菜谱分类体系 |

### 1.6 搜索、筛选与排序

**搜索**：同时匹配**菜谱名称**与 **Tag**。

**Tag 筛选**：

| 模式 | 语义 |
|---|---|
| **AND**（**默认**） | 菜谱必须拥有**所有**选中的 Tag |
| **OR** | 菜谱拥有**任意一个**选中的 Tag即可 |

* 支持选择**一个或多个** Tag
* 用户可在**设置**中切换 AND / OR

**排序**：

| 项 | 值 |
|---|---|
| 可选字段 | **最近修改时间** / **创建时间** / **菜谱名称** |
| 方向 | **升序 / 降序** |
| **默认** | **最近修改时间倒序** |

**列表展示**：菜谱名称、Tag、菜谱整体备注。
（**不要求**显示食材数量。）

### 1.7 设置持久化

| 项 | 要求 |
|---|---|
| 保存内容 | 排序字段、排序方向、Tag 筛选条件、AND / OR 模式 |
| 存储位置 | **本地数据库** |
| 恢复行为 | 重新打开应用时**恢复上次设置**，**不重置为默认值** |
| 本阶段不做 | 库存数量展示、库存联动（但设计应便于未来扩展） |

### 1.8 保存与数据一致性

| 要求 | 说明 |
|---|---|
| 统一保存 | 新建与编辑菜谱采用**统一保存**操作 |
| **单事务** | 菜谱 + 食材关联 + Tag 关联在**同一个数据库事务**中保存 |
| 失败回滚 | 保存失败**整体回滚**，避免部分写入 |
| 名称唯一性 | **后端校验 + 数据库约束**双重保证 |
| 禁止 | ❌ **不允许**仅依靠前端校验保证数据正确性 |

---

## 2. 技术约束（沿用现有架构，不引入新技术）

| 层 | 技术 | 约束 |
|---|---|---|
| 前端 | React + TypeScript + Vite | ❌ 不引入 react-router、状态管理库、UI 框架 |
| 后端 | Node.js + TypeScript + Fastify | 业务规则放 **service 层** |
| 数据库 | SQLite + Drizzle ORM | 通过 **migration** 变更结构 |
| 校验 | Fastify JSON Schema / AJV + Service 二次校验 | 与现有 `definitionService` 模式一致 |

**硬性约束**：

* ✅ 后端业务规则**放在 service 层**
* ❌ 前端**不得**直接访问数据库
* ❌ 不新增与 Phase 3 无关的技术栈
* ❌ 前端路由继续用 `App.tsx` 的 `useState<View>` 模式

---

## 3. 数据模型（计划）

> ⚠️ 以下为**计划**，实际以批次 1 的实施与 migration 为准。

### 3.1 `recipe`（菜谱主表）

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `name` | TEXT | NOT NULL |
| `name_normalized` | TEXT | NOT NULL，**UNIQUE** |
| `note` | TEXT | NULL（菜谱整体备注） |
| `created_at` / `updated_at` | TEXT | NOT NULL |

### 3.2 `recipe_ingredient`（菜谱-食材关系）

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `recipe_id` | INTEGER | NOT NULL → `recipe.id` **ON DELETE CASCADE** |
| `definition_id` | INTEGER | NOT NULL → `ingredient_definition.id` **ON DELETE RESTRICT** |
| `quantity` | REAL | NULL |
| `unit` | TEXT | NULL（在 10 个枚举内，若有值） |
| `note` | TEXT | NULL |
| `sort_order` | INTEGER | NOT NULL DEFAULT 0 |

**索引**：`recipe_ingredient_recipe_id_idx`、`recipe_ingredient_definition_id_idx`

> ⚠️ **不设** `UNIQUE(recipe_id, definition_id)` —— 按 §1.3，允许重复关联。

### 3.3 `recipe_tag`（Tag 表）

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `name` | TEXT | NOT NULL |
| `name_normalized` | TEXT | NOT NULL，**UNIQUE**（同名不重复） |
| `created_at` | TEXT | NOT NULL |

### 3.4 `recipe_tag_link`（菜谱-Tag 关联）

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `recipe_id` | INTEGER | NOT NULL → `recipe.id` **ON DELETE CASCADE** |
| `tag_id` | INTEGER | NOT NULL → `recipe_tag.id` **ON DELETE CASCADE** |

**唯一约束**：`UNIQUE(recipe_id, tag_id)`（同一菜谱不重复挂同一 Tag）

> Tag 删除时级联清理关联，但**菜谱本身保留**（符合 §1.5）。

### 3.5 错误码新增（计划）

| 错误码 | HTTP | 场景 |
|---|---|---|
| `RECIPE_NOT_FOUND` | 404 | 菜谱不存在 |
| `DUPLICATE_RECIPE_NAME` | 409 | 菜谱名称重复 |
| `**HAS_RECIPE**` | **409** | **删除被菜谱引用的食材定义** |
| `TAG_NOT_FOUND` | 404 | Tag 不存在 |
| `DUPLICATE_TAG_NAME` | 409 | Tag 名称重复 |

> ⚠️ **`HAS_RECIPE` 需要修改现有 `deleteDefinition()`** —— 目前它只检查库存。
> 这是一个**行为变更**，必须在批次 2 明确实施并回归测试。

---

## 4. 分批实施计划

> **每批必须可独立验收**；**禁止跨批次提前实施后续功能**。

---

### 批次 1：数据模型 + 只读 API

| 项 | 内容 |
|---|---|
| **目标** | 建立菜谱相关表结构，实现列表与详情两个只读端点 |
| **数据库** | 新增 migration `0007_recipe.sql`：`recipe`、`recipe_ingredient`、`recipe_tag`、`recipe_tag_link` 四表 + 索引 |
| **后端新增** | `server/src/services/recipeService.ts`（`listRecipes` / `getRecipeById`）<br>`server/src/services/tagService.ts`（`listTags`）<br>`server/src/routes/recipes.ts`（两个 GET）<br>`server/src/routes/tags.ts`（`GET /api/tags`）<br>`server/src/db/schema.ts` 追加四表定义 |
| **API** | `GET /api/recipes`（列表）<br>`GET /api/recipes/:id`（详情，含食材与 Tag）<br>`GET /api/tags`（全部 Tag，供复用） |
| **前端** | ❌ 无 |
| **测试** | `server/verify-recipe-batch1.ts`：迁移成功、四表存在、只读 API 返回正确、404、空列表 |
| **验收标准** | ① migration 可在**临时库**执行且不破坏现有数据<br>② 三个 GET 端点返回正确 JSON<br>③ 404 正确<br>④ 现有 **13 个 verify 脚本不回归**<br>⑤ `tsc` = 0<br>⑥ **同步更新 `DATABASE_DESIGN.md`**：<br>　· 从第 12 节「当前不包含的表」中**移除** `recipe` / `recipe_ingredient`<br>　· **新增章节**记录四张表（字段、类型、约束、索引、外键行为）<br>　· 确保文档与实际 schema **逐字段一致** |
| **不含** | 增 / 改 / 删、UI、Tag 筛选排序、库存匹配 |

---

### 批次 2：菜谱 CRUD + 食材与 Tag 关联（**统一保存**）

| 项 | 内容 |
|---|---|
| **目标** | 完整增删改 + 食材关联 + Tag 关联，全部走 **service 事务** |
| **数据库** | ❌ 无新 migration（沿用批次 1） |
| **后端新增** | `recipeService`：`createRecipe`、`updateRecipe`、`deleteRecipe`、`saveRecipeFull`（**单事务**）<br>`tagService`：`createTag`、`deleteTag`<br>`definitionService.deleteDefinition` **新增 `HAS_RECIPE` 检查** |
| **API** | `POST /api/recipes`<br>`PATCH /api/recipes/:id`<br>**`PATCH /api/recipes/:id/full`**（统一保存：菜谱 + 食材 + Tag）<br>`DELETE /api/recipes/:id`<br>`POST /api/tags`<br>`DELETE /api/tags/:id` |
| **业务校验** | ① 名称非空且**唯一**<br>② **至少一个食材**<br>③ 食材定义必须存在<br>④ **允许重复食材**（不加唯一约束）<br>⑤ 单位在 **10 枚举**内（若有值）<br>⑥ **不因调味品强制清空/必填**数量或单位<br>⑦ Tag 同名不重复<br>⑧ 删除被引用食材定义 → **409 `HAS_RECIPE`** |
| **前端** | ❌ 无 |
| **测试** | `server/verify-recipe-batch2.ts`：CRUD、名称唯一、**重复食材被允许**、**调味品用量规则**、**事务中途失败整体回滚**、删除保护 409、Tag 增删与级联 |
| **验收标准** | ① 全部 API 正确<br>② **重复关联同一食材成功**（验证未加错约束）<br>③ **调味品可不填数量**、也可填数量（三者独立）<br>④ **构造中途失败 → 整体回滚**（逐字段比对）<br>⑤ 删除被引用定义 → **409 `HAS_RECIPE`**<br>⑥ 13 个既有脚本不回归，其中**必须显式回归**以下 4 个（因 `deleteDefinition` 行为变更）：<br>　· `server/verify-v014-category-change.ts`<br>　· `server/verify-v014-category-color.ts`<br>　· `server/verify-v013.ts`<br>　· `server/verify-phase31-change-definition.ts`<br>⑦ 任一项失败 → 按 **§5.1 停止并报告** |
| **不含** | UI、搜索筛选排序持久化 |

---

### 批次 3：搜索、筛选、排序 + 设置持久化

| 项 | 内容 |
|---|---|
| **目标** | 名称/Tag 搜索、Tag 筛选（AND/OR）、三种排序 + 持久化 |
| **数据库** | 新增 migration **`0008_recipe_list_settings.sql`**，**复用现有 `app_settings` 单行表**（不新建独立表），新增 4 个可空列：<br>· `recipe_sort_field` TEXT NULL<br>· `recipe_sort_order` TEXT NULL<br>· `recipe_tag_mode` TEXT NULL<br>· `recipe_selected_tags` TEXT NULL —— **JSON 数组字符串**，如 `["家常菜","快手"]` |
| **复用依据** | `app_settings` 已是「应用级单行设置」表（`CHECK id = 1`），Service 采用「默认值在 Service + UPSERT + 二次校验」模式，**语义一致，无实质冲突**；已有 `0006` 的 `ALTER TABLE ADD COLUMN` 先例 |
| **默认值** | **默认 AND 模式** + **最近修改时间倒序**（默认值定义在 **Service 层**，与现有 `DEFAULT_APP_SETTINGS` 一致） |
| **JSON 校验要求** | ⚠️ `recipe_selected_tags` 必须**严格校验**：<br>· 写入时：必须是字符串数组，否则 400<br>· **读取时**：若 JSON 解析失败、不是数组、或元素不是字符串 → **回退为空数组**（不抛错、不影响其他设置）<br>· 需**兼容旧数据**（列为 NULL → 空数组）<br>· 需**清理不存在的 Tag id/名称**（Tag 被删除后旧筛选条件不应报错） |
| **后端新增** | `recipeService`：`searchRecipes`（含 Tag 筛选与排序）<br>`recipeListSettingsService`：读写列表设置 |
| **API** | `GET /api/recipes?search=&tags=&tag_mode=&sort=&order=`<br>`GET /api/recipe-list-settings`<br>`PATCH /api/recipe-list-settings` |
| **业务规则** | ① 搜索匹配**名称 + Tag**<br>② **AND**：包含所有选中 Tag；**OR**：包含任一<br>③ **默认 AND**<br>④ 排序：`updated_at` / `created_at` / `name`，升降序<br>⑤ **默认最近修改倒序**<br>⑥ 设置**持久化到数据库** |
| **前端** | ❌ 无 |
| **测试** | `server/verify-recipe-batch3.ts`：搜索匹配名称/Tag、AND/OR 语义、三种排序与方向、默认值、设置持久化（重启后恢复）、**JSON 异常数据回退**（写入非法 JSON 后读取应回退为空数组且不报错） |
| **验收标准** | ① 搜索命中名称与 Tag<br>② **AND 与 OR 结果集确实不同**（构造可区分的数据）<br>③ 排序三字段 × 两方向结果正确<br>④ 未设置时返回默认（**最近修改倒序 + AND**）<br>⑤ **设置写入后重新读取保持不变**<br>⑥ **损坏/旧的 `recipe_selected_tags` 数据不导致 500**（回退为空数组）<br>⑦ 任一项失败 → 按 **§5.1 停止并报告** |
| **不含** | UI、库存联动 |

---

### 批次 4：前端菜谱页

| 项 | 内容 |
|---|---|
| **目标** | 可实际使用的菜谱 UI |
| **前端新增** | `client/src/api/recipes.ts`<br>`client/src/api/tags.ts`<br>`client/src/pages/RecipesPage.tsx`（列表 + 搜索/筛选/排序控件）<br>`client/src/components/RecipeEditor.tsx`（编辑，**复用统一保存模式**）<br>`client/src/components/RecipeIngredientEditor.tsx`（食材行：定义 + 数量 + 单位 + 备注 + 顺序）<br>`client/src/components/TagSelector.tsx`（选择/创建 Tag） |
| **前端修改** | `App.tsx` 加 `'recipes'` 视图与导航项<br>`client/src/types/api.ts` 加类型<br>`client/src/styles.css` 加样式 |
| **后端** | ⚠️ 不应有改动（除非发现契约问题，需先报告） |
| **验收标准** | ① `tsc` + build = 0<br>② 浏览器完成「新建 → 加食材（含重复）→ 加 Tag → 改 → 删」全流程<br>③ **统一保存失败后草稿保留**<br>④ **取消/关闭丢弃未保存修改**<br>⑤ 搜索/筛选/排序可用<br>⑥ **刷新页面后设置保持** |
| **不含** | 库存联动、推荐、照片、制作流程 |

---

### 批次 5：文档同步 + 全量回归 + 发布 v0.2.0

| 项 | 内容 |
|---|---|
| **目标** | 文档与代码一致，全量回归通过，发布 v0.2.0 |
| **文档** | `CHANGELOG.md`（新增 `[0.2.0]`）<br>`PROJECT_SPEC.md`（状态更新）<br>`ARCHITECTURE.md`（菜谱 API 与分层）<br>`DATABASE_DESIGN.md`（四张新表）<br>`README.md`（菜谱功能） |
| **验收标准** | ① **全部 `verify-*.ts` 通过**<br>② 前后端 `tsc` = 0<br>③ 前后端 build = 0<br>④ 文档与实际一致<br>⑤ 版本号统一为 `0.2.0` |
| **发布** | 提交 → 打注解标签 `v0.2.0` → 推送 → 创建 GitHub Release |

---

## 5. 每批次的通用要求

**所有批次都必须遵守**：

1. ✅ **保护现有库存、食材定义、单位与既有功能**
2. ✅ 业务规则放 **service 层**，前端不直接访问数据库
3. ✅ 测试使用**独立临时数据库** + 动态端口，**不触碰 `homechef.db`**
4. ✅ 新增 API 必须有 **JSON Schema 入口校验 + Service 二次校验**
5. ✅ 统一保存必须走**单个数据库事务**
6. ❌ **不得**跳过断言、放宽断言或使用恒真条件让测试通过
7. ❌ **不得**删除或修改 13 个既有诊断脚本
8. ❌ **不得**跨批次提前实施后续功能

### 5.1 强制停止规则（**必须遵守**）

> ⚠️ **任何测试失败都必须停止当前批次。**

* ❌ **不得**进入下一批次
* ❌ **不得**通过**放宽断言、跳过测试、删除测试**或使用恒真条件来制造"通过"
* ❌ **不得**带着已知失败继续推进
* ✅ 必须**先报告**：失败的命令、完整错误信息、根因分析、建议修复方案
* ✅ 然后**等待确认**再继续
* ⚠️ 若失败原因**超出当前批次范围** → 停止并报告，**不得**擅自扩大修改范围

**每批完成后**：

* 输出修改文件清单
* 运行该批次测试 + **回归既有 verify 脚本**
* 运行 `tsc` 与 build
* 报告实际执行结果（不得沿用旧结果）
* 若任一项失败 → 按 **§5.1** 停止并报告

---

## 6. 本阶段禁止实现的内容

> ⚠️ 以下内容**不属于 Phase 3**，**禁止**在本阶段实现或提前建表/接口：

| 禁止项 | 归属阶段 |
|---|---|
| 根据库存判断能否制作 | Phase 4 |
| 菜谱推荐 | Phase 4 |
| 每日菜单 / 菜谱轮换 | Phase 4 |
| 营养平衡分析 | Phase 4 |
| DeepSeek 或其他 AI 接入 | Phase 4 |
| 烹饪后自动扣减库存 | Phase 5 |
| 购物清单 | Phase 6 |
| **份数系统** | 未规划 |
| **照片上传** | 未规划 |
| **完整制作流程编辑** | 未规划 |
| 多用户、图片识别 | 未规划 |

**同时禁止**：

* ❌ 为未来功能**提前**新增数据表、接口或依赖
* ❌ 修改现有 **10 个单位枚举**
* ❌ 为「勺」等单位新增枚举值
* ❌ 引入 react-router、状态管理库、UI 框架、前端测试框架

---

## 7. 风险与注意事项

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| 1 | **修改 `deleteDefinition` 的行为**（新增 `HAS_RECIPE`） | 🟡 中 | 批次 2 明确实施，**必须回归 `verify-v014-*` 既有脚本** |
| 2 | **误加 `UNIQUE(recipe_id, definition_id)`** | 🔴 高 | §1.3 明确禁止；批次 2 需有"重复关联成功"的正向测试 |
| 3 | **把调味品哨兵值当菜谱用量** | 🔴 高 | 三者独立（§1.4）；测试需覆盖"调味品不填数量"与"调味品填数量"两种 |
| 4 | **迁移重建表** | 🟢 低 | 本阶段为**纯新增表**，不重建既有表 |
| 5 | **无前端测试框架** | 🟡 中 | UI 靠 `tsc` + build + 手工验收（沿用现状） |
| 6 | **设置持久化位置** | 🟡 中 | 需在批次 3 决定：复用 `app_settings` 还是独立表 |

---

## 8. 已确定的事项

> 以下事项**均已确定**，不再列为待定：

| # | 事项 | 已确定的结论 |
|---|---|---|
| 1 | 列表设置存哪里 | ✅ **复用现有 `app_settings` 单行表**（新增 4 个可空列，migration `0008`），**不新建独立表** |
| 2 | 食材顺序 | ✅ **按用户添加顺序保存与展示**，**本阶段不实现拖动重排** |
| 3 | 菜谱「制作流程」 | ✅ **本阶段不实现编辑**，**不提前增加数据库字段** |
| 4 | 发布版本号 | ✅ **`v0.2.0`**（Phase 3 完成后发布） |
| 5 | Tag 筛选条件持久化 | ✅ `app_settings.recipe_selected_tags` 用 **JSON 数组字符串**存储，需校验与容错（见批次 3） |

---

## 9. 与既有文档的关系

| 文档 | 关系 |
|---|---|
| `PROJECT_SPEC.md` 4.2 节 | **产品需求的权威来源**；本文件为实施计划 |
| `PROJECT_SPEC.md` 第 10 节 | Phase 3 阶段定义 |
| `ARCHITECTURE.md` | 批次 4 后需补充菜谱 API 与分层说明 |
| `DATABASE_DESIGN.md` | 目前第 12 节将 `recipe` / `recipe_ingredient` 列为「不创建」；**批次 1 建表后必须同步更新** |
| `TECH_STACK.md` | 技术栈不变（不引入新技术） |

---

> **本计划为初版**，实际实施中的调整需记录在此文件或 `CHANGELOG.md`。
