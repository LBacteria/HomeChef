# Changelog

HomeChef 的版本变更记录。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

（暂无）

---

## [0.2.1] - 2026-10-14

烹饪闭环：菜谱步骤、烹饪会话、结算与库存扣减。

> ⚠️ 本版本**不包含**菜谱推荐、AI、采购清单、单位换算。
> 结算**不做**自动单位换算：单位与库存不一致的原料必须由用户逐项确认跳过。

### Added

**数据库（迁移 `0009` / `0010`）**

- 新增六张表：`recipe_step`（菜谱步骤）、`cooking_session`（烹饪会话）、
  `cooking_session_dish`（会话中的菜品，含份数与进度）、
  `cooking_settlement`（结算凭证）、`cooking_settlement_item`（结算明细，含跳过项）、
  `cooking_session_dish_skip`（逐项跳过确认），迁移文件 `0009_cooking_tables.sql`
- `recipe` 新增 `content_revision`（菜谱内容版本号，内容变化时递增）
- `recipe_ingredient` 新增 `line_key`（食材行的**稳定标识**），
  迁移 `0010_recipe_ingredient_line_key.sql` 回填历史行并建立唯一索引
- **幂等核心**：`cooking_settlement.session_id` 上的 UNIQUE 约束，
  使并发下只有一个事务能成功写入凭证

**菜谱步骤**

- 步骤保存整合进 `PATCH /api/recipes/:id/full` 统一保存事务（顺序即 `step_no`）
- 菜谱详情返回 `steps` 与 `content_revision`
- 前端菜谱表单支持步骤的增删改与上下移动；菜谱详情页展示步骤列表

**烹饪会话 API**

- `GET /api/cooking/sessions`、`POST /api/cooking/sessions`、
  `GET /api/cooking/sessions/:id`、`POST /api/cooking/sessions/:id/abandon`
- `POST|PATCH|DELETE /api/cooking/sessions/:id/dishes[/:dishId/...]`
  （加菜 / 改份数 / 改进度 / 删菜）
- **重复添加同一菜谱合并份数**（由 `UNIQUE(session_id, recipe_id)` 保证）
- 会话状态流转：`active` → `cooking` → `awaiting_settlement` → `settled`（终态）；
  `settled` / `abandoned` 均不可再修改

**跳过确认**

- `GET|POST /api/cooking/sessions/:id/skips`、
  `DELETE /api/cooking/sessions/:id/dishes/:dishId/skips/:lineKey`
- 逐项确认以 `(dish_id, line_key)` 唯一标识，避免同食材同单位的多条需求确认错项
- `confirmed_revision` 为**派生值**：只有全部必需确认项均已确认才写入当前会话版本，
  部分确认一律为 `0`

**结算**

- `GET /api/cooking/sessions/:id/settle/preview`（只读预览）
- `POST /api/cooking/sessions/:id/settle`（执行结算）
- 库存按**到期日优先**扣减：有到期日的优先，按到期日升序，`NULL` 到期日排最后
- 结算在**单一事务**内完成库存扣减、凭证写入、明细写入与会话状态变更；
  任一失败整体回滚，不留部分扣减

**前端烹饪页**

- 新增「烹饪」导航入口与烹饪页面：会话列表、会话详情、
  菜品管理、步骤进度、跳过确认、结算预览与结算结果展示
- 结算前会先保存所有待提交的份数变更并重新拉取服务端预览，
  份数保存失败或预览不就绪时不执行结算

### Changed

- 导航顺序为 **库存 / 食材库 / 菜谱 / 烹饪 / 设置**（新增「烹饪」入口）
- `saveRecipeFull` 改为**先比较内容再决定是否写入**：
  内容完全相同时不重建食材与步骤、不递增 `content_revision`、不触碰会话
- 菜谱内容变化时，引用该菜谱的**未结算**会话整体失效
  （`recipe_revision` 递增、跳过确认清空、`confirmed_revision` 归零），
  且与菜谱保存位于**同一事务**
