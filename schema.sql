CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  options TEXT DEFAULT '',
  answer TEXT NOT NULL,
  cache_version TEXT NOT NULL DEFAULT '1',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(title, options, cache_version)
);
