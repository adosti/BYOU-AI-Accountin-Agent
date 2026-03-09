/**
 * Social Media Content Agent
 *
 * Generates on-brand captions, hashtags, and CTAs for BYou using Claude.
 * Supports Instagram, Facebook, and TikTok across four content types:
 *   quote       — Inspiring quote for women
 *   beforeafter — Before & after caption
 *   promo       — Promotional offer
 *   edu         — Educational skincare tip
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

export interface SocialPost {
  platform: string;
  type: string;
  caption: string;
  hashtags: string;
  cta: string;
}

export interface SocialGenerateRequest {
  contentType: "quote" | "beforeafter" | "promo" | "edu";
  topic: string;
  platforms: string[];
  count: number;
  extraContext?: string;
}

const TYPE_LABELS: Record<string, string> = {
  quote:       "Inspiring Quote for Women",
  beforeafter: "Before & After Caption",
  promo:       "Promotional Offer",
  edu:         "Educational Skincare Tip",
};

const SYSTEM_PROMPT = `You are a bold, empowering social media copywriter for BYou, a beauty & wellness business specializing in Botox, lip fillers, and skincare. Voice: empowering, bold, confident, uplifting for women. Always sound authentic — never corporate or generic.

Respond ONLY with a valid JSON array. No markdown fences, no extra text. Each element must have exactly these keys:
  platform  (string — the target platform)
  type      (string — content type label)
  caption   (string — the full post copy, can use line breaks)
  hashtags  (string — space-separated hashtags)
  cta       (string — call to action line)`;

export async function generateSocialPosts(
  req: SocialGenerateRequest,
): Promise<SocialPost[]> {
  const typeLabel   = TYPE_LABELS[req.contentType] ?? req.contentType;
  const totalPosts  = req.count * req.platforms.length;

  const message = await client.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 2000,
    system:     SYSTEM_PROMPT,
    messages: [
      {
        role:    "user",
        content: [
          `Generate ${req.count} post(s) per platform for: ${req.platforms.join(", ")}.`,
          `Content type: ${typeLabel}.`,
          `Topic / treatment: ${req.topic}.`,
          `Extra context: ${req.extraContext?.trim() || "none"}.`,
          `Return exactly ${totalPosts} objects in a JSON array.`,
        ].join(" "),
      },
    ],
  });

  const raw = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as Anthropic.TextBlock).text)
    .join("");

  // Strip accidental markdown fences
  const clean = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i,     "")
    .replace(/```\s*$/i,     "")
    .trim();

  return JSON.parse(clean) as SocialPost[];
}
