/**
 * Accounting Agent
 *
 * Orchestrates the receipt processing pipeline using Claude Agent SDK:
 *   1. Extract receipt data with Claude Vision
 *   2. Save the expense to the local SQLite tracker
 *   3. Archive the original receipt file to Google Drive (via Drive MCP server)
 *   4. Return a structured ProcessingResult for the API response / dashboard
 *
 * The MCP server runs as a child process alongside the Node.js server.
 * It authenticates using credentials from environment variables.
 */

import { query, ResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { getDb, insertExpense } from "./db.js";
import { ReceiptExtractor } from "./extractor.js";
import type { AgentContext, ProcessingResult, ReceiptData } from "./types.js";

export class AccountingAgent {
  private extractor: ReceiptExtractor;

  constructor() {
    this.extractor = new ReceiptExtractor();
  }

  /**
   * Full pipeline: extract → save to DB → archive to Google Drive.
   * Returns a ProcessingResult regardless of partial failures so the
   * dashboard always gets a response (errors are surfaced in .errors[]).
   */
  async processReceipt(ctx: AgentContext): Promise<ProcessingResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let extractedData: ReceiptData | undefined;
    let expenseId: string | undefined;
    let driveFileId: string | undefined;
    let driveFileUrl: string | undefined;

    // ── Step 1: Extract receipt data with Claude Vision ─────────────────────
    try {
      extractedData = await this.extractor.extract(
        ctx.fileBuffer,
        ctx.mimeType,
        ctx.fileName,
      );
    } catch (err) {
      errors.push(`Extraction failed: ${(err as Error).message}`);
      return this.buildResult(ctx.receiptId, startTime, errors, {});
    }

    // ── Step 2: Save expense to local SQLite tracker ─────────────────────────
    try {
      const row = insertExpense({
        id: ctx.receiptId,
        vendor: extractedData.vendor,
        date: extractedData.date,
        amount: extractedData.amount,
        currency: extractedData.currency,
        category: extractedData.category,
        tax_amount: extractedData.taxAmount ?? null,
        tip_amount: extractedData.tipAmount ?? null,
        payment_method: extractedData.paymentMethod ?? null,
        receipt_number: extractedData.receiptNumber ?? null,
        notes: extractedData.notes ?? null,
      });
      expenseId = row.id;
    } catch (err) {
      errors.push(`DB save failed: ${(err as Error).message}`);
    }

    // ── Step 3: Archive to Google Drive via MCP agent loop ──────────────────
    try {
      const agentResult = await this.runAgentLoop(ctx, extractedData);
      driveFileId = agentResult.driveFileId;
      driveFileUrl = agentResult.driveFileUrl;
      if (agentResult.errors.length > 0) errors.push(...agentResult.errors);

      // Back-fill Drive links into the saved expense row
      if (expenseId && driveFileId) {
        updateExpenseDriveLinks(expenseId, driveFileId, driveFileUrl ?? null);
      }
    } catch (err) {
      errors.push(`Agent loop failed: ${(err as Error).message}`);
    }

    return this.buildResult(ctx.receiptId, startTime, errors, {
      extractedData,
      expenseId,
      driveFileId,
      driveFileUrl,
    });
  }

  // ── Private: agent loop ────────────────────────────────────────────────────

  private async runAgentLoop(
    ctx: AgentContext,
    data: ReceiptData,
  ): Promise<{ driveFileId?: string; driveFileUrl?: string; errors: string[] }> {
    const errors: string[] = [];
    let driveFileId: string | undefined;
    let driveFileUrl: string | undefined;

    // Encode the receipt file as base64 so the agent can pass it to Google Drive MCP
    const fileBase64 = ctx.fileBuffer.toString("base64");
    const prompt = buildAgentPrompt(ctx, data, fileBase64);
    let resultText = "";

    for await (const message of query({
      prompt,
      options: {
        model: config.anthropic.model,
        maxTurns: 6,
        mcpServers: buildMcpServers(config),
        systemPrompt: AGENT_SYSTEM_PROMPT,
        thinking: { type: "adaptive" },
      },
    })) {
      if (message instanceof ResultMessage || "result" in message) {
        resultText = (message as ResultMessage).result ?? "";
      }
    }

    // Parse IDs from the agent's final response (JSON summary in fenced block)
    try {
      const jsonMatch = resultText.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        const summary = JSON.parse(jsonMatch[1]);
        driveFileId  = summary.driveFileId;
        driveFileUrl = summary.driveFileUrl;
        if (Array.isArray(summary.errors)) errors.push(...summary.errors);
      } else {
        errors.push("Agent did not return a parseable JSON summary");
      }
    } catch {
      errors.push("Failed to parse agent result JSON");
    }

    return { driveFileId, driveFileUrl, errors };
  }

  // ── Private: result builder ────────────────────────────────────────────────

  private buildResult(
    receiptId: string,
    startTime: number,
    errors: string[],
    partial: {
      extractedData?: ReceiptData;
      expenseId?: string;
      driveFileId?: string;
      driveFileUrl?: string;
    },
  ): ProcessingResult {
    const processingTimeMs = Date.now() - startTime;
    const status =
      errors.length === 0
        ? "success"
        : partial.extractedData
          ? "partial"
          : "error";

    return {
      receiptId,
      status,
      processingTimeMs,
      errors,
      ...partial,
      metrics: {
        extractionConfidence: partial.extractedData?.confidence ?? 0,
        timeSavedMinutes: 3,        // industry benchmark: ~3 min per manual receipt
        categorizationAuto: !!partial.extractedData?.category,
      },
    };
  }
}

