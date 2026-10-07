# Changelog

HomeChef 的版本变更记录。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
