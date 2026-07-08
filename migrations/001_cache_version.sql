-- 001_cache_version.sql
-- 为「已在运行」的 D1 库升级缓存版本机制，使「修改 CACHE_VERSION 即全量失效」真正可用。
--
-- 问题背景（这是 schema.sql 用 CREATE TABLE IF NOT EXISTS 无法自愈的根因）：
--   1) CREATE TABLE IF NOT EXISTS 对已存在的表是空操作，不会补列；
--   2) SQLite 的 ALTER TABLE 不支持「修改 / 新增 UNIQUE 约束」；
--   3) 原 UNIQUE(title, options) 不含 cache_version。若仅把 CACHE_VERSION 从 '1' 改成 '2'，
--      worker 的 INSERT OR IGNORE (title, options, answer, '2') 会与旧行
--      (title, options, '1') 在唯一键上冲突而被【静默忽略】，导致该题缓存永久失效、
--      反复回源 AI（缓存被打挂）。因此必须把唯一约束改为包含 cache_version。
--
-- 做法：建新表（含正确唯一约束）→ 迁移数据（cache_version 统一置 '1'）→ 改名覆盖旧表。
-- 兼容性：无论旧表是否已有 cache_version 列，本文件都不会报错：
--   - 旧表有 cache_version 列：迁移时忽略旧值，统一置 '1'（无害，反正即将 bump）；
--   - 旧表无 cache_version 列：INSERT 不引用该列，由新表默认值 '1' 填充，亦不报错。
-- 幂等：可重复执行；answers_new 每次重建为空，数据从当前 answers 重新拷贝。
-- 适用：answers 表已存在的存量库。全新库请直接用 schema.sql（其 UNIQUE 已含 cache_version）。

CREATE TABLE IF NOT EXISTS answers_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  options TEXT DEFAULT '',
  answer TEXT NOT NULL,
  cache_version TEXT NOT NULL DEFAULT '1',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(title, options, cache_version)
);

INSERT OR IGNORE INTO answers_new (id, title, options, answer, created_at)
SELECT
  id,
  title,
  COALESCE(options, ''),
  answer,
  COALESCE(created_at, CURRENT_TIMESTAMP)
FROM answers;

DROP TABLE answers;
ALTER TABLE answers_new RENAME TO answers;
