import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getAuthorizeUrl, exchangeCodeForTokens, whoopGet } from "./whoopClient.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SHARED_SECRET = process.env.MCP_SHARED_SECRET; // optional, used only if OAuth env vars aren't set
const OAUTH_CLIENT_ID = process.env.MCP_OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.MCP_OAUTH_CLIENT_SECRET;
const PUBLIC_URL = process.env.PUBLIC_URL; // e.g. https://whoop-mcp-6zkv.onrender.com

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Minimal single-user OAuth 2.0 flow (for Claude's Client ID / Secret fields) ----------
// This always auto-approves — fine for a personal, single-user server, since the
// real gatekeeping is knowing OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET in the first place.

interface AuthCode {
  redirectUri: string;
  expiresAt: number;
}
const authCodes = new Map<string, AuthCode>();
const accessTokens = new Set<string>();

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const base = PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
  });
});

app.get("/authorize", (req, res) => {
  const { client_id, redirect_uri, state } = req.query as Record<string, string>;
  if (!OAUTH_CLIENT_ID || client_id !== OAUTH_CLIENT_ID) {
    res.status(401).send("Unknown client_id.");
    return;
  }
  if (!redirect_uri) {
    res.status(400).send("Missing redirect_uri.");
    return;
  }
  const code = crypto.randomBytes(24).toString("hex");
  authCodes.set(code, { redirectUri: redirect_uri, expiresAt: Date.now() + 5 * 60_000 });
  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(url.toString());
});

app.post("/token", (req, res) => {
  const { grant_type, code, client_id, client_secret, refresh_token } = req.body as Record<string, string>;

  if (
    !OAUTH_CLIENT_ID ||
    !OAUTH_CLIENT_SECRET ||
    client_id !== OAUTH_CLIENT_ID ||
    client_secret !== OAUTH_CLIENT_SECRET
  ) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  if (grant_type === "authorization_code") {
    const entry = code ? authCodes.get(code) : undefined;
    if (!entry || entry.expiresAt < Date.now()) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    authCodes.delete(code);
    const accessToken = crypto.randomBytes(32).toString("hex");
    const refreshToken = crypto.randomBytes(32).toString("hex");
    accessTokens.add(accessToken);
    res.json({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 3600 * 24 * 30,
      refresh_token: refreshToken,
    });
    return;
  }

  if (grant_type === "refresh_token") {
    // Single-user server: any refresh request from a known client just gets a fresh token.
    const accessToken = crypto.randomBytes(32).toString("hex");
    accessTokens.add(accessToken);
    res.json({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 3600 * 24 * 30,
      refresh_token: refresh_token || crypto.randomBytes(32).toString("hex"),
    });
    return;
  }

  res.status(400).json({ error: "unsupported_grant_type" });
});

// ---------- One-time Whoop OAuth flow (visit /auth/login once in a browser) ----------

let pendingState: string | null = null;

app.get("/auth/login", (_req, res) => {
  pendingState = crypto.randomBytes(16).toString("hex");
  res.redirect(getAuthorizeUrl(pendingState));
});

app.get("/auth/callback", async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code || !state || state !== pendingState) {
    res.status(400).send("Invalid or expired OAuth state. Start again at /auth/login.");
    return;
  }
  pendingState = null;
  try {
    await exchangeCodeForTokens(code);
    res.send("Whoop connected successfully. You can close this tab and return to Claude.");
  } catch (err: any) {
    res.status(500).send(`Token exchange failed: ${err.message}`);
  }
});

// ---------- MCP server definition ----------

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "whoop-mcp", version: "1.0.0" });

  server.tool(
    "get_profile",
    "Get the connected Whoop user's basic profile (name, email, user id).",
    {},
    async () => {
      const data = await whoopGet("/developer/v1/user/profile/basic");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_recovery",
    "Get recent Whoop recovery scores (HRV, resting heart rate, recovery %). Optionally bound by date range.",
    {
      start: z.string().optional().describe("ISO 8601 start datetime, e.g. 2026-08-01T00:00:00Z"),
      end: z.string().optional().describe("ISO 8601 end datetime"),
      limit: z.number().optional().describe("Max records to return (default 10)"),
    },
    async ({ start, end, limit }) => {
      const data = await whoopGet("/developer/v1/recovery", {
        start,
        end,
        limit: String(limit ?? 10),
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_sleep",
    "Get recent Whoop sleep records (duration, stages, sleep performance %).",
    {
      start: z.string().optional().describe("ISO 8601 start datetime"),
      end: z.string().optional().describe("ISO 8601 end datetime"),
      limit: z.number().optional().describe("Max records to return (default 10)"),
    },
    async ({ start, end, limit }) => {
      const data = await whoopGet("/developer/v1/activity/sleep", {
        start,
        end,
        limit: String(limit ?? 10),
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_workouts",
    "Get recent Whoop workouts (strain, sport, duration, heart rate zones).",
    {
      start: z.string().optional().describe("ISO 8601 start datetime"),
      end: z.string().optional().describe("ISO 8601 end datetime"),
      limit: z.number().optional().describe("Max records to return (default 10)"),
    },
    async ({ start, end, limit }) => {
      const data = await whoopGet("/developer/v1/activity/workout", {
        start,
        end,
        limit: String(limit ?? 10),
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_cycles",
    "Get recent Whoop physiological cycles (daily strain, average/max heart rate).",
    {
      start: z.string().optional().describe("ISO 8601 start datetime"),
      end: z.string().optional().describe("ISO 8601 end datetime"),
      limit: z.number().optional().describe("Max records to return (default 10)"),
    },
    async ({ start, end, limit }) => {
      const data = await whoopGet("/developer/v1/cycle", {
        start,
        end,
        limit: String(limit ?? 10),
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_body_measurements",
    "Get the connected Whoop user's body measurements (height, weight, max heart rate).",
    {},
    async () => {
      const data = await whoopGet("/developer/v1/user/measurement/body");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}

// ---------- MCP HTTP endpoint (stateless: one transport per request) ----------

app.post("/mcp", async (req, res) => {
  if (OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET) {
    const authHeader = req.header("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token || !accessTokens.has(token)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  } else if (SHARED_SECRET) {
    const provided = req.header("x-mcp-shared-secret");
    if (provided !== SHARED_SECRET) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

app.get("/", (_req, res) => {
  res.send("Whoop MCP server is running. Visit /auth/login once to connect your Whoop account.");
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.get("/privacy", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "privacy.html"));
});

app.listen(PORT, () => {
  console.log(`Whoop MCP server listening on port ${PORT}`);
});
