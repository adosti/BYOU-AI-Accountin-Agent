/**
 * BYou Platform — API Server
 *
 * Auth:
 *   POST /auth/login                — Exchange username+password for JWT
 *
 * Receipt processing:
 *   POST /receipts                  — Upload & process a receipt (multipart/form-data)
 *
 * Expense tracking:
 *   GET  /expenses                  — List expenses (?from=&to=&category=)
 *
 * Income tracking:
 *   POST /income                    — Add an income entry (JSON body)
 *   GET  /income                    — List income entries (?from=&to=)
 *
 * Dashboard:
 *   GET  /api/dashboard             — Current-month KPIs + recent expenses
 *
 * Reports:
 *   GET  /reports/profit-loss       — P&L report (?from=&to=)
 *   GET  /reports/balance-sheet     — Balance sheet (?asOf=)
 *   GET  /reports/cash-flow         — Cash flow + 3-month forecast (?from=&to=)
 *
 * Social Media AI:
 *   POST /api/social/generate       — Generate on-brand social posts (JSON body)
 *
 * Google Drive:
 *   GET  /api/drive/list            — List folder contents (?folderId=root)
 *   GET  /api/drive/search          — Search files (?q=)
 *
 *   GET  /health                    — Liveness check
 *
 * All routes except /health and /auth/login require a valid JWT Bearer token.
 */

import "dotenv/config";
import express, { Request, Response } from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { AccountingAgent } from "./agent.js";
import { listExpenses, insertIncome, listIncome } from "./db.js";
import { authenticate } from "./middleware/auth.js";
import { getProfitLoss, getBalanceSheet, getCashFlow } from "./reports.js";
import { generateSocialPosts } from "./social.js";
import { listFolder, searchDrive } from "./drive-api.js";
import { config } from "./config.js";
import type { AuthenticatedRequest } from "./types.js";

