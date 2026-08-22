import fetch from "node-fetch";
import { WhoopTokens, loadTokens, saveTokens, isExpired } from "./tokenStore.js";

const API_HOST = process.env.WHOOP_API_HOSTNAME || "https://api.prod.whoop.com";
const CLIENT_ID = process.env.WHOOP_CLIENT_ID!;
const CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET!;
const REDIRECT_URI = process.env.WHOOP_REDIRECT_URI!;

export function getAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "offline read:profile read:recovery read:sleep read:workout read:cycles read:body_measurement",
    state,
  });
  return `${API_HOST}/oauth/oauth2/auth?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<WhoopTokens> {
  const res = await fetch(`${API_HOST}/oauth/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  const json: any = await res.json();
  const tokens: WhoopTokens = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + json.expires_in * 1000,
  };
  saveTokens(tokens);
  return tokens;
}

async function refreshTokens(refresh_token: string): Promise<WhoopTokens> {
  const res = await fetch(`${API_HOST}/oauth/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }
  const json: any = await res.json();
  const tokens: WhoopTokens = {
    access_token: json.access_token,
    refresh_token: json.refresh_token || refresh_token,
    expires_at: Date.now() + json.expires_in * 1000,
  };
  saveTokens(tokens);
  return tokens;
}

async function getValidAccessToken(): Promise<string> {
  let tokens = loadTokens();
  if (!tokens) {
    throw new Error(
      "No Whoop tokens found. Visit /auth/login on this server once in a browser to authorize."
    );
  }
  if (isExpired(tokens)) {
    tokens = await refreshTokens(tokens.refresh_token);
  }
  return tokens.access_token;
}

export async function whoopGet(path: string, query?: Record<string, string>): Promise<any> {
  const accessToken = await getValidAccessToken();
  const url = new URL(`${API_HOST}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Whoop API error: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
