const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const USER_DB_PATH = path.join(__dirname, '..', 'data', 'nyxie_users.db');

let db = null;
let SqlJs = null;

function persist() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(USER_DB_PATH, buffer);
}

let persistInterval = null;

async function getUserDb() {
  if (db) return db;

  SqlJs = await initSqlJs();

  const dataDir = path.dirname(USER_DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  if (fs.existsSync(USER_DB_PATH)) {
    const fileBuffer = fs.readFileSync(USER_DB_PATH);
    db = new SqlJs.Database(fileBuffer);
  } else {
    db = new SqlJs.Database();
  }

  // Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar TEXT,
      banner TEXT,
      banner_color TEXT,
      bio TEXT,
      public_key TEXT,          -- E2EE: base64 encoded public key
      status TEXT DEFAULT 'online',
      status_updated_at INTEGER,
      created_at INTEGER NOT NULL,
      last_seen INTEGER,
      disabled INTEGER DEFAULT 0
    )
  `);

  // Messages table – ensure nonce column exists
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      nonce TEXT,                -- E2EE: base64 encoded nonce
      created_at INTEGER NOT NULL,
      edited_at INTEGER,
      deleted INTEGER DEFAULT 0
    )
  `);

  // Add missing columns if they don't exist
  try { db.run("ALTER TABLE users ADD COLUMN public_key TEXT"); } catch (e) {}
  try { db.run("ALTER TABLE messages ADD COLUMN nonce TEXT"); } catch (e) {}

  // Servers, rooms, memberships, friends tables (unchanged)
  db.run(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      owner_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS server_members (
      server_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (server_id, user_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      server_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      is_dm INTEGER DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS room_members (
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, user_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS friends (
      id TEXT PRIMARY KEY,
      user_a TEXT NOT NULL,
      user_b TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'accepted',
      created_at INTEGER NOT NULL,
      UNIQUE(user_a, user_b)
    )
  `);

  // Default server (unchanged)
  const defaultServer = db.exec("SELECT id FROM servers WHERE name = 'Nyxie'");
  if (!defaultServer.length || !defaultServer[0].values.length) {
    const serverId = 'nyxie-default';
    const now = Date.now();
    db.run(`INSERT INTO servers (id, name, owner_id, created_at) VALUES (?, 'Nyxie', 'system', ?)`, [serverId, now]);
    db.run(`INSERT OR IGNORE INTO rooms (id, server_id, name, description, created_by, created_at, is_dm)
            VALUES ('general', ?, 'general', 'The main chat room', 'system', ?, 0)`, [serverId, now]);
    db.run(`INSERT OR IGNORE INTO rooms (id, server_id, name, description, created_by, created_at, is_dm)
            VALUES ('random', ?, 'random', 'Anything goes', 'system', ?, 0)`, [serverId, now]);
    db.run(`INSERT OR IGNORE INTO rooms (id, server_id, name, description, created_by, created_at, is_dm)
            VALUES ('introductions', ?, 'introductions', 'Introduce yourself', 'system', ?, 0)`, [serverId, now]);
  }

  persist();
  persistInterval = setInterval(persist, 5000);
  return db;
}

function all(db, sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch (e) {
    return [];
  }
}

function get(db, sql, params = []) {
  const rows = all(db, sql, params);
  return rows[0] || null;
}

function run(db, sql, params = []) {
  db.run(sql, params);
  persist();
}

module.exports = { getUserDb, all, get, run };