- 菜谱保存时，未改动的食材行 `line_key` 保持不变；
  `definition_id` 或 `unit` 变化时生成新标识

### Fixed

- **修复 `verify` 脚本与迁移入口的数据库路径安全隐患**：
  `assertSafeDbPath()` 提取为 `server/src/db/safe-db-path.ts` 单一实现，
  由 harness 与迁移入口共用；`db:migrate` 改为**先校验路径再动态导入数据库模块**，
  未设置 `HOME_CHEF_DB_PATH` 或路径指向真实库时在打开数据库之前退出

### 已知限制（**未验证事项**）

> ⚠️ 以下内容在 v0.2.1 发布时**尚未取得直接验证证据**，如实记录，不得视为已通过：

- 场景 B（重复结算）与场景 D（跳过确认重校验）的**具体错误码**未从响应体取得直接证据，
  仅确认返回 HTTP **409**
- **前端并发/竞态**（改份数后立即点结算）**未经真实 UI 验证**，
  后端只验证了顺序请求语义
- 结算凭证表的**精确行数**无查询 API，只能通过 409 响应间接推断
- 场景 A 的**到期日优先扣减顺序**未重新验证
  （曾判定为缺陷，后经 SQL 构造诊断撤销该判定）
- 迁移 `0010` 的 `line_key` **回填结果未逐行核对**
- 库存单位发生「不匹配 → 匹配」变化时，不会主动失效既有确认
  （安全性依赖结算时的重新计算）


## [0.2.0] - 2026-10-12

菜谱模块（Phase 3）与库存搜索。

> ⚠️ 本版本**不包含**菜谱推荐、库存联动（判断能否制作）、AI、购物清单、
> 库存扣减、份数系统、照片与完整制作流程编辑 —— 见 `PROJECT_SPEC.md` 4.2.8。

### Added

**菜谱模块（Phase 3）**

- 数据库新增四张表：`recipe`（菜谱主表）、`recipe_ingredient`（菜谱与食材定义的关系，
  **允许重复关联同一食材**）、`recipe_tag`（Tag）、`recipe_tag_link`（菜谱与 Tag 的关系），
  迁移文件 `0007_recipe.sql`。详见 `DATABASE_DESIGN.md` 第 16 节
- 菜谱列表设置持久化：复用单行表 `app_settings` 新增 4 个可空列
  （`recipe_sort_field` / `recipe_sort_order` / `recipe_tag_mode` / `recipe_selected_tags`），
  迁移文件 `0008_recipe_list_settings.sql`
- 后端菜谱 API：`GET /api/recipes`、`GET /api/recipes/:id`、`POST /api/recipes`、
  `PATCH /api/recipes/:id/full`（统一保存）、`DELETE /api/recipes/:id`，
  以及 `GET /api/tags`、`POST /api/tags`、`DELETE /api/tags/:id`、
  `GET /api/recipe-list-settings`、`PATCH /api/recipe-list-settings`
- **菜谱页面**（三行布局）：
  - 第一行：「新建菜谱」入口
  - 第二行：**名称搜索**（左）+ 排序控件（右）
  - 第三行：已选 Tag（左）+「选择 Tag」按钮（右）
- **名称搜索**：只匹配菜谱名称，大小写不敏感、子字符串匹配
- **Tag 筛选**：独立弹窗，支持多选、**AND / OR** 模式、新建 Tag、取消与确认；
  支持逐个移除已选 Tag
- **排序**：最近修改时间 / 创建时间 / 菜谱名称 × 升序降序
- **列表设置持久化**：排序字段、排序方向、Tag 选择与 AND/OR 模式写入数据库，
  刷新后保留；**搜索词不持久化**
- **新建菜谱**：名称、描述、多项配料（食材 + 数量 + 单位 + 备注，**允许重复选择同一食材**）、
  Tag 多选；保存失败保留输入，可重试
- **菜谱详情页**：展示名称、描述、Tag、食材（名称 / 数量 / 单位 / 备注 / 顺序），
  并对无描述 / 无食材 / 无 Tag 给出明确提示
