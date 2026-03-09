/**
 * Report generators for the lightweight expense tracker.
 *
 * Three report types:
 *   Profit & Loss   — income vs expenses over a date range, broken down by category
 *   Balance Sheet   — cumulative net position as of a given date
 *   Cash Flow       — monthly income/expense trends + 3-month rolling forecast
 */

import { getDb } from "./db.js";

// ── Shared types ─────────────────────────────────────────────────────────────

export interface ProfitLossReport {
  period: { from: string; to: string };
  totalIncome: number;
  totalExpenses: number;
  netProfit: number;
  incomeByCategory: Record<string, number>;
  expensesByCategory: Record<string, number>;
  taxDeductibleTotal: number;       // sum of tax_amount captured on receipts
}

export interface BalanceSheetReport {
  asOf: string;
  totalIncome: number;              // all-time income up to asOf
  totalExpenses: number;            // all-time expenses up to asOf
  netPosition: number;              // income − expenses
  expensesByCategory: Record<string, number>;
}

export interface MonthlyFlow {
  month: string;                    // "YYYY-MM"
  income: number;
  expenses: number;
  net: number;
}

export interface CashFlowReport {
  period: { from: string; to: string };
  monthly: MonthlyFlow[];
  forecast: MonthlyFlow[];          // next 3 months, averaged from recent actuals
}

// ── Profit & Loss ────────────────────────────────────────────────────────────

export function getProfitLoss(from: string, to: string): ProfitLossReport {
  const db = getDb();

  const incomeRows = db
    .prepare(
      `SELECT category, SUM(amount) AS total
       FROM income WHERE date >= ? AND date <= ?
       GROUP BY category`,
    )
    .all(from, to) as { category: string; total: number }[];

  const expenseRows = db
    .prepare(
      `SELECT category, SUM(amount) AS total
       FROM expenses WHERE date >= ? AND date <= ?
       GROUP BY category`,
    )
    .all(from, to) as { category: string; total: number }[];

  const taxRow = db
    .prepare(
      `SELECT COALESCE(SUM(tax_amount), 0) AS total
       FROM expenses WHERE date >= ? AND date <= ?`,
    )
    .get(from, to) as { total: number };

  const incomeByCategory: Record<string, number> = {};
  let totalIncome = 0;
  for (const r of incomeRows) {
    incomeByCategory[r.category] = r.total;
    totalIncome += r.total;
  }

  const expensesByCategory: Record<string, number> = {};
  let totalExpenses = 0;
  for (const r of expenseRows) {
    expensesByCategory[r.category] = r.total;
    totalExpenses += r.total;
  }

  return {
    period: { from, to },
    totalIncome,
    totalExpenses,
    netProfit: totalIncome - totalExpenses,
    incomeByCategory,
    expensesByCategory,
    taxDeductibleTotal: taxRow.total,
  };
}

// ── Balance Sheet ─────────────────────────────────────────────────────────────

export function getBalanceSheet(asOf: string): BalanceSheetReport {
  const db = getDb();

  const totalIncome = (
    db
      .prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM income WHERE date <= ?`)
      .get(asOf) as { total: number }
  ).total;

  const totalExpenses = (
    db
      .prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE date <= ?`)
      .get(asOf) as { total: number }
  ).total;

  const expensesByCategory: Record<string, number> = {};
  const rows = db
    .prepare(
      `SELECT category, SUM(amount) AS total
       FROM expenses WHERE date <= ?
       GROUP BY category`,
    )
    .all(asOf) as { category: string; total: number }[];
  for (const r of rows) {
    expensesByCategory[r.category] = r.total;
  }

  return {
    asOf,
    totalIncome,
    totalExpenses,
    netPosition: totalIncome - totalExpenses,
    expensesByCategory,
  };
}

// ── Cash Flow ─────────────────────────────────────────────────────────────────

export function getCashFlow(from: string, to: string): CashFlowReport {
  const db = getDb();

  const incomeRows = db
    .prepare(
      `SELECT strftime('%Y-%m', date) AS month, SUM(amount) AS total
       FROM income WHERE date >= ? AND date <= ?
       GROUP BY month ORDER BY month`,
    )
    .all(from, to) as { month: string; total: number }[];

  const expenseRows = db
    .prepare(
      `SELECT strftime('%Y-%m', date) AS month, SUM(amount) AS total
       FROM expenses WHERE date >= ? AND date <= ?
       GROUP BY month ORDER BY month`,
    )
    .all(from, to) as { month: string; total: number }[];

  // Merge into a map keyed by "YYYY-MM"
  const monthMap: Record<string, { income: number; expenses: number }> = {};
  for (const r of incomeRows) {
    monthMap[r.month] = { income: r.total, expenses: 0 };
  }
  for (const r of expenseRows) {
    if (!monthMap[r.month]) monthMap[r.month] = { income: 0, expenses: 0 };
    monthMap[r.month].expenses = r.total;
  }

  const monthly: MonthlyFlow[] = Object.entries(monthMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, { income, expenses }]) => ({
      month,
      income,
      expenses,
      net: income - expenses,
    }));

  return {
    period: { from, to },
    monthly,
    forecast: buildForecast(monthly, to),
  };
}

// ── Forecast helper ───────────────────────────────────────────────────────────

function buildForecast(monthly: MonthlyFlow[], lastDate: string): MonthlyFlow[] {
  // Average the most recent 3 months of actuals (or fewer if not enough data)
  const recent = monthly.slice(-3);
  if (recent.length === 0) return [];

  const avgIncome   = recent.reduce((s, m) => s + m.income,   0) / recent.length;
  const avgExpenses = recent.reduce((s, m) => s + m.expenses, 0) / recent.length;

  // Project the 3 months following the end of the requested period
  const [year, month] = lastDate.substring(0, 7).split("-").map(Number);
  const forecast: MonthlyFlow[] = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(year, month - 1 + i, 1);
    const label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    forecast.push({
      month: label,
      income:   Math.round(avgIncome   * 100) / 100,
      expenses: Math.round(avgExpenses * 100) / 100,
      net:      Math.round((avgIncome - avgExpenses) * 100) / 100,
    });
  }
  return forecast;
}
