export const replayStorage = `
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY, visitor_id TEXT NOT NULL REFERENCES visitors(id), scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('recording','stopped','limit')),
  asset_version TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 1, turn_count INTEGER NOT NULL DEFAULT 0,
  duration_ms REAL NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS recording_owner ON recordings(visitor_id,scope,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS recording_active ON recordings(visitor_id,scope) WHERE status='recording';
CREATE TABLE IF NOT EXISTS replay_events (
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL, at_ms REAL NOT NULL, turn_id INTEGER NOT NULL,
  type TEXT NOT NULL, frame_json TEXT NOT NULL,
  PRIMARY KEY(recording_id,sequence)
) STRICT;
`;
