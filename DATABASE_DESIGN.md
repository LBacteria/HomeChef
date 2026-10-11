# HomeChef 数据库设计

> 状态：Draft
> 日期：2026-10-02
> 适用范围：**库存系统 v0.1（当前已实现）**
> 数据库：SQLite + Drizzle ORM

## 0. 本文档的范围

本文档描述 **HomeChef 库存系统 v0.1** 的数据库设计，与当前实际 schema 和 migration 一致。

- 上游依据：`PROJECT_SPEC.md`、`TECH_STACK.md`、`ARCHITECTURE.md`
- 实际实现在 `server/src/db/schema.ts` 与 `server/drizzle/`

### 当前决策清单

| # | 决策 |
|---|---|
| 1 | `ingredient_definition.id` 是稳定身份，使用 `INTEGER PRIMARY KEY AUTOINCREMENT` |
| 2 | 删除后的定义 ID 不复用；重命名不改变 ID |
| 3 | 一个定义只有一个默认名称 |
| 4 | 一个定义可以有 0..N 个别名 |
| 5 | 一个别名全局只能属于一个定义 |
| 6 | 默认名称与别名都不能跨表重名（由 Service 检查） |
| 7 | 一个定义可以有 **0..N 条库存记录**（**无** `UNIQUE(definition_id)`） |
| 8 | 每个定义至少有一个允许单位 |
| 9 | 库存单位必须属于该定义的允许单位 |
| 10 | 删除定义时，别名与允许单位级联删除；**库存不级联删除** |
| 11 | 有库存记录时拒绝删除定义（`HAS_STOCK`） |
| 12 | 不记录 consumption history |
| 13 | 不做单位换算 |
| 14 | 不允许负库存 |
| 15 | 数量允许实数（REAL） |
| 16 | 单位使用固定枚举 |
| 17 | `purchase_date`（入库日期）必填，默认当天 |
| 18 | `production_date` 可为空，**绝不反推** |
| 19 | `expiry_date` 可为空，其来源记录在 `expiry_date_source` |
| 20 | `expiry_date` 与 `expiry_date_source` 必须成对一致 |
| 21 | 不提前设计菜谱、推荐、AI、采购清单、多用户等表 |
| 22 | 不设计定义合并表或相关机制 |
| 23 | 储存方式（常温/冷藏/冷冻）是库存属性，当前不影响保质期计算 |

---

## 1. 数据库设计目标

1. **正确**：名称唯一性、别名全局唯一、库存非负等关键规则尽可能由数据库强制
2. **身份稳定**：定义 ID 不复用，改名不影响关联
3. **简单**：只有 4 张表，没有为未来功能预留的字段和表
4. **可读**：能用 SQLite 命令行工具直接看懂数据
5. **可维护**：字段含义明确，约束有明确理由
6. **类型安全**：配合 Drizzle 在 TypeScript 侧获得可靠类型
7. **能可靠比较和扣减**：数量的存储方式必须保证"够不够"和"扣多少"不会因精度问题出错

---

## 2. ER / 表关系

当前有 **4 张表**：

```
┌──────────────────────────────────────────────┐
│  ingredient_definition（食材定义）             │
│  ──────────────────────────────────────────  │
│  PK  id                        INTEGER       │
│        ↑ AUTOINCREMENT（ID 永不复用）          │
│      name                      TEXT NOT NULL │
│      name_normalized           TEXT NOT NULL UNIQUE
│      estimated_shelf_life_days INTEGER NULL  │
│      created_at / updated_at   TEXT NOT NULL │
└───┬────────────────────────┬─────────────────┘
    │                        │
    │ 1 : N                  │ 1 : N
    │ ON DELETE CASCADE      │ ON DELETE CASCADE
    ▼                        ▼
┌──────────────────────┐  ┌──────────────────────────────┐
│  ingredient_alias    │  │  ingredient_definition_unit  │
│  ──────────────────  │  │  ──────────────────────────  │
│  PK  id              │  │  PK  id                      │
│  FK  definition_id   │  │  FK  definition_id           │
│      alias           │  │      unit                    │
│      alias_normalized│  │      created_at              │
│        UNIQUE        │  │  UNIQUE(definition_id, unit) │
│      created_at      │  │  CHECK(unit IN 10 个枚举)     │
└──────────────────────┘  └──────────────────────────────┘

    ┌───────────────────────────────────────────────┐
    │ 1 : N  ⚠️ definition_id **没有 UNIQUE**         │
    │ ON DELETE RESTRICT（删定义不级联删库存）         │
    ▼
┌────────────────────────────────────────────────┐
│  standard_ingredient（库存记录）                │
│  ──────────────────────────────────────────    │
│  PK  id                    INTEGER             │
│  FK  definition_id         INTEGER NOT NULL    │
│      quantity              REAL NOT NULL DEF 0 │
│        CHECK(quantity >= 0)                    │
│      unit                  TEXT NOT NULL       │
│        CHECK(unit IN 10 个枚举)                 │
│      purchase_date         TEXT NOT NULL       │
│      production_date       TEXT NULL           │
│      expiry_date           TEXT NULL           │
│      expiry_date_source    TEXT NULL           │
│      storage_method        TEXT NOT NULL       │
│        DEFAULT '常温'                           │
│        CHECK(IN 常温/冷藏/冷冻)                  │
│      note                  TEXT NULL           │
│      created_at / updated_at TEXT NOT NULL     │
│                                                │
│  CHECK: expiry 与 source 成对一致                │
│  CHECK: production_date <= purchase_date       │
│  CHECK: manual expiry >= purchase_date         │
└────────────────────────────────────────────────┘
```

