import initSqlJs from 'sql.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'urgad.db');

let SQL: any = null;
let db: any = null;
let pool: InstanceType<typeof Pool> | null = null;
let usePg = false;
let initPromise: Promise<void> | null = null;

// int8 (COUNT(*)) comes back as a string from node-pg; sqlite returns a number.
pg.types.setTypeParser(20, (val: string) => parseInt(val, 10));

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      phone TEXT,
      first_name TEXT,
      last_name TEXT,
      role TEXT NOT NULL DEFAULT 'professional',
      verified INTEGER DEFAULT 0,
      verification_status TEXT DEFAULT 'pending',
      is_admin INTEGER DEFAULT 0,
      last_login TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS professionals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date_of_birth TEXT,
      bio TEXT,
      experience TEXT,
      previous_establishments TEXT,
      skills TEXT,
      services TEXT,
      hours TEXT,
      mobility TEXT,
      availability TEXT,
      mobility_radius INTEGER DEFAULT 20,
      avatar_url TEXT,
      verification_documents TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS establishments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      siret TEXT,
      type TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      city TEXT,
      postal_code TEXT,
      responsible TEXT,
      documents TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS missions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      establishment_id INTEGER NOT NULL REFERENCES establishments(id),
      establishment_name TEXT NOT NULL,
      establishment_email TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      conditions TEXT,
      location TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT,
      start_hour TEXT,
      end_hour TEXT,
      status TEXT DEFAULT 'pending',
      urgent INTEGER DEFAULT 0,
      visible INTEGER DEFAULT 1,
      application_count INTEGER DEFAULT 0,
      published_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      professional_id INTEGER NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      professional_name TEXT NOT NULL,
      professional_role TEXT NOT NULL,
      professional_email TEXT,
      professional_phone TEXT,
      status TEXT DEFAULT 'pending',
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      recipient_id INTEGER NOT NULL,
      recipient_type TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      conversation_id TEXT NOT NULL,
      sender_id INTEGER NOT NULL,
      sender_type TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      content TEXT NOT NULL,
      read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      user_id INTEGER,
      user_email TEXT,
      action TEXT NOT NULL,
      resource TEXT,
      details TEXT,
      ip_address TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS disputes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      pro TEXT,
      etab TEXT,
      mission TEXT,
      reason TEXT,
      status TEXT DEFAULT 'open',
      priority TEXT DEFAULT 'medium',
      resolution TEXT,
      internal_notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS support_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      user_name TEXT,
      type TEXT,
      subject TEXT,
      priority TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'open',
      reply TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS platform_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      setting_key TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS finance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      reference TEXT,
      establishment TEXT NOT NULL,
      kind TEXT,
      missions INTEGER DEFAULT 0,
      amount REAL NOT NULL,
      commission REAL DEFAULT 0,
      record_date TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS matching_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE NOT NULL,
      mission_id INTEGER,
      radius_km INTEGER,
      skills TEXT,
      result_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS establishment_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      establishment_id INTEGER NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      doc_type TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS establishment_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      establishment_id INTEGER NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      price REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS phone_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      phone TEXT,
      code TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS professional_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      doc_type TEXT,
      status TEXT DEFAULT 'pending',
      stored_name TEXT,
      mime_type TEXT,
      size_bytes INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS document_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_type TEXT NOT NULL,
      document_id INTEGER NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mission_coordinates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id INTEGER UNIQUE NOT NULL,
      latitude REAL,
      longitude REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS device_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      platform TEXT NOT NULL DEFAULT 'android',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS request_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id INTEGER NOT NULL,
      actor_user_id INTEGER,
      actor_role TEXT,
      event TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      application_id INTEGER,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS geocode_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT UNIQUE NOT NULL,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      label TEXT,
      score REAL,
      result_type TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

