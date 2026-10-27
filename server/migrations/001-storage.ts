export const initialStorage = `
CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY, visitor_id TEXT NOT NULL REFERENCES visitors(id),
  credential_tag TEXT NOT NULL, expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS auth_expiry ON auth_sessions(expires_at);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, visitor_id TEXT NOT NULL REFERENCES visitors(id), scope TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), revision INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL, progress_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS current_conversation ON conversations(visitor_id,scope) WHERE active=1;
CREATE TABLE IF NOT EXISTS conversation_messages (
  id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  exchange_key TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(conversation_id,exchange_key,role)
) STRICT;
CREATE INDEX IF NOT EXISTS message_history ON conversation_messages(conversation_id,id);
CREATE TABLE IF NOT EXISTS usage_totals (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), deepseek INTEGER NOT NULL CHECK(deepseek>=0),
  asr INTEGER NOT NULL CHECK(asr>=0), tts INTEGER NOT NULL CHECK(tts>=0), reserved_micros INTEGER NOT NULL CHECK(reserved_micros>=0)
) STRICT;
INSERT OR IGNORE INTO usage_totals VALUES(1,0,0,0,0);
CREATE TABLE IF NOT EXISTS reply_diagnostics (
  id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, outcome TEXT NOT NULL, data_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS diagnostic_recent ON reply_diagnostics(id DESC);
CREATE TABLE IF NOT EXISTS client_timings (
  id INTEGER PRIMARY KEY, visitor_id TEXT NOT NULL REFERENCES visitors(id), scope TEXT NOT NULL,
  page_id TEXT NOT NULL, record_id INTEGER NOT NULL, data_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(visitor_id,scope,page_id,record_id)
) STRICT;
CREATE INDEX IF NOT EXISTS timing_history ON client_timings(visitor_id,scope,id DESC);
CREATE TABLE IF NOT EXISTS legacy_imports (
  name TEXT PRIMARY KEY, imported_at INTEGER NOT NULL, status TEXT NOT NULL
) STRICT;
`;