**关系说明：**

| 关系 | 基数 | 删除行为 |
|---|---|---|
| ingredient_definition → ingredient_alias | 1 : N | CASCADE |
| ingredient_definition → ingredient_definition_unit | 1 : N | CASCADE |
| ingredient_definition → standard_ingredient | **1 : N** | **RESTRICT** |

**关键设计点：**

1. **名称不是身份。** 名称与别名是可以修改的显示/搜索属性，所有关联使用 `definition_id`。
2. **同一食材可以有多条库存记录。** 例如「土豆 3 个」「土豆 1 袋」「土豆 1 千克」是三条独立记录。
3. **库存不随定义删除。** 外键使用 RESTRICT，Service 在其中提前检查并返回 `HAS_STOCK`。

---

## 3. `ingredient_definition` 字段设计

| 字段名 | SQLite 类型 | NOT NULL | 默认值 | UNIQUE | 用途 |
|---|---|---|---|---|---|
| `id` | INTEGER | ✅ | — | PK | 稳定身份，**AUTOINCREMENT** |
| `name` | TEXT | ✅ | — | ❌ | 默认名称（显示用，保留用户输入形式） |
| `name_normalized` | TEXT | ✅ | — | ✅ | 归一化名称，用于匹配与唯一性 |
| `estimated_shelf_life_days` | INTEGER | ❌ | NULL | ❌ | 默认预估保质期（天），用于**新库存**的到期日估算 |
| `created_at` | TEXT | ✅ | — | ❌ | ISO 8601 时间戳 |
| `updated_at` | TEXT | ✅ | — | ❌ | ISO 8601 时间戳 |

**CHECK 约束：**

```sql
CHECK (estimated_shelf_life_days IS NULL OR estimated_shelf_life_days >= 0)
```

允许 `0`（表示当天到期），不允许负数。暂不设人为上限。

### 3.1 为什么必须使用 AUTOINCREMENT

`ingredient_definition.id` 是食材的**稳定内部身份**，要求「删除后 ID 永不复用」。

普通 `INTEGER PRIMARY KEY`（rowid 别名）**不能**提供这个保证：

- SQLite 分配新 rowid 的算法是「当前最大 rowid + 1」
- 若删除了最大 ID 的那一行，下一行会**重新使用**该 ID

**实测对照：**

| 表类型 | 操作 | 结果 |
|---|---|---|
| 普通 `INTEGER PRIMARY KEY` | 插入 1,2,3 → 删 id=3 → 再插入 | ❌ 新记录复用 **id=3** |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | 同上 | ✅ 新记录使用 **id=4** |

AUTOINCREMENT 会创建 `sqlite_sequence` 表记录历史最大 ID，保证新 ID 严格递增、永不复用。

**代价**：多一张内部表 + 每次插入一次额外查找。
对「ID 即身份」的要求而言，这个代价是必须付的。

> 其他三张表（alias / unit / stock）**不使用** AUTOINCREMENT：
> 它们的 ID 只是行标识，不复用没有业务含义。

### 3.2 `name` 与 `name_normalized` 的区别

- `name` 保存**显示用**的原始形式（仅去首尾空格，不改写大小写）
- `name_normalized` 保存**匹配用**的归一化形式（`trim().toLowerCase()`）
- UNIQUE 约束**只建在 `name_normalized` 上**

这样 `番茄` 和 ` 番茄 ` 会被判定为重复，但显示时保留用户原本的写法。

**为什么 `name` 不设 UNIQUE：** `name` 保留原始大小写，若加 UNIQUE 会与归一化语义冲突
（`Tomato` 与 `tomato` 是同一个食材，但 `name` 列是两个不同值）。

---

## 4. `ingredient_alias` 字段设计

| 字段名 | SQLite 类型 | NOT NULL | 默认值 | UNIQUE | 用途 |
|---|---|---|---|---|---|
| `id` | INTEGER | ✅ | — | PK | 主键 |
| `definition_id` | INTEGER | ✅ | — | ❌ | 外键 → `ingredient_definition.id`，`ON DELETE CASCADE` |
| `alias` | TEXT | ✅ | — | ❌ | 别名原文（显示用） |
| `alias_normalized` | TEXT | ✅ | — | ✅ **全局唯一** | 归一化别名，用于匹配 |
| `created_at` | TEXT | ✅ | — | ❌ | ISO 8601 时间戳 |

**注意**：`alias` 本身**不加** UNIQUE，只对 `alias_normalized` 加——否则 `TomatO` 和 `tomato` 会被当成两个不同别名。

**`definition_id` 上有索引**，用于「查某定义的所有别名」以及级联删除定位子行。

### 4.1 别名绑定在 definition 上（不是库存记录上）

这是刻意的设计：

- 别名描述的是「这个食材还叫什么」，与「现在有多少」无关
- 若绑定到库存记录，删除库存会导致别名消失——那会丢失食材知识

### 4.2 别名不会自动从名称迁移

`ingredient_definition.name` **不是** `ingredient_alias` 中的一行。
默认名称切换时由 Service 在事务内同时更新两处（旧名称转为别名、新名称从别名删除）。

---

## 5. `ingredient_definition_unit` 字段设计

