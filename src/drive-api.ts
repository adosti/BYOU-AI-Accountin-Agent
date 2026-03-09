/**
 * Google Drive Browse API
 *
 * Wraps the Google Drive REST API v3 so the BYou Platform can display,
 * navigate, and search files without spawning an MCP child process.
 *
 * Credentials are read from the same env vars used by the MCP archiving agent.
 * If credentials are absent the functions return empty results gracefully.
 *
 * Token caching: the OAuth2 access token is cached in memory and refreshed
 * automatically 60 seconds before it expires.
 */

import { config } from "./config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DriveFile {
  id:           string;
  name:         string;
  mimeType:     string;
  size?:        string;   // bytes, as a string (Drive API convention)
  modifiedTime?: string;  // ISO 8601
  starred?:     boolean;
  webViewLink?: string;
  isFolder:     boolean;
}

export interface FolderListing {
  folders: DriveFile[];
  files:   DriveFile[];
  configured: boolean;   // false if Drive credentials are not set
}

// ── Token cache ──────────────────────────────────────────────────────────────

let _cachedToken:     string | null = null;
let _tokenExpiresAt:  number        = 0;

async function getAccessToken(): Promise<string> {
  if (_cachedToken && Date.now() < _tokenExpiresAt) return _cachedToken;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      client_id:     config.googleDrive.clientId,
      client_secret: config.googleDrive.clientSecret,
      refresh_token: config.googleDrive.refreshToken,
      grant_type:    "refresh_token",
    }),
  });

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?:   number;
    error?:        string;
  };

  if (!data.access_token) {
    throw new Error(`Drive OAuth error: ${data.error ?? "unknown"}`);
  }

  _cachedToken    = data.access_token;
  // Expire 60 s early so we never send a stale token
  _tokenExpiresAt = Date.now() + ((data.expires_in ?? 3600) - 60) * 1000;
  return _cachedToken;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isDriveConfigured(): boolean {
  return !!(
    config.googleDrive.clientId &&
    config.googleDrive.clientSecret &&
    config.googleDrive.refreshToken
  );
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

function toFile(raw: Record<string, unknown>): DriveFile {
  return {
    id:           raw.id          as string,
    name:         raw.name        as string,
    mimeType:     raw.mimeType    as string,
    size:         raw.size        as string | undefined,
    modifiedTime: raw.modifiedTime as string | undefined,
    starred:      raw.starred     as boolean | undefined,
    webViewLink:  raw.webViewLink as string | undefined,
    isFolder:     raw.mimeType    === FOLDER_MIME,
  };
}

const LIST_FIELDS =
  "files(id,name,mimeType,size,modifiedTime,starred,webViewLink)";

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * List the contents of a Drive folder.
 * Returns folders first, then files, sorted by name.
 */
export async function listFolder(folderId = "root"): Promise<FolderListing> {
  if (!isDriveConfigured()) return { folders: [], files: [], configured: false };

  const token = await getAccessToken();
  const q     = `'${folderId}' in parents and trashed = false`;
  const url   = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q",        q);
  url.searchParams.set("fields",   LIST_FIELDS);
  url.searchParams.set("orderBy",  "folder,name");
  url.searchParams.set("pageSize", "200");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Drive list error ${res.status}: ${body}`);
  }

  const data  = (await res.json()) as { files: Record<string, unknown>[] };
  const all   = (data.files ?? []).map(toFile);

  return {
    configured: true,
    folders:    all.filter((f) =>  f.isFolder),
    files:      all.filter((f) => !f.isFolder),
  };
}

/**
 * Full-text search across the entire Drive.
 */
export async function searchDrive(query: string): Promise<DriveFile[]> {
  if (!isDriveConfigured()) return [];

  const token = await getAccessToken();
  const q     = `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`;
  const url   = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q",        q);
  url.searchParams.set("fields",   LIST_FIELDS);
  url.searchParams.set("pageSize", "50");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Drive search error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { files: Record<string, unknown>[] };
  return (data.files ?? []).map(toFile);
}
