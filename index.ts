import express from "express";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getAuthorizeUrl, exchangeCodeForTokens, whoopGet } from "./whoopClient.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SHARED_SECRET = process.env.MCP_SHARED_SECRET; // optional but recommended

const app = express();
app.use(express.json());

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
  if (SHARED_SECRET) {
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

app.listen(PORT, () => {
  console.log(`Whoop MCP server listening on port ${PORT}`);
});
