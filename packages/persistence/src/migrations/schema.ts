export const migrations = [
  `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    telegram_user_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS telegram_user_preferences (
    user_id TEXT PRIMARY KEY,
    locale TEXT NOT NULL CHECK(locale IN ('zh', 'en')),
    updated_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS environments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    encrypted_credential BLOB,
    credential_type TEXT,
    credential_expires_at TEXT,
    server_version TEXT,
    protocol_fingerprint TEXT,
    status TEXT NOT NULL,
    last_seen_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, base_url),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS bindings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    telegram_chat_id TEXT NOT NULL,
    telegram_thread_id TEXT,
    environment_id TEXT NOT NULL,
    t3_project_id TEXT,
    t3_thread_id TEXT NOT NULL,
    display_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(environment_id) REFERENCES environments(id)
  );
  DROP INDEX IF EXISTS bindings_topic_unique;
  CREATE UNIQUE INDEX IF NOT EXISTS bindings_topic_route_unique
    ON bindings(telegram_chat_id, telegram_thread_id)
    WHERE telegram_thread_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS bindings_flat_target_unique
    ON bindings(user_id, telegram_chat_id, environment_id, t3_thread_id)
    WHERE telegram_thread_id IS NULL;
  CREATE TABLE IF NOT EXISTS active_chat_bindings (
    telegram_chat_id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL,
    FOREIGN KEY(binding_id) REFERENCES bindings(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS telegram_control_topics (
    telegram_chat_id TEXT PRIMARY KEY,
    telegram_thread_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  UPDATE active_chat_bindings
  SET binding_id = (
    SELECT keeper.id
    FROM bindings duplicate
    JOIN bindings keeper
      ON keeper.user_id = duplicate.user_id
     AND keeper.telegram_chat_id = duplicate.telegram_chat_id
     AND keeper.environment_id = duplicate.environment_id
     AND keeper.t3_thread_id = duplicate.t3_thread_id
    WHERE duplicate.id = active_chat_bindings.binding_id
    ORDER BY keeper.created_at, keeper.rowid
    LIMIT 1
  )
  WHERE EXISTS (
    SELECT 1 FROM bindings duplicate
    WHERE duplicate.id = active_chat_bindings.binding_id
  );
  DELETE FROM bindings
  WHERE rowid NOT IN (
    SELECT MIN(rowid)
    FROM bindings
    GROUP BY user_id, telegram_chat_id, environment_id, t3_thread_id
  );
  CREATE UNIQUE INDEX IF NOT EXISTS bindings_t3_target_unique
    ON bindings(user_id, telegram_chat_id, environment_id, t3_thread_id);
  CREATE INDEX IF NOT EXISTS bindings_t3_thread_lookup
    ON bindings(environment_id, t3_thread_id);

  CREATE TABLE IF NOT EXISTS pending_approvals (
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL,
    t3_request_id TEXT NOT NULL,
    telegram_message_id TEXT,
    status TEXT NOT NULL,
    options_json TEXT NOT NULL DEFAULT '[]',
    expires_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(binding_id, t3_request_id),
    FOREIGN KEY(binding_id) REFERENCES bindings(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS compatibility_observations (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    server_version TEXT,
    protocol_fingerprint TEXT,
    capabilities_json TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    FOREIGN KEY(environment_id) REFERENCES environments(id)
  );

  CREATE TABLE IF NOT EXISTS processed_telegram_updates (
    update_id INTEGER PRIMARY KEY,
    processed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS turn_deduplication (
    deduplication_key TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS thread_subscription_state (
    environment_id TEXT NOT NULL,
    t3_thread_id TEXT NOT NULL,
    last_sequence INTEGER,
    last_completed_turn_id TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(environment_id, t3_thread_id),
    FOREIGN KEY(environment_id) REFERENCES environments(id) ON DELETE CASCADE
  );
  `,
] as const;
