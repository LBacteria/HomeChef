-- HomeChef v0.2.4：整餐推荐「确认创建会话」的持久化幂等回执
--
-- 目标
-- ────
--   把 v0.2.2 的**进程内 Map** 幂等改成 SQLite 持久化：
--     - `request_id` 主键：同一 key 只可能有一条回执；
--     - `payload_hash`：同一 key 不同载荷 → 409（不静默覆盖）；
--     - `session_id`：首次创建出的会话，重放时原样返回；
--     - `response_json`：**首次成功响应**的 JSON，重放时不重算；
--     - `created_at`：审计用。
--
-- 语义与兼容
-- ──────────
--   - **不做时间淘汰**：不设 TTL、不设条数上限。家庭本地量级，
--     可靠性优先于「自然过期」；进程重启 / 多实例重放都不会再建会话。
--   - `session_id` 外键 **ON DELETE CASCADE**：用户主动删除烹饪会话时，
--     该 request_id 的去重记录随之删除 —— 去重保证到此结束（预期语义）。
--   - 本迁移**不改动任何既有表**，也不回填历史数据：
--     迁移前发生过的 apply 没有回执，它们本来就不可重放。
--
-- ⚠️⚠️ 严禁出现 `PRAGMA` / `BEGIN` / `COMMIT`
--   Drizzle 迁移器把全部待应用迁移包在同一个事务里，上述语句会破坏「失败整体回滚」。
--
-- ⚠️ 本迁移**不提供回滚指令**（未验证的回滚比没有更危险）。

CREATE TABLE `recommendation_request` (
  `request_id` text PRIMARY KEY NOT NULL,
  `payload_hash` text NOT NULL,
  `session_id` integer NOT NULL,
  `response_json` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`session_id`) REFERENCES `cooking_session`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recommendation_request_session_id_idx`
  ON `recommendation_request` (`session_id`);