// ── MCP server configuration ────────────────────────────────────────────────

function buildMcpServers(cfg: typeof config) {
  return {
    // Google Drive MCP — official server from google-labs
    gdrive: {
      command: "npx",
      args: ["-y", "@google-labs/google-drive-mcp"],
      env: {
        GOOGLE_CLIENT_ID:     cfg.googleDrive.clientId,
        GOOGLE_CLIENT_SECRET: cfg.googleDrive.clientSecret,
        GOOGLE_REFRESH_TOKEN: cfg.googleDrive.refreshToken,
      },
    },
  };
}

// ── DB helper (back-fill Drive links) ──────────────────────────────────────

function updateExpenseDriveLinks(id: string, fileId: string, fileUrl: string | null): void {
  getDb()
    .prepare(`UPDATE expenses SET drive_file_id = ?, drive_file_url = ? WHERE id = ?`)
    .run(fileId, fileUrl, id);
}

// ── Prompt builders ────────────────────────────────────────────────────────

const AGENT_SYSTEM_PROMPT = `You are a receipt archiving agent for AgentForge. Your responsibilities are:
1. Upload the receipt file to Google Drive using the Google Drive MCP tools.
2. After a successful upload, retrieve the shareable file URL.
3. At the end, output a JSON summary in a fenced code block with keys:
   driveFileId, driveFileUrl, errors (string[]).

Be precise. Retry failed API calls up to 3 times before recording the error.
Never expose credentials in your output.`;

function buildAgentPrompt(ctx: AgentContext, data: ReceiptData, fileBase64: string): string {
  return `Archive this receipt to Google Drive for user ${ctx.userId} (org: ${ctx.organizationId}).

## Receipt Summary
- Receipt ID : ${ctx.receiptId}
- Vendor     : ${data.vendor}
- Date       : ${data.date}
- Amount     : ${data.amount} ${data.currency}
- Category   : ${data.category}

## File Details
- File name  : ${ctx.fileName}
- MIME type  : ${ctx.mimeType}
- File data  : (base64, ${Math.round(fileBase64.length / 1024)} KB)

## Task
Upload the original receipt file to Google Drive folder ID "${config.googleDrive.receiptsFolderId}".
- Use file name: "${ctx.receiptId}-${ctx.fileName}"
- After upload, retrieve the shareable file URL.

Output a JSON summary as described in your system prompt.`;
}