- **菜谱编辑**：从详情进入，完整回填原有数据，可增删改食材行与 Tag；
  取消不产生任何写入
- **菜谱删除**：详情页入口 + 二次确认；取消确认不调用删除 API
- **库存搜索**：库存页新增搜索栏，按库存记录对应的食材名称做本地过滤，
  与分类筛选、排序并行工作

### Changed

- 导航顺序为 **库存 / 食材库 / 菜谱 / 设置**（新增「菜谱」入口）
- **菜谱名称搜索不再匹配 Tag 名称**（产品决策变更）：
  搜索与 Tag 筛选为两个独立能力，Tag 名只能通过 Tag 筛选命中；
  搜索与 Tag 筛选同时使用时为 **AND** 关系

### Fixed

**Chrome 误识别车牌号**

- 菜谱新建/编辑表单中的数量输入框原先为「无 `name` + `type=text` + `placeholder=数量`」，
  Chrome 155 的 Autofill 服务端启发式会把**第二个**数量框预测为
  `VEHICLE_LICENSE_PLATE`（车牌号），提交时弹出「保存车牌号」提示。
  现为数量框补充语义明确的 `name`、`autocomplete="off"` 与数字输入类型
  （`type="number"` + `step="any"` + `min="0"`），并隐藏原生 spinner

**日期计算基准**

- 后端 `todayDateString()` 原先取 **UTC 日期**，而前端 `client/src/format.ts`
  取**本地日历日期**，两者在 UTC+8 时区的北京时间 00:00–08:00 之间会相差一天，
  导致：默认入库日期被填成昨天、临期 / 过期状态晚一天、前后端"今天"显示不一致。
  现改为统一按**用户本地日历日期**取值（提交 `56345b3`）
- `addDays` / `compareDates` 等**纯日期运算**保持 UTC 实现不变 ——
  纯日期字符串运算不涉及时区，无需改动
- `todayDateString()` 新增可选参数 `now`（仅供测试注入固定时刻，业务调用不传）

**日期测试补强**

- 新增 `server/verify-dates.ts`（提交 `56345b3`，提交 `b2a9e7a` 补强）：
  覆盖跨月 / 跨年 / 闰年 / 世纪末、临期与过期状态、API 端到端，
  以及 UTC / UTC+8 / UTC-5 三种时区边界
- 时区测试通过**独立子进程注入 `TZ`**，结果可重复且不依赖执行机器的时区
- 新增 `server/_tz-probe.ts`：直接调用真实 `todayDateString(固定时刻)`，
  并含"若退回 UTC 取值则必须失败"的回归保护
- 修正 `server/verify-v014-category-color.ts` 的删除保护前置条件
  （临时库未跑 seed，原断言缺少"分类仍被使用"的前提）
- `server/verify-dates.ts` 去除一处恒真断言（`|| true`），
  并新增辅助函数 `pickYmd()` 的字段缺失 / 空字符串 / 位数异常分支测试

**保存重复提交**

- 菜谱表单的保存按钮仅依赖 `disabled={saving}` 防重，而 React 状态更新是异步的，
  同一事件循环内的连续点击会重复提交（实测同步连点 5 次产生 5 个 POST）。
  现改用组件内的**同步提交锁**（`submittingRef`），连点只产生 1 次请求

**详情请求竞态**

- 菜谱详情请求新增序号校验丢弃过期响应；组件卸载时一并失效在途请求，
  避免写入已卸载组件

---

## [0.1.4] - 2026-10-10

分类颜色、食材快捷编辑统一保存与内置食材数据维护。

### Added

**分类颜色**

- `category` 表新增 `color` 字段（migration `0006_category_color.sql`），
  格式固定为 `#RRGGBB`，默认值 `#9E9E9E`
- `PATCH /api/categories/:id`：更新分类颜色
  （JSON Schema `pattern` + Service 层双重校验）