// ── Express setup ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter(_req, file, cb) {
    const allowed = ["image/jpeg", "image/png", "application/pdf"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

const agent = new AccountingAgent();
const auth  = authenticate as express.RequestHandler;

// ── Health ────────────────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── POST /auth/login ──────────────────────────────────────────────────────────

/**
 * Single-business login.
 * Credentials are set via BYOU_USERNAME / BYOU_PASSWORD env vars.
 * Defaults: byou / byou123  (change in production via env vars)
 */
app.post("/auth/login", (req: Request, res: Response): void => {
  const { username, password } = req.body ?? {};
  const validUser = process.env.BYOU_USERNAME ?? "byou";
  const validPass = process.env.BYOU_PASSWORD ?? "byou123";

  if (username !== validUser || password !== validPass) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = jwt.sign(
    { sub: "byou-user", org: "byou-business" },
    config.auth.jwtSecret,
    { expiresIn: "30d" },
  );

  res.json({ token });
});

// ── POST /receipts ─────────────────────────────────────────────────────────────

app.post(
  "/receipts",
  auth,
  upload.single("receipt"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    if (!req.file) {
      res.status(400).json({ error: "No file uploaded. Use field name 'receipt'." });
      return;
    }

    const receiptId = uuidv4();
    console.log(`[${receiptId}] Processing ${req.file.originalname} (${req.file.mimetype})`);

    try {
      const result = await agent.processReceipt({
        receiptId,
        userId:         authReq.auth.sub,
        organizationId: authReq.auth.org,
        fileBuffer:     req.file.buffer,
        fileName:       req.file.originalname,
        mimeType:       req.file.mimetype as "image/jpeg" | "image/png" | "application/pdf",
      });

      console.log(`[${receiptId}] Done — status: ${result.status}, time: ${result.processingTimeMs}ms`);

      const httpStatus = result.status === "error" ? 422 : 200;
      res.status(httpStatus).json({
        ...result,
        dashboard: buildDashboardPayload(result),
      });
    } catch (err) {
      console.error(`[${receiptId}] Unhandled error:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ── GET /expenses ──────────────────────────────────────────────────────────────

app.get("/expenses", auth, (req: Request, res: Response) => {
  const { from, to, category } = req.query as Record<string, string | undefined>;
  const expenses = listExpenses({ from, to, category });
  res.json({ count: expenses.length, expenses });
});

// ── POST /income ───────────────────────────────────────────────────────────────

app.post("/income", auth, (req: Request, res: Response) => {
  const { source, date, amount, currency = "USD", category = "Revenue", notes } = req.body ?? {};

  if (!source || !date || amount == null) {
    res.status(400).json({ error: "Required fields: source, date, amount" });
    return;
  }

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }

  const row = insertIncome({ source, date, amount: parsedAmount, currency, category, notes: notes ?? null });
  res.status(201).json(row);
});

// ── GET /income ────────────────────────────────────────────────────────────────

app.get("/income", auth, (req: Request, res: Response) => {
  const { from, to } = req.query as Record<string, string | undefined>;
  const income = listIncome({ from, to });
  res.json({ count: income.length, income });
});

// ── GET /api/dashboard ────────────────────────────────────────────────────────

app.get("/api/dashboard", auth, (_req: Request, res: Response) => {
  const now    = new Date();
  const y      = now.getFullYear();
  const m      = String(now.getMonth() + 1).padStart(2, "0");

  const curFrom = `${y}-${m}-01`;
  const curTo   = `${y}-${m}-31`;

  // Last month bounds
  const lastDate  = new Date(y, now.getMonth() - 1, 1);
  const ly        = lastDate.getFullYear();
  const lm        = String(lastDate.getMonth() + 1).padStart(2, "0");
  const lastFrom  = `${ly}-${lm}-01`;
  const lastTo    = `${ly}-${lm}-31`;

  const current = getProfitLoss(curFrom, curTo);
  const last    = getProfitLoss(lastFrom, lastTo);
  const balance = getBalanceSheet(curTo);

  const recentExpenses = listExpenses({ from: curFrom, to: curTo }).slice(0, 10);

  res.json({
    period:   `${now.toLocaleString("default", { month: "long" })} ${y}`,
    current: {
      revenue:   current.totalIncome,
      expenses:  current.totalExpenses,
      netProfit: current.netProfit,
    },
    last: {
      revenue:   last.totalIncome,
      expenses:  last.totalExpenses,
      netProfit: last.netProfit,
    },
    cashOnHand:      balance.netPosition,
    recentExpenses,
  });
});

// ── GET /reports/profit-loss ──────────────────────────────────────────────────

app.get("/reports/profit-loss", auth, (req: Request, res: Response) => {
  const { from, to } = req.query as Record<string, string | undefined>;
  if (!from || !to) {
    res.status(400).json({ error: "Query params required: from, to (YYYY-MM-DD)" });
    return;
  }
  res.json(getProfitLoss(from, to));
});

// ── GET /reports/balance-sheet ────────────────────────────────────────────────

app.get("/reports/balance-sheet", auth, (req: Request, res: Response) => {
  const asOf = (req.query.asOf as string | undefined) ?? new Date().toISOString().substring(0, 10);
  res.json(getBalanceSheet(asOf));
});

// ── GET /reports/cash-flow ────────────────────────────────────────────────────

app.get("/reports/cash-flow", auth, (req: Request, res: Response) => {
  const { from, to } = req.query as Record<string, string | undefined>;
  if (!from || !to) {
    res.status(400).json({ error: "Query params required: from, to (YYYY-MM-DD)" });
    return;
  }
  res.json(getCashFlow(from, to));
});

// ── POST /api/social/generate ─────────────────────────────────────────────────

app.post("/api/social/generate", auth, async (req: Request, res: Response): Promise<void> => {
  const { contentType, topic, platforms, count, extraContext } = req.body ?? {};

  if (!contentType || !topic || !Array.isArray(platforms) || platforms.length === 0) {
    res.status(400).json({ error: "Required: contentType, topic, platforms (array)" });
    return;
  }

  const safeCount = Math.min(Math.max(parseInt(count ?? "3", 10), 1), 6);

  try {
    const posts = await generateSocialPosts({
      contentType,
      topic,
      platforms,
      count:        safeCount,
      extraContext: extraContext ?? "",
    });
    res.json({ posts });
  } catch (err) {
    console.error("Social generate error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/drive/list ───────────────────────────────────────────────────────

app.get("/api/drive/list", auth, async (req: Request, res: Response): Promise<void> => {
  const folderId = (req.query.folderId as string | undefined) ?? "root";
  try {
    const result = await listFolder(folderId);
    res.json(result);
  } catch (err) {
    console.error("Drive list error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/drive/search ─────────────────────────────────────────────────────

app.get("/api/drive/search", auth, async (req: Request, res: Response): Promise<void> => {
  const q = (req.query.q as string | undefined) ?? "";
  if (!q.trim()) {
    res.json({ files: [] });
    return;
  }
  try {
    const files = await searchDrive(q.trim());
    res.json({ files });
  } catch (err) {
    console.error("Drive search error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Error handler ──────────────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: err.message });
});

// ── Dashboard payload builder (receipt response) ──────────────────────────────

function buildDashboardPayload(result: import("./types.js").ProcessingResult) {
  if (result.status === "error") {
    return { banner: "Processing failed — please review errors and retry." };
  }

  const data = result.extractedData;
  return {
    banner:
      result.status === "success"
        ? "Receipt processed and saved successfully"
        : "Receipt partially processed — see errors",
    summary: data
      ? {
          vendor:   data.vendor,
          date:     data.date,
          amount:   `${data.currency} ${data.amount.toFixed(2)}`,
          category: data.category,
          tax:      data.taxAmount != null ? `${data.currency} ${data.taxAmount.toFixed(2)}` : null,
        }
      : null,
    links: {
      expense:   result.expenseId   ? `/expenses/${result.expenseId}` : null,
      driveFile: result.driveFileUrl ?? null,
    },
    metrics: {
      processingTimeSeconds:     (result.processingTimeMs / 1000).toFixed(2),
      extractionConfidence:      `${Math.round(result.metrics.extractionConfidence * 100)}%`,
      timeSavedMinutes:          result.metrics.timeSavedMinutes,
      autoCategorizationSuccess: result.metrics.categorizationAuto,
    },
  };
}

// ── Start server ───────────────────────────────────────────────────────────────

const { port } = config.server;
app.listen(port, () => {
  console.log(`BYou Platform listening on http://localhost:${port}`);
  console.log(`  DB: ${config.db.path}`);
});

export default app;
