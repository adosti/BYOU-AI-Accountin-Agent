/**
 * Receipt Extractor
 *
 * Uses Claude Vision (Opus 4.6 with adaptive thinking) to extract structured
 * expense data from receipt images or PDFs.  Runs as a direct Claude API call
 * (not through the agent loop) so we get a guaranteed typed response.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "./config.js";
import type { ReceiptData } from "./types.js";

// ── Zod schema for extraction response ─────────────────────────────────────

const LineItemSchema = z.object({
  description: z.string(),
  quantity: z.number().optional(),
  unitPrice: z.number().optional(),
  amount: z.number(),
});

const ReceiptDataSchema = z.object({
  vendor: z.string(),
  date: z.string(),
  amount: z.number(),
  currency: z.string().default("USD"),
  category: z.string(),
  lineItems: z.array(LineItemSchema).default([]),
  taxAmount: z.number().optional(),
  tipAmount: z.number().optional(),
  paymentMethod: z.string().optional(),
  receiptNumber: z.string().optional(),
  notes: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

// ── Supported MIME → Anthropic media_type map ───────────────────────────────

type SupportedMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const PDF_MIME = "application/pdf";

// ── Main extractor class ────────────────────────────────────────────────────

export class ReceiptExtractor {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }

  /**
   * Extract structured data from a receipt image or PDF buffer.
   * Throws if extraction fails validation; caller should handle and decide
   * whether to surface as a partial result or a hard error.
   */
  async extract(fileBuffer: Buffer, mimeType: string, fileName: string): Promise<ReceiptData> {
    const base64 = fileBuffer.toString("base64");

    // Build the content block based on file type
    const fileContentBlock = this.buildContentBlock(base64, mimeType, fileName);

    const response = await this.client.messages.create({
      model: config.anthropic.model,
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            fileContentBlock,
            {
              type: "text",
              text: EXTRACTION_PROMPT,
            },
          ],
        },
      ],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              vendor: { type: "string", description: "Merchant or vendor name" },
              date: { type: "string", description: "Transaction date in ISO 8601 format (YYYY-MM-DD)" },
              amount: { type: "number", description: "Total charged amount as a decimal" },
              currency: { type: "string", description: "ISO 4217 currency code, default USD" },
              category: {
                type: "string",
                enum: EXPENSE_CATEGORIES,
                description: "Expense category",
              },
              lineItems: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    description: { type: "string" },
                    quantity: { type: "number" },
                    unitPrice: { type: "number" },
                    amount: { type: "number" },
                  },
                  required: ["description", "amount"],
                  additionalProperties: false,
                },
              },
              taxAmount: { type: "number" },
              tipAmount: { type: "number" },
              paymentMethod: { type: "string" },
              receiptNumber: { type: "string" },
              notes: { type: "string", description: "Any caveats or ambiguities noted during extraction" },
              confidence: {
                type: "number",
                description: "Extraction confidence 0.0–1.0; lower if any field is uncertain",
              },
            },
            required: ["vendor", "date", "amount", "currency", "category", "lineItems", "confidence"],
            additionalProperties: false,
          },
        },
      },
    });

    // Extract the text block from the response
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Claude did not return a text block — check model or prompt");
    }

    const parsed = JSON.parse(textBlock.text);

    // Validate against our Zod schema so TypeScript consumers get a typed result
    const validated = ReceiptDataSchema.parse(parsed);

    // Business-rule validation (PRD §4 functional requirements)
    this.validateBusinessRules(validated);

    return validated as ReceiptData;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private buildContentBlock(
    base64: string,
    mimeType: string,
    _fileName: string,
  ): Anthropic.ImageBlockParam | Anthropic.RequestDocumentBlock {
    if (mimeType === PDF_MIME) {
      // PDF: use the document content block
      return {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: base64,
        },
      } as Anthropic.RequestDocumentBlock;
    }

    // Image
    const mediaType = mimeType as SupportedMediaType;
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: base64,
      },
    } as Anthropic.ImageBlockParam;
  }

  private validateBusinessRules(data: z.infer<typeof ReceiptDataSchema>): void {
    if (data.amount <= 0) {
      throw new Error(`Invalid receipt amount: ${data.amount} — must be > 0`);
    }
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(data.date)) {
      throw new Error(`Invalid date format: "${data.date}" — expected YYYY-MM-DD`);
    }
    if (!data.vendor || data.vendor.trim().length === 0) {
      throw new Error("Vendor name is empty — cannot create accounting entry");
    }
  }
}

// ── Constants ───────────────────────────────────────────────────────────────

const EXPENSE_CATEGORIES = [
  "Advertising & Marketing",
  "Bank Charges",
  "Dues & Subscriptions",
  "Entertainment",
  "Equipment",
  "Insurance",
  "Legal & Professional",
  "Meals & Entertainment",
  "Office Supplies",
  "Other",
  "Postage & Shipping",
  "Rent & Lease",
  "Repairs & Maintenance",
  "Software",
  "Travel",
  "Utilities",
] as const;

const SYSTEM_PROMPT = `You are an expert accounting data extraction assistant. Your job is to read
receipt images or PDF documents and extract structured expense data with high accuracy.

Rules:
- Always produce valid ISO 8601 dates (YYYY-MM-DD). Infer the year from context if not shown.
- Amounts must be numbers (decimals), never strings. Use the grand total/charged amount.
- Pick the most specific expense category from the provided enum.
- Assign a confidence score: 1.0 = all fields clear; lower if any field is ambiguous or missing.
- If a field is not present on the receipt, omit it (do not guess).
- Never fabricate data. Use notes to flag ambiguities.`;

const EXTRACTION_PROMPT = `Please extract all expense information from this receipt and return it
as a JSON object matching the required schema. Be precise with amounts and dates.`;
