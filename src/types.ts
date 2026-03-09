import type { Request } from "express";

// ── Receipt domain types ────────────────────────────────────────────────────

export interface LineItem {
  description: string;
  quantity?: number;
  unitPrice?: number;
  amount: number;
}

export interface ReceiptData {
  vendor: string;
  date: string;         // ISO 8601 — e.g. "2026-03-09"
  amount: number;
  currency: string;     // ISO 4217 — e.g. "USD"
  category: string;     // e.g. "Travel", "Meals", "Office Supplies"
  lineItems: LineItem[];
  taxAmount?: number;
  tipAmount?: number;
  paymentMethod?: string;
  receiptNumber?: string;
  notes?: string;
  confidence: number;   // 0–1 extraction confidence score
}

// ── Processing pipeline types ───────────────────────────────────────────────

export interface ProcessingResult {
  receiptId: string;
  status: "success" | "partial" | "error";
  extractedData?: ReceiptData;
  expenseId?: string;       // SQLite row ID for the saved expense
  driveFileId?: string;
  driveFileUrl?: string;
  processingTimeMs: number;
  errors: string[];
  metrics: ProcessingMetrics;
}

export interface ProcessingMetrics {
  extractionConfidence: number;
  timeSavedMinutes: number;   // estimated manual entry time saved
  categorizationAuto: boolean;
}

// ── Agent context ───────────────────────────────────────────────────────────

export interface AgentContext {
  receiptId: string;
  userId: string;
  organizationId: string;
  fileBuffer: Buffer;
  fileName: string;
  mimeType: "image/jpeg" | "image/png" | "application/pdf";
}

// ── Express extensions ──────────────────────────────────────────────────────

export interface AuthPayload {
  sub: string;           // userId
  org: string;           // organizationId
  iat: number;
  exp: number;
}

export interface AuthenticatedRequest extends Request {
  auth: AuthPayload;
}