- 19 个内置分类各自的默认配色；用户自定义分类按 id 稳定分配调色板颜色
- 设置 → 分类：每个分类单独配置颜色，附 12 个常用颜色预设

**库存分类标签**

- 库存列表所有食材在名称右侧显示分类标签，背景色取自该分类的 `color`
- 标签文字颜色按背景亮度自动选用深色 / 白色，保证可读性
- 复用已加载的分类数据，不额外发起请求

**食材快捷编辑统一保存**

- 新增 `PATCH /api/definitions/:id/full`：把基础字段（名称 / 分类 / 保质期）、
  别名、允许单位与「设为默认」整合到**同一个数据库事务**
- 食材快捷编辑弹窗所有字段改为统一草稿，只在点「保存」时提交

### Changed

- 食材快捷编辑弹窗底部只保留一个「保存」按钮；
  别名与单位不再即时写入数据库，取消 / 关闭会丢弃全部未保存修改
- 「设为默认」保持原有的名称 ↔ 别名交换语义，改为随统一保存一起提交

### Fixed

- 修复「设为默认」与其他字段分多次请求提交时的**部分成功**问题：
  原实现中若名称交换成功而后续请求失败，用户重试会用到已被删除的
  别名 id 而得到 404，陷入无法恢复的状态。改为单事务后，失败即整体回滚，
  重试始终安全
- 内置食材数据重建：修复 `seed_ingredient_map.definition_id` 全部失联
  （229 / 229 为 NULL）导致 `db:seed` 全部跳过的问题；重建后别名
  3 → 144、单位配置 13 → 667

### Security

- 启动脚本 `Start-HomeChef.bat` 不再自动打开浏览器，
  改为提示用户手动访问打印出的前端地址
  （不修改端口、代理或服务监听行为）

---

## [0.1.3] - 2026-10-07

食材分类体系与调味品支持。

### Added

**食材分类**

- 新增 `category` 表（migration `0005_category.sql`）
- `ingredient_definition` 新增 `category_id` 外键
  （`ON UPDATE CASCADE` / `ON DELETE RESTRICT`）
- **19 个默认分类**：蔬菜、水果、猪肉、牛肉、羊肉、其他畜肉、
  鸡肉、鸭肉、鹅肉、其他禽肉、水产、蛋类、豆制品、乳制品、
  主食/谷物、干货/菌菇、冷冻食品、调味品、其他/饮品
- 分类 API：`GET /api/categories`、`POST /api/categories`、`DELETE /api/categories/:id`
- 分类管理界面：设置页入口 + 应用内 Modal（新建 / 删除 / Escape 关闭 / 列表滚动）

**分类筛选**

- 食材库支持按分类筛选，可与搜索、名称排序组合使用
- 库存页支持按分类筛选，可与排序组合使用

**调味品特殊行为**

- 调味品为 **presence-only**：库存只表达「有 / 无」，不管理数量
- 调味品定义**不要求允许单位**（`allowed_units` 可为空数组），不要求保质期
- 调味品库存使用内部兼容值（B2 方案，不修改 `standard_ingredient` 结构）：
  `quantity = 0` / `unit = '个'` / `purchase_date = today` /
  `storage_method = '常温'` / `expiry_date = NULL` / `expiry_date_source = NULL`
- 调味品库存显示为「有」，不显示数量 / 单位 / 日期 / 储存方式
- 调味品不参与临期计算

### Changed

- `GET /api/definitions` 新增 `category_id` 查询参数
- `GET /api/ingredients` 新增 `category_id` 查询参数，并返回
  `category_id` 与 `is_seasoning` 字段
- `POST /api/definitions` 的 `units` 不再是必填，且允许为空数组
  （由 Service 层区分普通食材与调味品）
- `POST /api/ingredients` 的 `quantity` / `unit` 不再是必填
  （调味品由 Service 填充兼容值；普通食材仍由 Service 强制要求）
- 内置食材的分类重新映射：`畜肉` 拆分为猪肉 / 牛肉 / 羊肉 / 其他畜肉，
  `禽肉` 拆分为鸡肉 / 鸭肉 / 鹅肉 / 其他禽肉，`食用油` 并入 `调味品`
