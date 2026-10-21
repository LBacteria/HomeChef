# HomeChef v0.2.4 开发说明（调味品 + 持久化幂等 + 主菜优先变化）

> 状态：**v0.2.4 版本收尾（2026-10-21）**。版本字段已统一为 0.2.4；本文件此前的实测记录保留原日期口径。
> 本文件记录实现口径、改动面，以及 Sol / Lumi 在隔离库中执行得到的验证结果。

## 1. 本轮范围

1. **调味品 = 中性备料提醒**（方案 A）
   - 不确认、不计库存、不扣量、不写凭证行、不新增 outcome、不重建历史表。
   - 推荐侧零影响：不进缺口 / 覆盖率分母 / unknown（含 `0 + null` 混合）/
     临期收益 / 共享奖励 / 利用率，也不让方案降级。
2. **推荐 apply 的持久化幂等**
   - 迁移 `0013_recommendation_idempotency`，表 `recommendation_request`。
   - 无 TTL、无条数上限；回执与建会话同一 `BEGIN IMMEDIATE` 事务。

3. **A 阶段扩充（标签 + 批量删除 + 取数去 N+1）**
   - `0014_tag_taxonomy.sql`：**纯数据迁移**，删 4 条系统时段标签、迁移自定义 `meal_scene`、
     插入 `cuisine` 等新预设、同一事务清理筛选设置。
   - 库存批量删除：`POST /api/ingredients/bulk-delete`（上限 2000、去重、整批原子）。
   - `listRecipes` 与推荐候选改为批量查询；候选 40 截断**未改**。
   - ✅ 真实库已在备份（`homechef-before-v024-expansion-2026-10-17T05-31-45-020Z.db`）后
     执行 0014：时段系统标签及关联移除、自定义保留、cuisine 与扩充预设已生效。

4. **B 阶段：测试内容包 + 测试库存（已授权应用到真实库）**
   - `server/seed/v024-content/`：`catalog.ts`（食材目录）、`recipes.ts`（确定性白名单生成）、
     `importer.ts`（`importContentV024`，dry-run 零写入 + 名称幂等 + 单位不匹配跳过）、
     `stock.ts`（`planStock` / `applyStock`：按单位补差额、期限拉到 ≥ 今天+90、同日幂等）、
     两个 CLI（默认 dry-run）。
   - 数据来源诚实标注：`provenance: curated-test`，无 `source_url`、无 `verified`；
     v023 导入器门槛不变。
   - ✅ 真实库在受保护事务内导入 **1202 条菜谱 + 19 个新定义**
     （现共 1238 菜谱 / 356 定义）；二遍导入 0 新增；
     `unit_rejections=0`、`missing_tags=0`、`skipped_invalid=0`。
   - ✅ 真实库库存：新增 **114** 个批次、延长 **67** 个旧非调味批次日期（含 null 补期），
     共 182 行、101 种正余量食材；默认分类/期限规则未改，旧量/采购生产日期/存储/备注未改。
   - 旧「红枣 / 个」不是允许单位，按计划**跳过并报告**，未造非法库存、未改旧菜谱。

5. **主菜优先变化（第二阶段）**
   - 纯函数模块 `src/services/mainDish.ts`（锚点 / 主料相似度 / 配菜互补）
     与 `src/services/planSelection.ts`（同 tier 内挑选，主菜唯一、签名去重）。
   - 锚点档位：`NO_ROLE_RANK=4` **只用于完全无标签**的菜；只有汤/凉菜=5、甜点=6，
     不再被误判成 4。
   - 每个 tier 只认一个「主菜档」（该 tier **全部候选**里最小 `main_dish_rank`），
     档内选完即结束本 tier，不降级角色凑数；下一 tier 仍按库存序。
   - 同 tier 比较键是**逐级比较**，不是加权求和：
     主菜相似度升序 → 配菜互补降序 → (旧总分 − 重合惩罚) 降序 → 签名升序。
   - 服务层只负责组装候选并调用选择器；硬 tier 顺序完全交给选择器保证。

## 2. 关键语义

### 2.1 调味品

