# v0.2.4 测试内容包（curated-test）

> ⚠️ **这是测试数据，不是权威菜谱库。**
> 全部菜谱由人工整理的「食材族 × 做法 × 菜系」白名单规则生成，
> 标注 `provenance: curated-test`，**不提供来源 URL、不声明已逐条核对**。

## 内容

| 文件 | 作用 |
|---|---|
| `catalog.ts` | 人工整理的食材目录（名称/分类/允许单位/单件克重） |
| `recipes.ts` | 确定性生成器：家常炒 / 炖焖烧 / 汤羹 / 素菜 / 主食 / 凉菜 / 干锅 / 蒸 + 西式 |
| `importer.ts` | 库函数 `importContentV024(db, content, { dryRun })` |
| `import-v024.ts` | CLI（默认 dry-run） |
| `stock.ts` | 库函数 `planStock` / `applyStock`（测试库存补量 + 期限拉长） |
| `run-stock.ts` | CLI（默认 dry-run） |

## 规模与质量规则

- 目标约 1200（约 1000 中式 + 200 西式），硬上限 `MAX_IMPORT_RECIPES = 1500`；
- 名称归一后唯一；每条至少一个「非调味 + 有数量 + 有单位」主料；
- 步骤与做法对应（炒/炖/焖/烧/蒸/煮/凉拌/烤/煎），不是同一段模板；
- 菜系标签只贴给真正对应的菜（川/粤/湘/鲁/江浙/闽/东北/西北 + 意/美/法/地中海）；
- 单位必须命中定义允许集合：既有定义**不补改单位**，不匹配的菜谱整条跳过并报告。

## 用法（在 `server/` 下）

```powershell
# dry-run（零写入，打印计划）
npx tsx seed/v024-content/import-v024.ts --db <隔离库绝对路径>

# 写出生成结果（便于评审）
npx tsx seed/v024-content/import-v024.ts --db <...> --out seed/v024-content/content.json

# apply（CLI 只允许隔离库；真实库由 Sol 调用库函数并在事务内执行）
npx tsx seed/v024-content/import-v024.ts --db <隔离库绝对路径> --apply

# 测试库存
npx tsx seed/v024-content/run-stock.ts --db <隔离库绝对路径>
npx tsx seed/v024-content/run-stock.ts --db <隔离库绝对路径> --apply
```

真实库的调用方式（与 v0.2.3 一致）：

```ts
db.transaction(() => importContentV024(db, content, { dryRun: false }))()
db.transaction(() => applyStock(db, planStock(db)))()
```

## 库存规则

- 只补**菜谱实际用到**的非调味 `(definition, unit)` 组合，**不跨单位相加**；
- 目标：克 4000 / 千克 4 / 毫升 3000 / 升 3 / 个·包·袋·盒·瓶·罐 20；
- 已有批次到期日 < 今天+90 天 → 拉长到 +90（更晚保留），来源改 `manual`，
  采购/生产日期不动；
- 新批次期限 +90~180 天，备注「v024 测试库存」；不造过期/短期批次；
- 同日重复执行为 0 变更（幂等）。
