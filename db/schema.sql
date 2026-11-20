PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE users (
  id              INTEGER PRIMARY KEY,
  username        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT    NOT NULL DEFAULT '',            -- formato: pbkdf2$iterazioni$sale$hash
  role            TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  active          INTEGER NOT NULL DEFAULT 1,
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER NOT NULL DEFAULT 0,             -- secondi Unix
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE sessions (
  token_hash      TEXT    PRIMARY KEY,                    -- impronta SHA-256 del cookie, mai il cookie in chiaro
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acting_as       INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- per la simulazione utente (R3)
  expires_at      INTEGER NOT NULL,                       -- secondi Unix
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS "frequenza" (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0, giorni INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, name)
);
CREATE TABLE exercises (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  frequenza_id     INTEGER NOT NULL REFERENCES "frequenza"(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  archived        INTEGER NOT NULL DEFAULT 0, ordine_visualiz INTEGER NOT NULL DEFAULT 0, programma TEXT, stile TEXT,
  UNIQUE (user_id, frequenza_id, name)
);
CREATE TABLE entries (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exercise_id     INTEGER NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  date            TEXT    NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, exercise_id, date)                    -- una registrazione per esercizio al giorno
);
CREATE TABLE notes (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exercise_id     INTEGER REFERENCES exercises(id) ON DELETE SET NULL,
  date            TEXT    NOT NULL,
  topic           TEXT,                                   -- argomento libero (es. "Tai Chi")
  body            TEXT    NOT NULL DEFAULT '',
  observations    TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE exercises_master (
  id               INTEGER PRIMARY KEY,
  name             TEXT    NOT NULL,
  frequenza        TEXT    NOT NULL,
  stile            TEXT,
  programma        TEXT,
  ordine_visualiz  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (frequenza, name)
);
CREATE TABLE chat_conversations (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT    NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE chat_messages (
  id              INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,                       -- ordine nella conversazione, da 1
  role            TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT    NOT NULL,                       -- JSON dei blocchi dell'API
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (conversation_id, seq)                          -- due invii insieme non possono mescolare la storia
);
DELETE FROM sqlite_sequence;
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_entries_user_date ON entries(user_id, date);
CREATE INDEX idx_notes_user_date ON notes(user_id, date);
CREATE INDEX idx_chat_conv_user ON chat_conversations(user_id, updated_at);