| 位置 | 行为 |
|---|---|
| `deriveRequiredReason` | 调味品分支**排在 `null_quantity` 之前**，一律返回 `null`（盐「适量」也免确认） |
| 推荐需求 | 只产出 `status = 'seasoning_reminder'` 的中性提醒；显式纯零不提醒；`seasoning_missing_count` 恒 0 |
| 推荐等级 | `ready = 主食材无缺口 && 无未知用量`，调味品不参与 |
| 结算预览 | 保留行并标记 `is_seasoning`，`required_reason/confirm_reason = null`、`skipped = true`、不占库 |
| 结算执行 | 调味品直接跳过：不扣减、不写 `cooking_settlement_item`、不伪造 `user_choice`/`consumed 0` |
| 快照 | `canonicalSnapshotPayload` **过滤调味品批次**：只改盐库存不会让 apply 快照失效；`is_seasoning`/`category_name` 仍保留，分类改动能正常失效 |
| 历史兼容 | 旧凭证不动；旧 `user_choice` 行保留，仍按"用户跳过"处理（不扣量） |

### 2.2 幂等

- 表：`request_id` PK、`payload_hash`、`session_id`(FK, ON DELETE CASCADE)、
  `response_json`、`created_at`。
- 语义：同 key 同载荷 → 原样重放首次响应（`idempotent_replay: true`）；
  同 key 异载荷 → `409 IDEMPOTENCY_CONFLICT`；未命中 → 事务内校验 + 建会话 + 写回执。
- 并发：`BEGIN IMMEDIATE` 串行化；**不在事务内吞唯一约束异常** ——
  真发生冲突就让整个事务回滚（吞掉再返回 winner 会把重复会话一起提交）。
- 删除会话 → 回执级联删除，该 request_id 的去重保证结束（预期语义）。
- 已移除：进程内 `Map`、`IDEMPOTENCY_TTL_MS`、`IDEMPOTENCY_MAX_ENTRIES`、
  `clearIdempotencyStore` 导出。

## 3. 改动文件

**后端**
- `src/services/skipReasonService.ts`（调味品免确认；旧常量保留）
- `src/services/recommendationAlgorithm.ts`（`seasoning_reminder`、等级/评分/unknown 口径、`seasoning_reminder_count`）
- `src/services/recommendationService.ts`（缺口清单排除调味品、理由文案）
- `src/services/settlementService.ts`（预览提醒项 + `is_seasoning`；结算跳过调味品）
- `src/services/cookingService.ts`（新增 `createSessionWithDishesTx`）
- `src/services/recommendationConfig.ts`（删除 TTL/上限常量）
- `src/routes/recommendation.ts`（持久化幂等事务）
- `src/db/schema.ts`（`recommendationRequest`）
- `src/db/index.ts`（`busy_timeout = 5000`）
- `drizzle/0013_recommendation_idempotency.sql`、`drizzle/meta/_journal.json`

**前端**
- `src/types/api.ts`、`src/pages/RecommendPage.tsx`、`src/pages/CookingPage.tsx`、`src/recommend.css`

**测试**
- 新增 `server/verify-v024-seasoning.ts`、`server/verify-v024-idempotency.ts`、
  `server/verify-v024-main-dish.ts`（纯函数 A/B + HTTP C）、
  `server/verify-v024-tag-taxonomy.ts`（0014 数据迁移）、
  `server/verify-v024-bulk-delete.ts`（批量删除，服务层 + 隔离库）
- 适配旧断言：`server/verify-v022-recommendation.ts`（A7/A8）、
  `server/verify-v023-tags-preference.ts`（A11–A13、A47、A48、A50、B12b、B19）

**第二阶段新增/修改**
- 新增：`src/services/mainDish.ts`、`src/services/planSelection.ts`
- 修改：`src/services/recommendationAlgorithm.ts`（导出 `rolesOfDish`）、
  `src/services/recommendationService.ts`（锚点、`main_dish_recipe_id`、`role_in_meal`、调用纯选择器）
- 前端：`src/types/api.ts`、`src/pages/RecommendPage.tsx`、`src/recommend.css`

