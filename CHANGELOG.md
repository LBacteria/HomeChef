# Changelog

HomeChef 的版本变更记录。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.0] - 2026-10-01

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
