import { Database } from "bun:sqlite";

const DB_PATH = process.env.DB_PATH || "frieren.db";
const db = new Database(DB_PATH, { create: true });

// Enable WAL mode for better concurrent performance
db.run("PRAGMA journal_mode = WAL");

// Create tables
db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS group_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_group_id TEXT NOT NULL,
    source_group_name TEXT,
    target_group_id TEXT NOT NULL,
    target_group_name TEXT,
    bidirectional INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_cursors (
    mapping_id INTEGER NOT NULL,
    direction TEXT NOT NULL DEFAULT 'forward',
    cursor_ts INTEGER DEFAULT 0,
    msg_count INTEGER DEFAULT 0,
    PRIMARY KEY (mapping_id, direction)
  );

  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    participant_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// --- Session queries ---

const insertSession = db.prepare(
  "INSERT INTO sessions (token, created_at, expires_at) VALUES (?1, ?2, ?3)",
);

const getSession = db.prepare("SELECT * FROM sessions WHERE token = ?1");

const deleteSession = db.prepare("DELETE FROM sessions WHERE token = ?1");

const cleanExpiredSessions = db.prepare(
  "DELETE FROM sessions WHERE expires_at < ?1",
);

export function createSession(token: string, durationMs = 24 * 60 * 60 * 1000) {
  const now = Date.now();
  insertSession.run(token, now, now + durationMs);
}

export function validateSession(token: string): boolean {
  cleanExpiredSessions.run(Date.now());
  const row = getSession.get(token) as { token: string } | null;
  return row !== null;
}

export function removeSession(token: string) {
  deleteSession.run(token);
}

// --- Mapping queries ---

export interface GroupMapping {
  id: number;
  source_group_id: string;
  source_group_name: string | null;
  target_group_id: string;
  target_group_name: string | null;
  bidirectional: number;
  active: number;
  created_at: number;
}

const insertMapping = db.prepare(`
  INSERT INTO group_mappings (source_group_id, source_group_name, target_group_id, target_group_name, bidirectional, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6)
`);

const getAllMappings = db.prepare(
  "SELECT * FROM group_mappings ORDER BY created_at DESC",
);

const getMappingById = db.prepare("SELECT * FROM group_mappings WHERE id = ?1");

const deleteMappingById = db.prepare(
  "DELETE FROM group_mappings WHERE id = ?1",
);

const updateMappingActive = db.prepare(
  "UPDATE group_mappings SET active = ?2 WHERE id = ?1",
);

const updateMappingDirection = db.prepare(
  "UPDATE group_mappings SET bidirectional = ?2 WHERE id = ?1",
);

const getActiveMappingsForGroup = db.prepare(`
  SELECT * FROM group_mappings
  WHERE active = 1 AND (source_group_id = ?1 OR (bidirectional = 1 AND target_group_id = ?1))
`);

export function addMapping(
  sourceGroupId: string,
  sourceGroupName: string | null,
  targetGroupId: string,
  targetGroupName: string | null,
  bidirectional: boolean,
): GroupMapping {
  const now = Date.now();
  insertMapping.run(
    sourceGroupId,
    sourceGroupName,
    targetGroupId,
    targetGroupName,
    bidirectional ? 1 : 0,
    now,
  );
  const id = db.query("SELECT last_insert_rowid() as id").get() as {
    id: number;
  };
  return getMappingById.get(id.id) as GroupMapping;
}

export function listMappings(): GroupMapping[] {
  return getAllMappings.all() as GroupMapping[];
}

export function getMapping(id: number): GroupMapping | null {
  return getMappingById.get(id) as GroupMapping | null;
}

export function deleteMapping(id: number): boolean {
  const result = deleteMappingById.run(id);
  if (result.changes > 0) {
    deleteSyncCursorsForMapping.run(id);
  }
  return result.changes > 0;
}

export function toggleMappingActive(id: number, active: boolean) {
  updateMappingActive.run(id, active ? 1 : 0);
}

