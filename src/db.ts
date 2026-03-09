/**
 * Local SQLite tracker — replaces QuickBooks for lightweight expense management.
 *
 * Tables:
 *   expenses — one row per processed receipt
 *   income   — manually entered revenue entries
 *
 * The DB file is created automatically at DB_PATH (default: ./tracker.db).
 * No external server required.
 */

import Database from "better-sqlite3";
import path from "path";
import { v4 as uuidv4 } from "uuid";

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), "tracker.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    migrate(_db);
  }
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id              TEXT PRIMARY KEY,
      vendor          TEXT NOT NULL,
      date            TEXT NOT NULL,
      amount          REAL NOT NULL,
      currency        TEXT NOT NULL DEFAULT 'USD',
      category        TEXT NOT NULL,
      tax_amount      REAL,
      tip_amount      REAL,
      payment_method  TEXT,
      receipt_number  TEXT,
      notes           TEXT,
      drive_file_id   TEXT,
      drive_file_url  TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS income (
      id         TEXT PRIMARY KEY,
      source     TEXT NOT NULL,
      date       TEXT NOT NULL,
      amount     REAL NOT NULL,
      currency   TEXT NOT NULL DEFAULT 'USD',
      category   TEXT NOT NULL DEFAULT 'Revenue',
      notes      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_expenses_date     ON expenses(date);
    CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);
    CREATE INDEX IF NOT EXISTS idx_income_date       ON income(date);
  `);
}

// ── Expense CRUD ────────────────────────────────────────────────────────────

export interface ExpenseRow {
  id: string;
  vendor: string;
  date: string;
  amount: number;
  currency: string;
  category: string;
  tax_amount?: number | null;
  tip_amount?: number | null;
  payment_method?: string | null;
  receipt_number?: string | null;
  notes?: string | null;
  drive_file_id?: string | null;
  drive_file_url?: string | null;
  created_at?: string;
}

export function insertExpense(e: Omit<ExpenseRow, "id" | "created_at"> & { id?: string }): ExpenseRow {
  const row: ExpenseRow = { id: e.id ?? uuidv4(), ...e };
  getDb()
    .prepare(
      `INSERT INTO expenses
         (id, vendor, date, amount, currency, category, tax_amount, tip_amount,
          payment_method, receipt_number, notes, drive_file_id, drive_file_url)
       VALUES
         (@id, @vendor, @date, @amount, @currency, @category, @tax_amount, @tip_amount,
          @payment_method, @receipt_number, @notes, @drive_file_id, @drive_file_url)`,
    )
    .run(row);
  return row;
}

export interface ExpenseFilters {
  from?: string;       // ISO date, inclusive
  to?: string;         // ISO date, inclusive
  category?: string;
}

export function listExpenses(filters: ExpenseFilters = {}): ExpenseRow[] {
  let sql = "SELECT * FROM expenses WHERE 1=1";
  const params: Record<string, string> = {};
  if (filters.from)     { sql += " AND date >= @from";         params.from     = filters.from; }
  if (filters.to)       { sql += " AND date <= @to";           params.to       = filters.to; }
  if (filters.category) { sql += " AND category = @category";  params.category = filters.category; }
  sql += " ORDER BY date DESC";
  return getDb().prepare(sql).all(params) as ExpenseRow[];
}

// ── Income CRUD ─────────────────────────────────────────────────────────────

export interface IncomeRow {
  id: string;
  source: string;
  date: string;
  amount: number;
  currency: string;
  category: string;
  notes?: string | null;
  created_at?: string;
}

export function insertIncome(i: Omit<IncomeRow, "id" | "created_at"> & { id?: string }): IncomeRow {
  const row: IncomeRow = { id: i.id ?? uuidv4(), ...i };
  getDb()
    .prepare(
      `INSERT INTO income (id, source, date, amount, currency, category, notes)
       VALUES (@id, @source, @date, @amount, @currency, @category, @notes)`,
    )
    .run(row);
  return row;
}

export interface IncomeFilters {
  from?: string;
  to?: string;
}

export function listIncome(filters: IncomeFilters = {}): IncomeRow[] {
  let sql = "SELECT * FROM income WHERE 1=1";
  const params: Record<string, string> = {};
  if (filters.from) { sql += " AND date >= @from"; params.from = filters.from; }
  if (filters.to)   { sql += " AND date <= @to";   params.to   = filters.to; }
  sql += " ORDER BY date DESC";
  return getDb().prepare(sql).all(params) as IncomeRow[];
}