| 字段名 | SQLite 类型 | NOT NULL | 默认值 | UNIQUE | 用途 |
|---|---|---|---|---|---|
| `id` | INTEGER | ✅ | — | PK | 主键 |
| `definition_id` | INTEGER | ✅ | — | ❌ | 外键 → `ingredient_definition.id`，`ON DELETE CASCADE` |
| `unit` | TEXT | ✅ | — | ❌ | 允许单位（10 个枚举之一） |
| `created_at` | TEXT | ✅ | — | ❌ | ISO 8601 时间戳 |

**约束：**

- `UNIQUE(definition_id, unit)` —— 同一食材不重复声明同一单位
- `CHECK(unit IN ('个','克','千克','毫升','升','包','袋','瓶','盒','罐'))`

**「至少一个允许单位」由 Service 保证**（数据库无法表达「每行至少有一条子记录」这类跨行约束）：

- 创建定义时要求 `units` 非空
- 移除单位时若已是最后一个则拒绝

---

## 6. `standard_ingredient` 字段设计

| 字段名 | SQLite 类型 | NOT NULL | 默认值 | 用途 |
|---|---|---|---|---|
| `id` | INTEGER | ✅ | — | **库存记录 ID**（消耗/编辑/删除用它） |
| `definition_id` | INTEGER | ✅ | — | 外键 → `ingredient_definition.id`，**无 UNIQUE** |
| `quantity` | REAL | ✅ | `0` | 当前数量 |
| `unit` | TEXT | ✅ | — | 单位（须在该定义的允许单位内） |
| `purchase_date` | TEXT | ✅ | — | **入库日期**，YYYY-MM-DD |
| `production_date` | TEXT | ❌ | NULL | 生产日期，可为空 |
| `expiry_date` | TEXT | ❌ | NULL | 到期日期 |
| `expiry_date_source` | TEXT | ❌ | NULL | `estimated` / `manual` / NULL |
| `storage_method` | TEXT | ✅ | `'常温'` | 常温 / 冷藏 / 冷冻 |
| `note` | TEXT | ❌ | NULL | 备注 |
| `created_at` | TEXT | ✅ | — | ISO 8601 时间戳 |
| `updated_at` | TEXT | ✅ | — | ISO 8601 时间戳 |

### 6.1 CHECK 约束

```sql
-- 数量非负
CHECK (quantity >= 0)

-- 单位枚举
CHECK (unit IN ('个','克','千克','毫升','升','包','袋','瓶','盒','罐'))

-- 储存方式枚举
CHECK (storage_method IN ('常温','冷藏','冷冻'))

-- 到期日期与来源成对一致
CHECK (CASE
  WHEN expiry_date IS NULL
    THEN CASE WHEN expiry_date_source IS NULL THEN 1 ELSE 0 END
  ELSE CASE
    WHEN expiry_date_source IS NULL THEN 0
    WHEN expiry_date_source IN ('estimated','manual') THEN 1
    ELSE 0
  END
END)

-- 生产日期不晚于入库日期
CHECK (production_date IS NULL OR production_date <= purchase_date)

-- manual 到期日期不早于入库日期
CHECK (CASE
  WHEN expiry_date IS NULL THEN 1
  WHEN expiry_date_source = 'estimated' THEN 1
  WHEN expiry_date >= purchase_date THEN 1
  ELSE 0
END)
```

### 6.2 ⚠️ CHECK 约束必须避免 SQL 三值逻辑

SQLite 的 CHECK 约束**只在结果为 FALSE(0) 时拒绝，结果为 NULL 时放行**。

早期版本曾写成：

```sql
-- ❌ 错误写法：会被 NULL 绕过
CHECK ((expiry_date IS NULL AND expiry_date_source IS NULL)
       OR (expiry_date IS NOT NULL AND expiry_date_source IN ('estimated','manual')))
```

当 `expiry_date` 有值而 `expiry_date_source` 为 NULL 时，`NULL IN (...)` 求值为 **NULL**，
整体结果既不是 TRUE 也不是 FALSE 而是 NULL → **约束被绕过，非法数据可以写入**。

因此当前实现使用显式返回 0/1 的 `CASE` 表达式。

> **教训**：只检查 DDL 文本（"约束写在那儿了"）不足以确认约束有效，**必须做行为测试**。

### 6.3 为什么 estimated 到期日期允许早于入库日期

例：生产日期 9/28、入库日期 10/2、保质期 2 天 → estimated 到期 9/30 **早于**入库日期。

这是合法状态，表示「按默认保质期估算，入库时已经超过预计日期」。

因此 `manual_expiry_not_before_purchase` 这一约束**只对 manual 生效**。

### 6.4 为什么不使用 UNIQUE(definition_id)

这是 v0.1 的核心模型决策：

- 同一食材可能有多批，单位/日期/储存方式都可能不同
- 在「不做单位换算」的前提下，`3 个` 与 `1 袋` **无法合并**
- 因此一个定义对应 **0..N** 条库存记录

---

## 7. 数量存储方案

### 7.1 需求

| 需求 | 来源 |
|---|---|
| 支持实数 | 决策 15 |
| 不允许负数 | 决策 14 |
| 不需要单位换算 | 决策 13 |
| 需要可靠的比较和扣减 | 设计目标 7 |
| 显示时可以格式化 | 用户体验 |

### 7.2 方案对比