- `冷冻食品` 语义明确为「食材本身就是冷冻 / 速冻成品或半成品」，
  与储存方式无关

### Fixed

- 库存跨分类切换：普通食材与调味品之间直接切换会静默产生语义错误的数据，
  现返回 `409 CATEGORY_TRANSITION_NOT_ALLOWED`
- 调味品 → 调味品切换时，不再因内部兼容单位 `个` 不在空的
  `allowed_units` 中而被误拒

---

## [0.1.2] - 2026-10-07

设置、临期规则与排序。

### Added

**应用设置**

- 新增 `app_settings` 单行设置表（migration `0004_app_settings.sql`）
- `GET /api/settings`、`PATCH /api/settings`
- 临期预警模式：`days`（天数阈值）/ `percentage`（百分比阈值）
- `allow_expired_for_recipe` 设置项（当前仅保存，供后续食谱功能使用）
- 设置页面

**临期状态**

- 四种状态：`no_expiry` / `normal` / `expiring` / `expired`
- 已过期**优先于**临期；到期当天算临期
- 百分比阈值按 `ceil(总保质期天数 × 阈值 / 100)` 折算成天数后比较
  （不是直接比较剩余百分比）
- 返回 `days_remaining` 与 `remaining_percentage`（后者仅用于展示）
- 库存列表的临期状态可视化标记

**排序**

- 库存排序：`default`（临期优先）/ `expiry` / `purchase_date` / `name` / `quantity`，
  均支持 `asc` / `desc`；无保质期的记录在两个方向上都排在最后
- 食材库排序：名称 `A → Z` / `Z → A`，默认 `A → Z`
- 排序由后端执行，前端只传参；不持久化排序偏好

### Changed

- 库存列表新增 `expiry_status` / `days_remaining` / `remaining_percentage` 字段
- `GET /api/ingredients` 新增 `sort` / `order` 查询参数（白名单校验）
- `GET /api/definitions` 新增 `sort` / `order` 查询参数（白名单校验）

---

## [0.1.1] - 2026-10-05

启动器与内置食材种子数据。

### Added

**Windows 启动器**

- `Start-HomeChef.bat` 一键启动前后端
- 基于 Windows Job Object 的进程管理，关闭窗口时可靠清理后台进程

**内置食材种子数据**

- 229 个内置食材定义（`server/seed/builtin-ingredients.ts`）
- seed 基础设施表：`seed_history`、`seed_ingredient_map`（migration `0003_seed_infrastructure.sql`）
- seed 为 **INSERT-only**，不覆盖用户修改，可安全重复执行
- 用户删除过的内置食材**不会**被重新创建

**食材选择器**

- 添加库存时的食材搜索选择器（复用食材库的包含匹配搜索）

### Fixed

- 食材定义自动合并（Phase 3.1）：更换库存所属食材时按规则合并同批次记录

---

## [0.1.0] - 2026-10-02

首个版本，实现基础食材库存管理。

### Added

**食材库存管理**

- 基础食材库存管理
- 添加、查看、编辑、删除食材
- 消耗食材并扣减库存
- 库存不足时拒绝消耗（不允许负库存）
- 购买日期、过期日期、备注

**食材别名**

- 食材别名后端 API（一个标准食材可有多个别名，一个别名只属于一个标准食材）
- 别名与标准名称的跨表唯一性检查

**数据校验**

- 基础数量校验（有限的非负数字，拒绝 NaN / Infinity）
- 单位校验（限定在固定单位枚举内）
- 日期关系校验（过期日期不能早于购买日期）

**界面**

- React 前端库存页面（列表、添加、编辑、消耗、删除）

### Technical

- React + TypeScript + Vite
- Node.js + TypeScript + Fastify
- SQLite + Drizzle ORM
- 分层架构（Frontend → API → Service → Database）
- 数据库约束：唯一约束、外键级联删除、CHECK 约束
- 统一错误响应格式
