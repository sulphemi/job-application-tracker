PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS application_result (
  id INTEGER PRIMARY KEY,
  result TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS file_entry (
  id INTEGER PRIMARY KEY,
  mime_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  storage_path TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS application_entry (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_updated TEXT NOT NULL,
  link TEXT NOT NULL,
  comments TEXT NOT NULL DEFAULT '',
  status_id INTEGER NOT NULL REFERENCES application_result(id),
  snapshot_id INTEGER NULL REFERENCES file_entry(id)
);

CREATE INDEX IF NOT EXISTS application_entry_status_idx
  ON application_entry(status_id);