| 维度 | A. REAL | B. 整数缩放 | C. TEXT/Decimal |
|---|---|---|---|
| 精度 | ⚠️ 有浮点误差 | ✅ 精确 | ✅ 精确 |
| 实现复杂度 | ✅ 最低 | ❌ 高（全链路缩放） | ❌ 高（需 decimal 库） |
| 数据库 CHECK 能表达 `>= 0` | ✅ 能 | ✅ 能 | ❌ **不能** |
| 数据库能比较/排序 | ✅ 能 | ✅ 能 | ❌ 不能 |
| Drizzle 映射 | ✅ `number` | ⚠️ 需转换层 | ⚠️ 别扭 |

### 7.3 最终选择：REAL + Service 层舍入

**选择 REAL。**

理由：

1. **v0.1 的真实规模不构成精度问题**——家庭食材日常操作是「6 个鸡蛋减 2 个」「1.5 千克减 0.5 千克」，
   这类值在 IEEE 754 下的误差是 `1e-16` 量级，远低于显示精度。
2. **方案 B / C 的复杂度是为未来需求提前付费**，违背「简单优先」。
3. **方案 C 的代价不可接受**——它让 `quantity >= 0` 无法在数据库层强制。
4. **方案 A 保留了完整的数据库约束能力**（CHECK、比较、排序、索引）。

**配套措施**（集中在 `server/src/services/quantity.ts`）：

| 措施 | 说明 |
|---|---|
| ① 写入前舍入 | 舍入到 **3 位小数**（`QUANTITY_DECIMALS = 3`） |
| ② 扣减后钳制 | 容差 `1e-9`（`QUANTITY_EPSILON`）内的负值钳制为 0 |
| ③ 显示时格式化 | 前端 `formatQuantity()` 舍入后再显示 |
| ④ 比较用容差 | 「库存是否足够」使用容差比较，而非严格 `>=` |

**何时重新评估**：需要单位换算、出现金额字段、或实际观察到累积误差导致问题。

---

## 8. 日期存储方案

### 8.1 存储形式

**选择：`TEXT`，ISO 8601 格式。**

| 字段 | 格式 | 示例 |
|---|---|---|
| `purchase_date` | `YYYY-MM-DD` | `2026-10-02` |
| `production_date` | `YYYY-MM-DD` | `2026-09-28` |
| `expiry_date` | `YYYY-MM-DD` | `2026-10-10` |
| `created_at` / `updated_at` | `YYYY-MM-DDTHH:MM:SS.sssZ` | `2026-10-02T06:41:07.000Z` |

**为什么用 TEXT + ISO 8601：**

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **TEXT / ISO 8601** | **人可读**；**字典序 = 时间序**；时区明确；JS `Date` 直接解析 | 占空间略大（无所谓） | ✅ **采用** |
| REAL / 儒略日 | 紧凑 | 完全不可读，调试困难 | ❌ |
| INTEGER / Unix 时间戳 | 紧凑、比较快 | 不可读；日期无时区概念却用时区时间戳 | ❌ |

**「字典序 = 时间序」是关键优势**：`'2026-10-02' <= '2026-10-15'` 在字符串比较下结果正确
（ISO 8601 定长、高位在前）。这让日期比较、排序、CHECK 约束都能直接用字符串运算符完成。

### 8.2 日期计算必须 UTC 安全

日期加法在 `server/src/services/dates.ts` 中实现：

- 解析为 UTC 午夜，用 `setUTCDate` / `getUTCDate` 运算，输出 `YYYY-MM-DD`
- **不使用** `new Date(year, month, day)` 这类受本地时区影响的构造
- `isValidDateString` 拒绝格式正确但不存在的日期（如 `2026-02-30`）

---

## 9. 名称、别名与唯一性

### 9.1 归一化规则

```
normalize(input) = input.trim().toLowerCase()
```

**全项目只有一个实现**（`server/src/services/normalize.ts`）。
创建与查询必须调用同一个函数，否则唯一性约束形同虚设。

**v0.1 明确不做**：全角/半角转换、内部连续空格折叠、繁简转换、拼音、模糊匹配、编辑距离。

### 9.2 数据库强制 vs Service 强制

| 规则 | 强制方式 |
|---|---|
| 默认名称唯一 | 数据库 UNIQUE（`ingredient_definition.name_normalized`） |
| 别名全局唯一 | 数据库 UNIQUE（`ingredient_alias.alias_normalized`） |
| **名称与别名不跨表重名** | **Service 检查**（数据库无法跨表建 UNIQUE） |
| 同一食材不重复声明同一单位 | 数据库 UNIQUE（`definition_id, unit`） |
| 至少一个允许单位 | Service 检查 |
| 库存单位属于允许单位 | Service 检查 |

### 9.3 跨表唯一性（Service 的职责）

**数据库有两张表各自的 UNIQUE 约束，但无法阻止跨表重名：**

```
ingredient_definition.name_normalized = '西红柿'   ← 单独看合法
ingredient_alias.alias_normalized     = '西红柿'   ← 单独看也合法
```

规则：**一个字符串归一化后，不能同时作为任何默认名称或任何别名存在。**

**由 Service 检查，不引入 SQLite Trigger**（v0.1 不值得为此增加调试成本）。

**Service 必须覆盖的写入路径：**

| 写入操作 | 检查内容 |
|---|---|
| 创建定义 | 名称是否已是某别名 |
| 修改定义名称 | 新名称是否已是某别名、是否与其他定义重名 |
| 创建别名 | 别名是否已是某定义名称、是否已是其他别名 |
| 修改别名 | 同上 |
| 别名设为默认名称 | 新名称是否与其他定义或其他别名冲突 |

