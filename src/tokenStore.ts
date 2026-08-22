import { readFileSync, writeFileSync, existsSync } from "node:fs";

const TOKEN_PATH = process.env.TOKEN_PATH || "./whoop-tokens.json";

export interface WhoopTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

export function loadTokens(): WhoopTokens | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export function saveTokens(tokens: WhoopTokens): void {
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf-8");
}

export function isExpired(tokens: WhoopTokens): boolean {
  // refresh a bit early to be safe
  return Date.now() > tokens.expires_at - 60_000;
}