`;

/** Additive columns only (never DROP). Checked one by one, so an existing file keeps its rows. */
const EXTRA_COLUMNS: Array<[string, string, string]> = [
  ['users', 'accepted_terms_at', 'TEXT'],
  ['users', 'terms_version', 'TEXT'],
  ['users', 'deleted_at', 'TEXT'],
  ['professionals', 'address', 'TEXT'],
  ['professionals', 'city', 'TEXT'],
  ['professionals', 'postal_code', 'TEXT'],
  ['professionals', 'latitude', 'REAL'],
  ['professionals', 'longitude', 'REAL'],
  ['professionals', 'geocode_label', 'TEXT'],
  ['professionals', 'geocode_precision', 'TEXT'],
  ['establishments', 'latitude', 'REAL'],
  ['establishments', 'longitude', 'REAL'],
  ['establishments', 'geocode_label', 'TEXT'],
  ['establishments', 'geocode_precision', 'TEXT'],
  ['mission_coordinates', 'geocode_label', 'TEXT'],
  ['mission_coordinates', 'geocode_precision', 'TEXT'],
  ['mission_coordinates', 'source', 'TEXT'],
  ['missions', 'notified_at', 'TEXT'],
  ['notifications', 'user_id', 'INTEGER'],
  ['notifications', 'data', 'TEXT'],
  ['notifications', 'push_status', 'TEXT'],
  // Demandes (modèle « on trouve le profil, l'établissement valide »)
  ['missions', 'request_status', 'TEXT'],
  ['missions', 'request_source', 'TEXT'],
  ['missions', 'request_notes', 'TEXT'],
  ['missions', 'poste', 'TEXT'],
  ['missions', 'created_by_user_id', 'INTEGER'],
  ['missions', 'proposed_application_id', 'INTEGER'],
  ['missions', 'backup_application_id', 'INTEGER'],
  ['missions', 'proposed_at', 'TEXT'],
  ['missions', 'validated_at', 'TEXT'],
  ['missions', 'refusal_reason', 'TEXT'],
  ['applications', 'origin', 'TEXT'],
  ['applications', 'proposed_at', 'TEXT'],
  ['applications', 'decided_at', 'TEXT'],
  ['establishments', 'source', 'TEXT'],
  // Vérification d'identité et du diplôme, séparées
  ['professionals', 'profession', 'TEXT'],
  ['professionals', 'experience_years', 'INTEGER'],
  ['professionals', 'identity_status', 'TEXT'],
  ['professionals', 'identity_reason', 'TEXT'],
  ['professionals', 'identity_reviewed_by', 'TEXT'],
  ['professionals', 'identity_reviewed_at', 'TEXT'],
  ['professionals', 'diploma_status', 'TEXT'],
  ['professionals', 'diploma_reason', 'TEXT'],
  ['professionals', 'diploma_reviewed_by', 'TEXT'],
  ['professionals', 'diploma_reviewed_at', 'TEXT'],
  ['professional_documents', 'category', 'TEXT'],
  ['professional_documents', 'id_kind', 'TEXT'],
  ['professional_documents', 'side', 'TEXT'],
  ['professional_documents', 'review_reason', 'TEXT'],
  ['professional_documents', 'reviewed_by', 'TEXT'],
  ['professional_documents', 'reviewed_at', 'TEXT'],
  ['professional_documents', 'file_purged_at', 'TEXT'],
  ['professional_documents', 'file_bytes', 'BLOB'],
  ['document_files', 'file_bytes', 'BLOB'],
  ['establishment_subscriptions', 'stripe_customer_id', 'TEXT'],
  ['establishment_subscriptions', 'stripe_subscription_id', 'TEXT'],
  ['establishment_subscriptions', 'stripe_checkout_id', 'TEXT'],
  ['establishment_subscriptions', 'billing_notice', 'TEXT'],
  ['establishment_subscriptions', 'extra_credits', 'INTEGER'],
];

async function ensureColumns(): Promise<void> {
  for (const [table, column, type] of EXTRA_COLUMNS) {
    if (usePg) {
      const pgType = type === 'REAL' ? 'DOUBLE PRECISION' : type === 'BLOB' ? 'BYTEA' : type;
      await pool!.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${pgType}`);
      continue;
    }
    const info = db.exec(`PRAGMA table_info(${table})`);
    const cols = info.length ? info[0].values.map((v: any[]) => String(v[1])) : [];
    if (!cols.includes(column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function splitStatements(sql: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === ';') {
      const stmt = sql.slice(start, i).trim();
      if (stmt) parts.push(stmt);
      start = i + 1;
    }
    i++;
  }
  const tail = sql.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

/** sqlite SQL -> Postgres. Placeholders, datetime/date, identity. Not used for the sql.js path. */
export function adaptSqlForPostgres(sql: string): string {
  let out = '';
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      out += sql.slice(i, j);
      i = j - 1;
      continue;
    }
    if (c === '?') {
      n += 1;
      out += '$' + n;
      continue;
    }
    out += c;
  }
  let s = out;
  s = s.replace(/datetime\(\s*'now'\s*,\s*'-7 days'\s*\)/gi, "(to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '7 days', 'YYYY-MM-DD HH24:MI:SS'))");
  s = s.replace(/datetime\(\s*'now'\s*\)/gi, "(to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))");
  s = s.replace(/date\(\s*'now'\s*\)/gi, "(to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD'))");
  s = s.replace(/date\(\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\)/gi, '(LEFT($1::text, 10))');
  s = s.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY');
  if (/^\s*insert\b/i.test(s) && !/\breturning\b/i.test(s)) {
    s = s.replace(/;?\s*$/, '') + ' RETURNING id';
  }
  return s;
}