### 9.4 搜索 vs 精确解析

| | 搜索 | 精确解析 |
|---|---|---|
| 实现 | `searchDefinitions()` | `resolveDefinitionByName()` |
| 匹配 | **包含匹配**（LIKE） | **归一化精确匹配** |
| 范围 | 默认名称 + 别名 | 默认名称优先，其次别名 |
| 返回 | 多个定义 | 一个定义 |

两者**不可混为一谈**：搜索用于食材库 UI，精确解析用于「用户选定某个名称」。

---

## 10. 索引设计

**原则：只为当前真实存在的查询建索引。**

### 10.1 现有索引

| 索引 | 类型 | 解决的查询 |
|---|---|---|
| `ingredient_definition_name_normalized_unique` | UNIQUE | 按默认名称精确查找 |
| `ingredient_alias_alias_normalized_unique` | UNIQUE | 按别名精确查找 |
| `ingredient_alias_definition_id_idx` | 普通 | 查某定义的别名；级联删除定位 |
| `ingredient_definition_unit_unique` | UNIQUE（复合） | 查 / 校验 (定义, 单位) |
| `ingredient_definition_unit_definition_id_idx` | 普通 | 查某定义的允许单位；级联删除定位 |
| `standard_ingredient_definition_id_idx` | 普通 | 查某定义的所有库存记录 |

前两个与 `_unit_unique` 由 UNIQUE 约束自动创建；其余为显式索引。

### 10.2 明确不建的索引

| 不建的索引 | 原因 |
|---|---|
| `standard_ingredient.unit` | 10 个枚举值，选择性极低 |
| `standard_ingredient.expiry_date` | 列表一次全取，不在数据库层筛选 |
| `standard_ingredient.quantity` | 没有按数量查询的需求 |
| `standard_ingredient.purchase_date` | 同上 |
| 全文索引（FTS） | 精确匹配 + 简单 LIKE 即可 |
| `created_at` / `updated_at` | 没有按时间筛选的查询 |

**当前数据规模**：家庭食材通常几十到几百条，全表扫描成本可忽略。

---

## 11. 示例数据

### 11.1 `ingredient_definition`

| id | name | name_normalized | estimated_shelf_life_days |
|---|---|---|---|
| 1 | 番茄 | 番茄 | 5 |
| 2 | 土豆 | 土豆 | 30 |
| 3 | 盐 | 盐 | NULL |

### 11.2 `ingredient_alias`

| id | definition_id | alias | alias_normalized |
|---|---|---|---|
| 1 | 1 | 西红柿 | 西红柿 |
| 2 | 1 | 番茄子 | 番茄子 |
| 3 | 2 | 马铃薯 | 马铃薯 |

### 11.3 `ingredient_definition_unit`

| id | definition_id | unit |
|---|---|---|
| 1 | 1 | 个 |
| 2 | 1 | 千克 |
| 3 | 2 | 个 |
| 4 | 2 | 袋 |
| 5 | 3 | 袋 |

### 11.4 `standard_ingredient`

| id | definition_id | quantity | unit | purchase_date | production_date | expiry_date | expiry_date_source | storage_method |
|---|---|---|---|---|---|---|---|---|
| 1 | 2 | 3 | 个 | 2026-10-02 | NULL | 2026-11-01 | estimated | 常温 |
| 2 | 2 | 1 | 袋 | 2026-10-02 | NULL | 2026-11-01 | estimated | 冷藏 |
| 3 | 1 | 500 | 千克 | 2026-09-28 | 2026-09-20 | 2026-10-20 | manual | 冷藏 |
| 4 | 3 | 0 | 袋 | 2026-08-01 | NULL | NULL | NULL | 常温 |

**说明：**

- **定义 2（土豆）有 2 条库存记录**（3 个 / 1 袋）—— 这是 1:N 模型的体现，**不是重复数据**
- **记录 3**：用户手动填写了到期日期 → `manual`
- **记录 4**：数量为 0，记录保留，但当前库存列表不显示

---

## 12. 当前不包含的表

| 不创建的表 | 原因 |
|---|---|
| `consumption_history` | 决策 12：不记录消耗历史 |
| `recommendation` | 范围外 |
| `shopping_list` | 范围外 |
| `unit`（单位表） | 10 个固定枚举，用 CHECK 约束即可 |
| `ingredient_merge` | 决策 22：不做定义合并 |
| `user` | 单用户本地应用 |

> `category` 表已于 **v0.1.3** 引入，见 **第 15 节**。
>
> `recipe` / `recipe_ingredient` / `recipe_tag` / `recipe_tag_link` 已于
> **v0.2.0（Phase 3 批次 1）** 引入，见 **第 16 节**。
>
> ⚠️ 本期仍**不创建**菜谱推荐 / 采购清单 / 照片 / 制作流程相关的任何表。

**此外也不创建**：SQLite Trigger（跨表唯一性由 Service 负责）、FTS 虚拟表、视图。

---

## 13. 实现时需要注意的事项

### 13.1 ⚠️ 必须启用外键约束

**SQLite 的 `PRAGMA foreign_keys` 默认是 OFF。**

不开启则 `ON DELETE CASCADE` 与 `RESTRICT` **全部不会生效**。

`server/src/db/index.ts` 在每个连接建立后立即执行：

```
PRAGMA foreign_keys = ON
```

### 13.2 ⚠️ 重建表时必须临时关闭外键