**文档**
- `CHANGELOG.md`（`[Unreleased]` 段）

## 4. 验证命令（已由 Sol 在隔离库中执行，见第 5 节结果）

```powershell
# ① 类型与构建
npm run build            # tsc（rootDir=src，verify-*.ts 不在编译范围）
cd ..\client; npx tsc --noEmit
cd ..\client; npm run build

# ② 新测试（隔离库，必须显式指定目录）
$env:HOME_CHEF_TEST_DB_DIR = 'C:\Users\<you>\AppData\Local\Temp\hc-tests'
cd ..\server; npx tsx verify-v024-seasoning.ts
cd ..\server; npx tsx verify-v024-idempotency.ts
cd ..\server; npx tsx verify-v024-main-dish.ts
cd ..\server; npx tsx verify-v024-tag-taxonomy.ts
cd ..\server; npx tsx verify-v024-bulk-delete.ts
cd ..\server; npx tsx verify-v024-content.ts          # 生成质量 + 负例闸门 + 导入幂等 + 库存
cd ..\server; npx tsx verify-v024-stock-plan.ts       # 库存计划/期限/储存方式/幂等（专项）
cd ..\server; npx tsx verify-v024-content-scale.ts    # 1200 条下的列表/推荐耗时与覆盖

# B 阶段 CLI（默认 dry-run，均拒绝真实库）
npx tsx seed/v024-content/import-v024.ts --db <隔离库绝对路径>
npx tsx seed/v024-content/run-stock.ts --db <隔离库绝对路径>

# ③ 回归（同样隔离）
npx tsx verify-v022-recommendation.ts
npx tsx verify-v023-tags-preference.ts
npx tsx verify-v0211-cooking-records.ts
npx tsx verify-v012-settings-expiry.ts
```

## 5. 已实测记录

**运行方式说明**：本会话 DSH 的 `pwsh` 在沙箱初始化时被 Windows 文件权限挡住，
无法执行编译与测试；以下结果**全部由 Sol / Lumi 在隔离库中实际执行并回传**，
DSH 未亲自运行任何一条。

**A 阶段扩充（Sol 执行）**：标签迁移 12/0、批量删除 15/0、
独立迁移 + 600 条跨块故障回滚 HTTP 15/15；隔离浏览器验证库存单选、多选、
搜索隐藏项取消选中、全选只选可见 3 条、确认显示 3 条、取消不删，全部通过
（**不是全站 E2E**，也未用 UI 删真实库存）。

**B 阶段扩充（Sol 执行）**

| 项 | 结果 |
|---|---|
| 内容质量 / 拒绝 / 导入 / 库存综合 | **40 / 0** |
| 库存计划专项 | **11 / 0** |
| 规模专项 | **8 / 0** |
| 默认生成 | **1211 条**：中式 **1001**、西式 **210**（按生成器实测统计） |
| 空隔离库导入 | 1211 条 |
| 本机数据副本试导入 | 新增 **1202**、重名跳过 **9**、新定义 **19**；`unit_rejections=0`、`missing_tags=0`、`skipped_invalid=0` |
| 二遍导入 | 0 新增；旧菜谱/定义/允许单位/别名/历史原行保留，默认分类与期限设置不变 |
| 1211 条规模单次耗时 | 列表 30ms、川菜筛选 13ms、推荐 557ms |
| 推荐结构 | 40 候选、9880 组合、5 套主菜互异、每套 2 配菜；确定性/只读通过 |
| 构建 | server build 0；client build（tsc+vite）0；seed/测试显式 tsc 0 |
| 回归 | v022 **127/0**、v023 最终 **173/0** |

> 以上耗时为**本机单次证据**，不作为 P95 或性能承诺；候选上限未改。

**最终集成复跑（Sol / Lumi 执行）**

