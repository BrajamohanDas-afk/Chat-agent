PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
  idempotency_key TEXT UNIQUE,
  trace_json TEXT,
  created_at TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS turns_session_time ON turns(session_id, created_at);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  user_turn_id TEXT NOT NULL REFERENCES turns(id),
  assistant_turn_id TEXT NOT NULL REFERENCES turns(id),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  entities_json TEXT NOT NULL DEFAULT '[]',
  embedding BLOB,
  created_at TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS episodes_time ON episodes(created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  question, answer, content='episodes', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, question, answer) VALUES (new.rowid, new.question, new.answer);
END;
CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, question, answer)
  VALUES ('delete', old.rowid, old.question, old.answer);
END;
CREATE TRIGGER IF NOT EXISTS episodes_au AFTER UPDATE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, question, answer)
  VALUES ('delete', old.rowid, old.question, old.answer);
  INSERT INTO episodes_fts(rowid, question, answer) VALUES (new.rowid, new.question, new.answer);
END;

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  domain TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  embedding BLOB,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS entities_name ON entities(lower(canonical_name));

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  attribute TEXT NOT NULL,
  value_json TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('user_statement', 'assistant_statement', 'web_observation')),
  verification TEXT NOT NULL CHECK (verification IN ('unverified', 'verified', 'disputed', 'inaccessible')),
  observed_at TEXT NOT NULL,
  published_at TEXT,
  effective_from TEXT,
  source_url TEXT,
  evidence_id TEXT,
  passage TEXT,
  content_hash TEXT,
  source_rank INTEGER,
  supersedes_id TEXT REFERENCES claims(id),
  session_id TEXT REFERENCES sessions(id),
  turn_id TEXT REFERENCES turns(id),
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS claims_entity_time ON claims(entity_id, observed_at);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  topic TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('shortlist', 'selection', 'rejection', 'preference')),
  entity_ids_json TEXT NOT NULL,
  source_turn_id TEXT NOT NULL REFERENCES turns(id),
  created_at TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  provider TEXT NOT NULL,
  results_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  ttl_class TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS checks_lookup ON checks(normalized_query, fetched_at);