做「建新表 → 搬数据 → 删旧表 → 重命名」这类迁移时，
`DROP TABLE` 会触发子表的 `ON DELETE CASCADE`，**把关联数据全部删掉**。

因此迁移期间必须：

```
PRAGMA foreign_keys = OFF;
  ... 重建 ...
PRAGMA foreign_keys = ON;
```

> 这个问题在 `0002_definition_id_autoincrement` 迁移中实际发生过，
> 导致别名与允许单位被级联删除（后被测试发现并修复）。

### 13.3 迁移中沿用原 ID

做「一张表拆成两张」的迁移时，显式插入原 `id`，
让新表的主键值等于旧表的主键值，这样关联表的外键值**无需重新映射**。

### 13.4 STRICT 表未使用

`DATABASE_DESIGN.md` 早期版本曾计划使用 SQLite `STRICT` 表。

**实测确认 Drizzle 不支持**（`drizzle-orm` / `drizzle-kit` 无该选项），
因此退化为「CHECK 约束 + 类型层保证 + Service 写入前类型校验」。

这不影响表结构设计。

### 13.5 日期计算使用 UTC

见 8.2 节。避免本地时区导致的跨日错误。

### 13.6 迁移前备份

结构性迁移不可逆，建议迁移前备份 `server/data/homechef.db`。

---

## 14. 数据库约束 vs Service 约束

### 14.1 分工原则

> **数据库保证「数据不可能非法」，Service 保证「业务规则正确」和「错误信息友好」。**

### 14.2 数据库必须保证的

| 约束 | 实现方式 |
|---|---|
| 定义名称唯一 | UNIQUE on `ingredient_definition.name_normalized` |
| 别名全局唯一 | UNIQUE on `ingredient_alias.alias_normalized` |
| 同一食材不重复声明同一单位 | UNIQUE on `(definition_id, unit)` |
| 外键完整性 | FK（含 CASCADE / RESTRICT） |
| 删除定义时清理别名与单位 | `ON DELETE CASCADE` |
| 禁止级联删除库存 | `ON DELETE RESTRICT` |
| 不允许负库存 | CHECK `quantity >= 0` |
| 单位 / 储存方式必须是枚举值 | CHECK |
| 到期日期与来源成对一致 | CHECK |
| 生产日期不晚于入库日期 | CHECK |
| manual 到期日期不早于入库日期 | CHECK |

### 14.3 Service 必须保证的

| 职责 | 为什么不能放数据库 |
|---|---|
| 名称归一化 | 需要完整 Unicode 能力 |
| 名称/别名跨表唯一 | 数据库无法跨表建 UNIQUE |
| 搜索与精确解析 | 业务逻辑 |
| 默认名称切换（含别名升降级） | 需要事务内的多步操作 |
| 至少一个允许单位（**调味品例外**，见第 15 节） | 跨行约束，CHECK 无法表达 |
| 库存单位属于允许单位（**调味品 → 调味品除外**） | 跨表校验 |
| 到期日期估算与来源判定 | 业务规则 |
| 库存是否足够 | 需要先读再判断 |
| 消耗事务 | 原子性由 Service 控制事务边界 |
| 删除保护（HAS_STOCK / UNIT_IN_USE） | 需要先查询引用情况 |
| 友好错误码 | 把约束违反翻译成可读消息 |

### 14.4 取舍说明

**「至少一个允许单位」目前由 Service 保证，数据库层无对应约束。**
若将来需要数据库级保障，可考虑 Trigger，但 v0.1 认为不值得。

**跨表重名同样由 Service 保证**，理由同上。

这两条是当前设计中**明确的取舍**，不是遗漏。

---

## 15. v0.1.2 / v0.1.3 数据库变更

### 15.1 迁移一览

| 文件 | 版本 | 内容 |
|---|---|---|
| `0000_calm_ronan.sql` | v0.1.0 | 初始四表 |
| `0001_ingredient_definition_model.sql` | v0.1.0 | 食材定义模型 |
| `0002_definition_id_autoincrement.sql` | v0.1.0 | `definition_id` 自增 |
| `0003_seed_infrastructure.sql` | v0.1.0 | seed 基础设施 |
| `0004_app_settings.sql` | **v0.1.2** | `app_settings` 单行设置表 |
| `0005_category.sql` | **v0.1.3** | `category` 表 + `ingredient_definition.category_id` |
| `0006_category_color.sql` | **v0.1.4** | `category.color`（`ALTER TABLE ADD COLUMN`，原地追加） |

`meta/_journal.json` 与上述 6 个文件一一对应。

### 15.2 `app_settings`（v0.1.2）

**单行表**，用 CHECK 约束保证只有 `id = 1` 一行。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 固定为 1 |
| `expiry_warning_mode` | TEXT | `'days'` 或 `'percentage'`，默认 `'days'` |
| `expiry_warning_threshold` | INTEGER | 默认 3 |
| `allow_expired_for_recipe` | INTEGER | 0/1（SQLite 无原生 BOOLEAN），默认 0 |
| `created_at` / `updated_at` | TEXT | ISO 时间戳 |

**读取行为**：`getSettings()` 在行不存在时返回**内置默认值**，**不产生写入副作用**。
只有 `PATCH /api/settings` 会 upsert 该行。

