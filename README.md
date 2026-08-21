# whoop-mcp

A remote MCP server that exposes your Whoop data (recovery, sleep, workouts,
cycles, profile, body measurements) as tools Claude can call.

## 1. Create a Whoop app

1. Go to https://developer.whoop.com and sign in with your Whoop account.
2. Create a Team (if you don't have one), then create an App.
3. Request these scopes: `offline`, `read:profile`, `read:recovery`,
   `read:sleep`, `read:workout`, `read:cycles`, `read:body_measurement`.
4. Set the app's redirect URI to `https://<your-deployed-domain>/auth/callback`
   (you'll fill in the real domain once you've deployed in step 3).
5. Copy the **Client ID** and **Client Secret** — you'll need them below.

## 2. Configure environment variables

Copy `.env.example` to `.env` and fill in:

- `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET` — from step 1
- `WHOOP_REDIRECT_URI` — must exactly match what you registered in the Whoop dashboard
- `MCP_SHARED_SECRET` — make up a long random string (e.g. `openssl rand -hex 32`).
  This is what stops random internet traffic from calling your tools once the
  server is public.

## 3. Deploy

Any host that runs Node and gives you a public HTTPS URL works — Render,
Railway, Fly.io, a small VPS, etc. Rough steps for most of them:

```bash
npm install
npm run build
npm start
```

Set the environment variables from step 2 in your host's dashboard. Once
deployed, go back to the Whoop Developer Dashboard and update the app's
redirect URI to match your real deployed URL, e.g.
`https://whoop-mcp.onrender.com/auth/callback`.

## 4. Authorize your Whoop account (one-time)

Visit `https://<your-deployed-domain>/auth/login` in a browser, log in with
your Whoop account, and approve access. You'll be redirected back and see a
"Whoop connected successfully" message. Tokens are saved to disk and
refreshed automatically after that — you shouldn't need to do this again
unless you revoke access.

## 5. Connect it to Claude

1. In Claude, go to **Settings → Connectors**.
2. Click **+**, then **Add custom connector**.
3. Enter your server's MCP URL: `https://<your-deployed-domain>/mcp`
4. Open **Request headers**, add a header named `x-mcp-shared-secret` with
   the same value you set for `MCP_SHARED_SECRET`.
5. Click **Add**, then toggle the connector on for a conversation.

Now you can ask Claude things like "what's my recovery been like this week"
and it'll call `get_recovery` against your own Whoop data.

## Notes

- This is built for **single-user personal use** — tokens are stored in a
  single file on the server, not per-Claude-user. Don't deploy this somewhere
  multiple people would connect to.
- Whoop API access is currently free; see https://developer.whoop.com for
  rate limits and data model docs (cycles vs. sleep vs. recovery).
- If you ever need to disconnect, revoke access from your Whoop account
  settings and delete `whoop-tokens.json` on the server.