export function setMappingDirection(id: number, bidirectional: boolean) {
  updateMappingDirection.run(id, bidirectional ? 1 : 0);
}

export function getActiveMappings(groupId: string): GroupMapping[] {
  return getActiveMappingsForGroup.all(groupId) as GroupMapping[];
}

// --- Sync cursor queries ---

const advanceCursorStmt = db.prepare(`
  INSERT INTO sync_cursors (mapping_id, direction, cursor_ts, msg_count)
  VALUES (?1, ?2, ?3, 0)
  ON CONFLICT(mapping_id, direction) DO UPDATE SET
    cursor_ts = MAX(sync_cursors.cursor_ts, excluded.cursor_ts)
`);

const incrementCountStmt = db.prepare(`
  INSERT INTO sync_cursors (mapping_id, direction, cursor_ts, msg_count)
  VALUES (?1, ?2, 0, 1)
  ON CONFLICT(mapping_id, direction) DO UPDATE SET msg_count = msg_count + 1
`);

const getCursorStmt = db.prepare(
  "SELECT cursor_ts FROM sync_cursors WHERE mapping_id = ?1 AND direction = ?2",
);

const getStatsStmt = db.prepare(
  "SELECT mapping_id, SUM(msg_count) as count FROM sync_cursors GROUP BY mapping_id",
);

const deleteSyncCursorsForMapping = db.prepare(
  "DELETE FROM sync_cursors WHERE mapping_id = ?1",
);

export function getCursor(mappingId: number, direction: string): number {
  const row = getCursorStmt.get(mappingId, direction) as {
    cursor_ts: number;
  } | null;
  return row?.cursor_ts ?? 0;
}

export function advanceCursor(
  mappingId: number,
  direction: string,
  ts: number,
): void {
  advanceCursorStmt.run(mappingId, direction, ts);
}

export function incrementMsgCount(mappingId: number, direction: string): void {
  incrementCountStmt.run(mappingId, direction);
}

export function getSyncStats(): Record<number, number> {
  const rows = getStatsStmt.all() as { mapping_id: number; count: number }[];
  const stats: Record<number, number> = {};
  for (const row of rows) {
    stats[row.mapping_id] = row.count;
  }
  return stats;
}

export function deleteSyncCursors(mappingId: number): void {
  deleteSyncCursorsForMapping.run(mappingId);
}

// --- Group cache queries ---

export interface CachedGroup {
  id: string;
  name: string;
  participant_count: number;
  updated_at: number;
}

const upsertGroupStmt = db.prepare(`
  INSERT INTO groups (id, name, participant_count, updated_at)
  VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    participant_count = excluded.participant_count,
    updated_at = excluded.updated_at
`);

const getAllGroupsStmt = db.prepare(
  "SELECT * FROM groups ORDER BY name COLLATE NOCASE",
);

const getGroupsMaxUpdatedAtStmt = db.prepare(
  "SELECT MAX(updated_at) as max_ts FROM groups",
);

export function upsertGroups(
  groups: { id: string; name: string; participantCount: number }[],
): void {
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const g of groups) {
      upsertGroupStmt.run(g.id, g.name, g.participantCount, now);
    }
  });
  tx();
}

export function getGroupsFromDB(): CachedGroup[] {
  return getAllGroupsStmt.all() as CachedGroup[];
}

export function getGroupsLastUpdated(): number {
  const row = getGroupsMaxUpdatedAtStmt.get() as {
    max_ts: number | null;
  } | null;
  return row?.max_ts ?? 0;
}

// --- KV store queries ---

const getKVStmt = db.prepare("SELECT value FROM kv WHERE key = ?1");
const setKVStmt = db.prepare(
  "INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);

export function getKV(key: string): string | null {
  const row = getKVStmt.get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setKV(key: string, value: string): void {
  setKVStmt.run(key, value);
}

export function resetWhatsAppData(): void {
  const tx = db.transaction(() => {
    db.run("DELETE FROM groups");
    db.run("DELETE FROM sync_cursors");
    db.run("DELETE FROM group_mappings");
  });
  tx();
}

export default db;