### 15.3 `category`（v0.1.3 / v0.1.4）

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `name` | TEXT | NOT NULL（保留用户输入的写法，仅 trim） |
| `name_normalized` | TEXT | NOT NULL，**UNIQUE** |
| `sort_order` | INTEGER | NOT NULL DEFAULT 0 |
| `color` | TEXT | NOT NULL DEFAULT `'#9E9E9E'`（v0.1.4） |
| `created_at` / `updated_at` | TEXT | NOT NULL |

**索引**：`category_name_normalized_unique`（UNIQUE）、`category_sort_order_idx`。

**内置分类与用户自定义分类结构完全相同**，没有 `builtin_category` / `custom_category` 之分。

**`color`（v0.1.4）**：格式固定为 `#RRGGBB`。
migration `0006_category_color.sql` 用 `ALTER TABLE ADD COLUMN` **原地追加**，
不重建表、不影响已有数据行；已有分类自动获得默认值 `#9E9E9E`。
服务端在 `PATCH /api/categories/:id` 中校验格式，非法值返回 400。
`listCategories()` 在返回时会把仍是兜底灰且能命中内置色表的分类
映射为该分类的默认配色（**只影响返回值，不写库**）。

### 15.4 `ingredient_definition.category_id`（v0.1.3）

```
FOREIGN KEY (`category_id`) REFERENCES `category`(`id`)
  ON UPDATE CASCADE
  ON DELETE RESTRICT
```

**索引**：`ingredient_definition_category_id_idx`。

**可空性**：允许 `NULL`，用于兼容「尚未回填分类」的中间状态。
实际数据在 seed 后**全部已回填**（0 个 NULL）。

> ⚠️ **`ON DELETE RESTRICT` 不是 cascade。**
> 删除仍有食材引用的分类时，**业务层先行返回 `409 CATEGORY_IN_USE`**，
> 数据库外键作为最后一道防线。**不存在级联删除食材的行为。**

### 15.5 迁移 0005 的实现要点

SQLite 无法直接 `ALTER TABLE` 增加带外键约束的列，因此采用标准做法：

1. `PRAGMA foreign_keys = OFF`（避免 `DROP TABLE` 触发子表 CASCADE）
2. 建 `category` 表并播种 **19 个默认分类**（`INSERT OR IGNORE`，可重复执行）
3. 建 `ingredient_definition_new`（含 `category_id` + 外键 + CHECK）
4. 原样搬迁所有行（`id` 保持不变，`category_id` 先为 NULL）
5. 同步 `sqlite_sequence` 的最大 id
6. `DROP TABLE` 旧表 → `RENAME` 新表 → 重建唯一索引与普通索引
7. `PRAGMA foreign_keys = ON`

**不修改任何旧 migration**，也**不删除任何现有数据**。

### 15.6 Seed 与分类回填

- `builtin-ingredients.ts` 中的 `category` 字段在 v0.1.3 起**真正入库**
- 229 个内置 definition 按 seed 文件的分类写入 `category_id`
- 对**已有** definition 采取**只补不覆盖**策略：
  仅当 `category_id IS NULL` 时才回填，用户手改过的分类**绝不覆盖**
- `seed_history` / `seed_ingredient_map` 结构未变（v0.1.3 无需新迁移）
- 内置种子仍是 **INSERT-only，不覆盖用户修改**

### 15.7 调味品库存不使用新表结构（B2 方案）

`standard_ingredient` 的 `quantity` / `unit` / `purchase_date` / `storage_method`
均为 `NOT NULL`（`unit` 还有枚举 CHECK）。让它们可空需要重建核心表，
风险高且会波及 Phase 4 合并与临期逻辑。

因此 v0.1.3 **不修改 `standard_ingredient` 结构**，调味品库存改用内部兼容值：

| 字段 | 值 |
|---|---|
| `quantity` | `0` |
| `unit` | `'个'` |
| `purchase_date` | 当天 |
| `storage_method` | `'常温'` |
| `expiry_date` | `NULL` |
| `expiry_date_source` | `NULL` |

> ⚠️ 这些是**数据库兼容值**，不代表用户真实选择了「个」作为调味品计量单位。
> 业务语义是 **presence-only（有 / 无）**，见 `ARCHITECTURE.md` 第 13 节。

**这样做的直接好处**：`expiry_date = NULL` ⇒ 调味品天然落在 `no_expiry` 分支，
**不会进入临期 / 过期判断**，无需为临期系统增加特例。

---

## 16. v0.2.0（Phase 3）菜谱模块表

> 引入版本：**v0.2.0**
> migration：**`0007_recipe.sql`**
> 本阶段（批次 1）**只建表 + 只读 API**；增删改在批次 2，搜索筛选排序在批次 3。

### 16.1 迁移一览

| migration | 内容 |
|---|---|
| `0007_recipe.sql` | 新增 `recipe`、`recipe_ingredient`、`recipe_tag`、`recipe_tag_link` 四张表及索引 |

**本 migration 的性质**：

* ✅ **纯新增表** —— 不重建任何既有表、不修改任何既有列
* ✅ 不触碰任何现有数据（`ingredient_definition` / `standard_ingredient` / `category` / `app_settings` 一律不动）
* ✅ 可在**空库**上从 `0000` 顺序执行至 `0007`

### 16.2 表关系

```text
recipe ──1:N──> recipe_ingredient ──N:1──> ingredient_definition
   │
   └──N:M──> recipe_tag   （通过 recipe_tag_link）
```