async function pgExec(sql: string): Promise<void> {
  if (!pool) throw new Error('Postgres pool not initialized.');
  for (const raw of splitStatements(sql)) {
    if (/sqlite_sequence/i.test(raw)) continue;
    await pool.query(adaptSqlForPostgres(raw));
  }
}

async function doInit(): Promise<void> {
  const databaseUrl = (process.env.DATABASE_URL || '').trim();
  if (databaseUrl) {
    usePg = true;
    pool = new Pool({ connectionString: databaseUrl });
    pool.on('error', (err) => {
      console.error('Postgres pool error:', err);
    });
    for (const stmt of splitStatements(SCHEMA)) {
      await pool.query(adaptSqlForPostgres(stmt));
    }
    await ensureColumns();
    return;
  }

  if (!SQL) {
    SQL = await initSqlJs();
  }
  if (db) {
    try { db.close(); } catch { /* ignore */ }
  }
  try {
    const buffer = fs.readFileSync(DB_PATH);
    if (buffer.length > 0) db = new SQL.Database(buffer);
    else db = new SQL.Database();
  } catch {
    db = new SQL.Database();
  }
  // Existing file: CREATE TABLE IF NOT EXISTS only. Does not delete rows.
  db.run(SCHEMA);
  await ensureColumns();
  saveSync();
}

export function initializeDb(): Promise<void> {
  if (!initPromise) {
    initPromise = doInit().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

export function getDb(): any {
  if (usePg) {
    throw new Error('getDb() is the sql.js handle. With DATABASE_URL set, use dbRun, dbGet, dbAll or dbExec.');
  }
  if (!db) throw new Error('Database not initialized. Call initializeDb() first.');
  return db;
}

function saveSync(): void {
  if (usePg || !db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  } catch (e) {
    console.error('DB save error:', e);
  }
}

export function save(): void {
  saveSync();
}

function sqliteParams(params: any[]): any[] {
  return params.map((p) => (Buffer.isBuffer(p) ? new Uint8Array(p) : p));
}

function sqliteRun(sql: string, params: any[]): { lastInsertRowid: number | null } {
  const stmt = db.prepare(sql);
  stmt.bind(sqliteParams(params));
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  let id: number | null = row && row.last_insert_rowid != null ? Number(row.last_insert_rowid) : null;
  if (id == null && /^\s*insert\b/i.test(sql)) {
    try {
      const r = db.exec('SELECT last_insert_rowid()');
      const v = r?.[0]?.values?.[0]?.[0];
      if (v != null && Number(v) > 0) id = Number(v);
    } catch { /* ignore */ }
  }
  saveSync();
  return { lastInsertRowid: id };
}

function sqliteGet<T = any>(sql: string, params: any[]): T | undefined {
  const stmt = db.prepare(sql);
  stmt.bind(sqliteParams(params));
  const hasRow = stmt.step();
  if (!hasRow) { stmt.free(); return undefined; }
  const row = stmt.getAsObject() as T;
  stmt.free();
  return row;
}

function sqliteAll<T = any>(sql: string, params: any[]): T[] {
  const stmt = db.prepare(sql);
  stmt.bind(sqliteParams(params));
  const rows: T[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return rows;
}

export async function dbRun(sql: string, params: any[] = []): Promise<{ lastInsertRowid: number | null }> {
  if (!usePg) return sqliteRun(sql, params);
  const result = await pool!.query(adaptSqlForPostgres(sql), params);
  const id = result.rows?.[0]?.id;
  return { lastInsertRowid: id != null ? Number(id) : null };
}

export async function dbGet<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
  if (!usePg) return sqliteGet<T>(sql, params);
  const result = await pool!.query(adaptSqlForPostgres(sql), params);
  if (!result.rows.length) return undefined;
  return result.rows[0] as T;
}

export async function dbAll<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  if (!usePg) return sqliteAll<T>(sql, params);
  const result = await pool!.query(adaptSqlForPostgres(sql), params);
  return result.rows as T[];
}

export async function dbExec(sql: string): Promise<void> {
  if (!usePg) {
    db.exec(sql);
    saveSync();
    return;
  }
  await pgExec(sql);
}