| 脚本 | 结果 |
|---|---|
| `verify-v024-main-dish` | **38 / 0** |
| `verify-v022-recommendation` | **127 / 0** |
| `verify-v023-tags-preference` | **173 / 0**（A47 已按新口径复跑通过） |
| `verify-v024-seasoning` | **44 / 0** |
| `verify-v024-idempotency` | **25 / 0**（含两进程并发、真正重启、超过旧 200 条 / 10 分钟、稳定响应） |
| `server npm run build` | exit 0 |
| `client npm run build`（tsc + vite） | exit 0 |
| Lumi 独立验收 | 22 / 22（15 项迁移 / 故障回滚 + HTTP 两主菜四配菜只 2 套、五主菜 5 套、配菜确实两素、稳定 code 改名、ready 素菜优先于 missing 荤菜、无标签仍可用、FK 完整），全部隔离库 |
| `git diff --check` | exit 0 |

**较早的一次相关回归（此后未改这三条链路的核心逻辑，不声称末次全量批跑）**：
烹饪记录 `65 / 0`、设置临期 `68 / 0`、事务回滚 `27 / 0`。

**历史过程（仅对照，不代表当前结论）**：seasoning 曾为 21/0（仅 HTTP、纯函数未执行）；
idempotency 曾为 15/3（只跑到 E）；第二阶段曾有一轮 38/0 之前的内部修正
（角色档位初值、每 tier 单一主菜档、逐级比较键）。

## 6. 边界与当前状态

- **真实库已完成的变更（Sol 执行，均有备份）**：
  - `0013`：备份 `homechef-before-v024-0013-2026-10-17T04-55-58-222Z.db`，表与 FK 核对通过。
  - `0014` 纯数据迁移：备份 `homechef-before-v024-expansion-2026-10-17T05-31-45-020Z.db`
    （quick_check 通过并保留），时段系统标签及关联移除、自定义保留、cuisine 等预设生效。
  - 内容导入：受保护事务内导入 1202 菜谱 + 19 定义（现 1238 菜谱 / 356 定义）。
  - 库存：新增 114 批次、延长 67 个旧非调味批次（含 null 补期），共 182 行 / 101 种正余量。
  - 收据：`work/v024-expansion-applied.json`；副本验收：`work/v024-expansion-stage-report.json`。
  - 这些是**本机测试数据**，不属于新安装默认内容，也不进 Git（含 .db 与备份）。
- 真实库上**未**为「红枣 / 个」修数据：该单位不在允许集合，按计划跳过并报告。
- 旧「麻婆豆腐」仅补了一条「川菜」关联（唯一新增的旧菜谱标签关联），菜谱本身未改。
- 所有自动化测试在隔离临时库执行；DSH 自身仍无法执行命令（pwsh 被文件权限挡住）。
- 2026-10-17 开发阶段结束时版本字段仍为 0.2.3，未执行 Git 提交；2026-10-21 按用户授权整理为 0.2.4 并进行提交、推送。
- **没有做全站浏览器 E2E**：库存页的批量选择交互在隔离环境实测通过，
  但推荐/烹饪等页面仍未逐屏走真实浏览器流程。
- 候选 40 / 组合 20000 的上限**未改动**；「候选截断可能丢掉某种主菜」属于已知限制，
  本版未处理，也未被证实为真实故障。
- `verify-v024-main-dish` 的 HTTP 段覆盖响应契约与只读性，但不替代浏览器验收。

## 7. 2026-10-21 发布复核

- 根目录、client、server 及 package-lock 版本统一为 0.2.4；更新 README 与 CHANGELOG。
- 前后端 `npm run build` 通过；10 组隔离数据库专项 / 回归共 493 项通过、0 项失败。
- 各组通过数：主菜 38、调味品 44、防重复 25、标签迁移 12、批量删除 15、内容包 40、库存计划 11、规模 8、v022 推荐 127、v023 标签偏好 173。
- 标签迁移测试原硬编码数量遗漏「西式家常」，已修正为 13（川菜由同名自定义占用），并显式验证西式家常预设存在。
- Windows 下 npx 启动器曾在主菜断言全通过后退出时触发 libuv 句柄错误；改用 `node --import tsx` 后上述各组退出码均为 0。
- 本次没有执行真实数据库迁移或修改真实库存；未补做全站浏览器 E2E。