* 菜谱 → 食材：通过 **`ingredient_definition.id`**（稳定身份，不是库存记录）
* 菜谱 → Tag：多对多
* 删除菜谱 → 级联清理其食材关联与 Tag 关联
* 删除食材定义 → **被菜谱引用时 RESTRICT**（Service 返回 `409 HAS_RECIPE`，批次 2 实施）
* 删除 Tag → 级联清理关联，但**菜谱保留**

### 16.3 `recipe`（菜谱主表）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | integer | PK AUTOINCREMENT | 稳定身份 |
| `name` | text | NOT NULL | 显示名称（保留用户写法，仅 trim） |
| `name_normalized` | text | NOT NULL **UNIQUE** | `trim + toLowerCase`，唯一性依据 |
| `note` | text | NULL | 菜谱整体备注 |
| `created_at` | text | NOT NULL | ISO 时间戳 |
| `updated_at` | text | NOT NULL | ISO 时间戳 |

**索引**：`recipe_name_normalized_unique`（唯一）、`recipe_name_normalized_idx`、`recipe_updated_at_idx`

> ⚠️ **制作流程 / 照片本阶段不实现，也不预留字段** —— 避免为未确认需求提前建模。

### 16.4 `recipe_ingredient`（菜谱与食材定义的关系）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | integer | PK AUTOINCREMENT | |
| `recipe_id` | integer | NOT NULL，FK → `recipe.id` **ON DELETE CASCADE** | 删菜谱时自动清理 |
| `definition_id` | integer | NOT NULL，FK → `ingredient_definition.id` **ON DELETE RESTRICT** | 被引用时不可删定义 |
| `quantity` | real | **NULL 允许** | 用量 |
| `unit` | text | **NULL 允许**，非空时须在 10 个枚举内 | 单位 |
| `note` | text | **NULL 允许** | 该食材备注（如「适量」「2 勺」） |
| `sort_order` | integer | NOT NULL DEFAULT 0 | 展示顺序 = 用户添加顺序 |
| `created_at` / `updated_at` | text | NOT NULL | |

**索引**：`recipe_ingredient_recipe_id_idx`、`recipe_ingredient_definition_id_idx`

**CHECK 约束**：

| 名称 | 内容 |
|---|---|
| `recipe_ingredient_quantity_non_negative` | `quantity is null or quantity >= 0` |
| `recipe_ingredient_unit_in_enum` | 单位为空，或在 `个 克 千克 毫升 升 包 袋 瓶 盒 罐` 内 |

### 16.5 ⚠️⚠️ 关键设计：允许重复关联同一食材

**`recipe_ingredient` 上故意没有 `UNIQUE(recipe_id, definition_id)`。**

同一道菜谱**允许重复添加同一种食材**，例如：

```text
番茄炒蛋
  鸡蛋 × 2      （sort_order = 0）
  番茄 × 1      （sort_order = 1）
  鸡蛋 × 1      （sort_order = 2）  ← 重复关联，合法
```

* 每条记录**独立**保存数量、单位、备注与顺序
* 同一食材出现多次时，**不合并、不去重**
* ❌ **不得**添加该唯一约束 —— 详见 `PROJECT_SPEC.md` 4.2.3

### 16.6 `recipe_tag`（Tag 表）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | integer | PK AUTOINCREMENT | |
| `name` | text | NOT NULL | 显示名称 |
| `name_normalized` | text | NOT NULL **UNIQUE** | 同名 Tag 不得重复创建 |
| `created_at` | text | NOT NULL | |

**索引**：`recipe_tag_name_normalized_unique`（唯一）、`recipe_tag_name_normalized_idx`

> Tag 是**灵活的多标签系统**，不是独立的菜谱分类体系。

### 16.7 `recipe_tag_link`（菜谱与 Tag 的关系）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | integer | PK AUTOINCREMENT | |
| `recipe_id` | integer | NOT NULL，FK → `recipe.id` **ON DELETE CASCADE** | |
| `tag_id` | integer | NOT NULL，FK → `recipe_tag.id` **ON DELETE CASCADE** | 删 Tag 清理关联 |
| `created_at` | text | NOT NULL | |

**索引**：`recipe_tag_link_unique`（**UNIQUE(recipe_id, tag_id)**）、`recipe_tag_link_recipe_id_idx`、`recipe_tag_link_tag_id_idx`

> 同一菜谱不重复挂同一 Tag；但删 Tag **不影响菜谱本身**。

### 16.8 错误码新增

| 错误码 | HTTP | 场景 |
|---|---|---|
| `RECIPE_NOT_FOUND` | 404 | 菜谱不存在 |
| `TAG_NOT_FOUND` | 404 | Tag 不存在（批次 2 使用） |

> ⚠️ 菜谱相关错误**不复用** `INGREDIENT_NOT_FOUND`（语义不同）。
> 映射见 `server/src/routes/http.ts` 的 `STATUS_BY_CODE`。

### 16.9 与 `app_settings` 的关系（批次 3 预告）

批次 3 将**复用 `app_settings` 单行表**，通过 `0008_recipe_list_settings.sql`
新增 4 个可空列（`recipe_sort_field` / `recipe_sort_order` / `recipe_tag_mode` /
`recipe_selected_tags`），**不新建独立设置表**。

> 本批次（1）**不含**这些列。

### 16.10 明确不包含的内容

| 不包含 | 归属 |
|---|---|
| 菜谱推荐 / 可制作判断 | Phase 4 |
| 每日菜单 / 营养平衡 | Phase 4 |
| 库存扣减闭环 | Phase 5 |
| 采购清单 | Phase 6 |
| 照片、制作流程、份数 | 未规划 |
