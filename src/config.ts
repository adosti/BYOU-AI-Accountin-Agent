import "dotenv/config";

function require(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  anthropic: {
    apiKey: require("ANTHROPIC_API_KEY"),
    model: "claude-opus-4-6" as const,
  },

  auth: {
    jwtSecret: require("JWT_SECRET"),
    jwtExpiresIn: optional("JWT_EXPIRES_IN", "1h"),
  },

  googleDrive: {
    clientId: optional("GOOGLE_CLIENT_ID", ""),
    clientSecret: optional("GOOGLE_CLIENT_SECRET", ""),
    refreshToken: optional("GOOGLE_REFRESH_TOKEN", ""),
    receiptsFolderId: optional("GOOGLE_DRIVE_RECEIPTS_FOLDER_ID", "root"),
  },

  db: {
    path: optional("DB_PATH", "tracker.db"),
  },

  server: {
    port: parseInt(optional("PORT", "3000"), 10),
    nodeEnv: optional("NODE_ENV", "development"),
  },
} as const;
