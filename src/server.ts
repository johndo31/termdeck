import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverSessionsForFolder } from "./discover";
import { PtyManager, type WsData } from "./pty-manager";
import {
  createSessionRecord,
  detectLocalBinaries,
  discoverLocalProjects,
  discoverSshHosts,
  generateAuthToken,
  listNetworkAddresses,
  loadConfig,
  loadSessions,
  readLocalGitBranch,
  saveConfig,
  saveSessions,
} from "./store";
import type { AgentKind, SessionRecord, SessionView } from "./types";

let config = loadConfig();
const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 3434;
const HOST = process.env.HOST || "127.0.0.1";
const ENV_AUTH_TOKEN = (process.env.TERMDECK_AUTH_TOKEN || "").trim();
const PUBLIC_DIR = join(import.meta.dir, "..", "public");

let remoteServer: ReturnType<typeof Bun.serve<WsData>> | null = null;
let remoteError: string | null = null;
let caffeinateProc: ReturnType<typeof Bun.spawn> | null = null;

function syncKeepAwake() {
  if (caffeinateProc) {
    try {
      caffeinateProc.kill();
    } catch {
      // ignore
    }
    caffeinateProc = null;
  }
  if (process.platform !== "darwin") return;
  if (!config.remoteAccess || !config.keepAwakeOnAc) return;
  try {
    // -s prevents system sleep on AC power only (display still sleeps normally);
    // -w <pid> auto-exits caffeinate if this server process exits.
    caffeinateProc = Bun.spawn(["caffeinate", "-s", "-w", String(process.pid)], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    caffeinateProc = null;
  }
}

function activeAuthToken(isRemoteListener: boolean): string {
  if (ENV_AUTH_TOKEN) return ENV_AUTH_TOKEN;
  if (isRemoteListener) return config.authToken.trim();
  return "";
}

let sessions: SessionRecord[] = loadSessions();

const ptyManager = new PtyManager(`http://${HOST}:${PORT}`, (sessionId) => {
  const s = sessions.find((x) => x.id === sessionId);
  if (s && !s.hasStarted) {
    s.hasStarted = true;
    s.lastActiveAt = new Date().toISOString();
    saveSessions(sessions);
  }
});

function toSessionView(session: SessionRecord): SessionView {
  const rt = ptyManager.getRuntimeInfo(session);
  return {
    ...session,
    status: rt.status,
    statusDetail: rt.statusDetail,
    backend: rt.backend,
    lastOutputAt: rt.lastOutputAt,
    exitCode: rt.exitCode,
    gitBranch: session.host === "local" ? readLocalGitBranch(session.cwd) : undefined,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function serveStatic(pathname: string): Response {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (rel.includes("..")) return new Response("Forbidden", { status: 403 });
  const filePath = join(PUBLIC_DIR, rel);
  if (!existsSync(filePath)) return new Response("Not Found", { status: 404 });
  return new Response(Bun.file(filePath), {
    headers: { "cache-control": "no-store" },
  });
}

function parseCookies(cookieHeader: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isLoopbackIp(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isAuthorizedRequest(req: Request, clientIp: string | undefined, token: string): boolean {
  if (!token) return true;
  if (isLoopbackIp(clientIp)) return true;
  const authHeader = req.headers.get("authorization") || "";
  if (authHeader === `Bearer ${token}`) return true;
  const cookies = parseCookies(req.headers.get("cookie"));
  if (cookies.termdeck_auth === token) return true;
  const url = new URL(req.url);
  if (url.searchParams.get("token") === token) return true;
  return false;
}

function renderLoginPage(hasError = false): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>termdeck — Remote Access</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; background: #0b0d11; color: #f0f4fa; font-family: "SF Mono", Menlo, monospace; display: flex; align-items: center; justify-content: center; padding: 20px; }
  form { width: min(360px, 100%); background: #12161d; border: 1px solid #2d3546; border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
  h1 { margin: 0; font-size: 15px; }
  p { margin: 0; font-size: 12px; color: #95a2b8; line-height: 1.5; }
  input { height: 38px; padding: 0 11px; border-radius: 7px; border: 1px solid #2d3546; background: #0b0d11; color: #f0f4fa; font-family: inherit; font-size: 13px; }
  button { height: 38px; border-radius: 7px; border: none; background: #6c8cff; color: #090b10; font-family: inherit; font-weight: 600; font-size: 13px; cursor: pointer; }
  .err { color: #f87171; font-size: 12px; }
</style>
</head>
<body>
  <form method="GET" action="/">
    <h1>termdeck remote access</h1>
    <p>Enter the access token shown in termdeck Settings on your Mac, or open the full link directly.</p>
    ${hasError ? '<div class="err">Invalid token. Check Settings → Remote Access on your Mac.</div>' : ""}
    <input name="token" type="password" placeholder="Access token" autocomplete="off" autofocus required />
    <button type="submit">Connect</button>
  </form>
</body>
</html>`;
  return new Response(html, { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
}

function isAllowedOrigin(req: Request, actualPort: number): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const reqHost = req.headers.get("host");
    if (reqHost && parsed.host.toLowerCase() === reqHost.toLowerCase()) {
      return true;
    }
    const allowedHosts = new Set(["127.0.0.1", "localhost", HOST]);
    const effectivePort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return allowedHosts.has(parsed.hostname) && effectivePort === String(actualPort);
  } catch {
    return false;
  }
}

function buildRemoteConfigPayload(actualPort: number) {
  const addresses = listNetworkAddresses();
  const activeRemote = Boolean(remoteServer) || HOST !== "127.0.0.1";
  const effectivePort = remoteServer ? remoteServer.port : (config.remoteAccess ? config.remotePort : actualPort);
  const token = config.authToken || ENV_AUTH_TOKEN;
  const tokenQuery = token ? `/?token=${encodeURIComponent(token)}` : "/";

  return {
    remoteAccess: config.remoteAccess,
    remotePort: config.remotePort,
    authToken: token,
    keepAwakeOnAc: config.keepAwakeOnAc,
    keepAwakeActive: Boolean(caffeinateProc),
    activeHost: remoteServer ? "0.0.0.0" : HOST,
    activePort: effectivePort,
    activeRemote,
    needsRestart: false,
    error: remoteError,
    urls: addresses.map((a) => ({
      iface: a.iface,
      address: a.address,
      kind: a.kind,
      url: `http://${a.address}:${effectivePort}${tokenQuery}`,
    })),
  };
}

function createServerHandlers(isRemoteListener: boolean) {
  return {
    async fetch(req: Request, srv: ReturnType<typeof Bun.serve<WsData>>) {
    const url = new URL(req.url);
    const { pathname } = url;
    const clientIp = srv.requestIP(req)?.address;
    const token = activeAuthToken(isRemoteListener);

    // Magic-link token login -> set HttpOnly cookie and strip token from URL
    if (token && pathname === "/" && url.searchParams.has("token")) {
      const provided = url.searchParams.get("token") || "";
      if (provided === token) {
        return new Response(null, {
          status: 302,
          headers: {
            location: "/",
            "set-cookie": `termdeck_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
          },
        });
      }
      return renderLoginPage(true);
    }

    // Require auth for non-loopback requests when remote token is active
    if (!isAuthorizedRequest(req, clientIp, token)) {
      if (pathname === "/" || pathname === "/index.html") {
        return renderLoginPage(false);
      }
      return new Response("Unauthorized", { status: 401 });
    }

    // Reject cross-origin WebSocket upgrades and mutating API calls (prevents CSWSH)
    if (
      (pathname.startsWith("/ws/") || (pathname.startsWith("/api/") && req.method !== "GET")) &&
      !isAllowedOrigin(req, srv.port)
    ) {
      return new Response("Forbidden origin", { status: 403 });
    }

    // WebSocket upgrades
    if (pathname === "/ws/events") {
      if (srv.upgrade(req, { data: { kind: "events" } })) return undefined;
      return new Response("Upgrade failed", { status: 400 });
    }

    const wsTermMatch = /^\/ws\/term\/([^/]+)$/.exec(pathname);
    if (wsTermMatch) {
      const sessionId = decodeURIComponent(wsTermMatch[1]);
      if (!sessions.some((s) => s.id === sessionId)) {
        return new Response("Session not found", { status: 404 });
      }
      if (srv.upgrade(req, { data: { kind: "term", sessionId } })) return undefined;
      return new Response("Upgrade failed", { status: 400 });
    }

    // REST API
    if (pathname === "/api/meta" && req.method === "GET") {
      return json({
        homeDir: homedir(),
        projects: discoverLocalProjects(),
        sshHosts: discoverSshHosts(),
        binaries: detectLocalBinaries(),
        localTmux: ptyManager.localTmuxAvailable,
      });
    }

    if (pathname === "/api/prefs") {
      if (req.method === "GET") {
        return json({ prefs: config.prefs ?? {} });
      }
      if (req.method === "PATCH") {
        const body = (await req.json()) as Record<string, unknown>;
        config.prefs = { ...(config.prefs ?? {}), ...body };
        saveConfig(config);
        return json({ prefs: config.prefs });
      }
    }

    if (pathname === "/api/remote-config") {
      if (req.method === "GET") {
        return json(buildRemoteConfigPayload(srv.port));
      }
      if (req.method === "PATCH") {
        // Only allow changing remote access config from localhost
        if (!isLoopbackIp(clientIp)) {
          return json({ error: "Remote config can only be changed locally" }, 403);
        }
        const body = (await req.json()) as {
          remoteAccess?: boolean;
          remotePort?: number;
          keepAwakeOnAc?: boolean;
          regenerateToken?: boolean;
        };
        if (typeof body.remoteAccess === "boolean") {
          config.remoteAccess = body.remoteAccess;
        }
        if (typeof body.keepAwakeOnAc === "boolean") {
          config.keepAwakeOnAc = body.keepAwakeOnAc;
        }
        if (body.remotePort !== undefined) {
          const p = Number(body.remotePort);
          if (Number.isInteger(p) && p >= 1024 && p <= 65535) {
            config.remotePort = p;
          }
        }
        if (body.regenerateToken || (config.remoteAccess && !config.authToken)) {
          config.authToken = generateAuthToken();
        }
        saveConfig(config);
        syncRemoteListener();
        syncKeepAwake();
        return json(buildRemoteConfigPayload(srv.port));
      }
    }

    if (pathname === "/api/discover" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd") || "";
      const found = cwd ? discoverSessionsForFolder(cwd) : [];
      return json({ sessions: found });
    }

    if (pathname === "/api/sessions" && req.method === "GET") {
      return json({ sessions: sessions.map(toSessionView) });
    }

    if (pathname === "/api/sessions" && req.method === "POST") {
      const body = (await req.json()) as {
        title?: string;
        cwd?: string;
        host?: string;
        agent?: AgentKind;
        resumeSessionId?: string;
        customCommand?: string;
        customResumeCommand?: string;
      };

      const validAgents: AgentKind[] = ["claude", "antigravity", "codex", "gemini", "shell"];
      const agent: AgentKind = validAgents.includes(body.agent as AgentKind)
        ? (body.agent as AgentKind)
        : "claude";

      const record = createSessionRecord({
        title: body.title,
        cwd: body.cwd || homedir(),
        host: body.host || "local",
        agent,
        resumeSessionId: body.resumeSessionId,
        customCommand: body.customCommand,
        customResumeCommand: body.customResumeCommand,
      });

      sessions.unshift(record);
      saveSessions(sessions);
      ptyManager.broadcastEvent({ type: "sessions_changed" });
      return json({ session: toSessionView(record) }, 201);
    }

    const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
    if (sessionMatch) {
      const id = decodeURIComponent(sessionMatch[1]);
      const idx = sessions.findIndex((s) => s.id === id);
      if (idx === -1) return json({ error: "Not found" }, 404);

      if (req.method === "PATCH") {
        const body = (await req.json()) as { title?: string };
        if (typeof body.title === "string" && body.title.trim()) {
          sessions[idx].title = body.title.trim();
          saveSessions(sessions);
          ptyManager.broadcastEvent({ type: "sessions_changed" });
        }
        return json({ session: toSessionView(sessions[idx]) });
      }

      if (req.method === "DELETE") {
        const [removed] = sessions.splice(idx, 1);
        saveSessions(sessions);
        ptyManager.killSession(removed);
        ptyManager.broadcastEvent({ type: "sessions_changed" });
        return json({ ok: true });
      }
    }

    const resumeMatch = /^\/api\/sessions\/([^/]+)\/resume$/.exec(pathname);
    if (resumeMatch && req.method === "POST") {
      const id = decodeURIComponent(resumeMatch[1]);
      const session = sessions.find((s) => s.id === id);
      if (!session) return json({ error: "Not found" }, 404);

      let fresh = false;
      try {
        const body = (await req.json()) as { fresh?: boolean };
        fresh = Boolean(body.fresh);
      } catch {
        // empty body is fine
      }

      if (fresh) {
        session.sessionUuid = crypto.randomUUID();
        session.externalSessionId = undefined;
        session.hasStarted = false;
      }
      session.lastActiveAt = new Date().toISOString();
      saveSessions(sessions);

      ptyManager.restartSession(session, { fresh });
      ptyManager.broadcastEvent({ type: "sessions_changed" });
      return json({ session: toSessionView(session) });
    }

    const hookMatch = /^\/api\/hooks\/([^/]+)$/.exec(pathname);
    if (hookMatch && req.method === "POST") {
      const id = decodeURIComponent(hookMatch[1]);
      let event = "notification";
      let message: string | undefined;
      try {
        const body = (await req.json()) as {
          event?: string;
          hook_event_name?: string;
          message?: string;
          tool_name?: string;
        };
        event = body.event || body.hook_event_name || "notification";
        message = body.message || (body.tool_name ? `Approve ${body.tool_name}` : undefined);
      } catch {
        // empty body defaults to notification
      }
      const ok = ptyManager.applyExternalHook(id, event, message);
      return json({ ok }, ok ? 200 : 404);
    }

    return serveStatic(pathname);
  },
  websocket: {
    open(ws: import("bun").ServerWebSocket<WsData>) {
      if (ws.data.kind === "events") {
        ptyManager.addEventClient(ws);
        return;
      }
      const { sessionId } = ws.data;
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) {
        ws.close(1008, "Unknown session");
        return;
      }
      ptyManager.attachClient(session, ws);
    },
    message(ws: import("bun").ServerWebSocket<WsData>, raw: string | Buffer) {
      if (ws.data.kind !== "term") return;
      const { sessionId } = ws.data;
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return;

      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      try {
        const msg = JSON.parse(text) as
          | { type: "input"; data: string }
          | { type: "resize"; cols: number; rows: number };
        if (msg.type === "input" && typeof msg.data === "string") {
          ptyManager.writeInput(session, msg.data);
        } else if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
          ptyManager.resize(session.id, msg.cols, msg.rows);
        }
      } catch {
        // Ignore malformed control frames
      }
    },
    close(ws: import("bun").ServerWebSocket<WsData>) {
      if (ws.data.kind === "events") {
        ptyManager.removeEventClient(ws);
        return;
      }
      ptyManager.detachClient(ws.data.sessionId, ws);
    },
  },
  };
}

function syncRemoteListener() {
  if (remoteServer) {
    try {
      remoteServer.stop(true);
    } catch {
      // ignore
    }
    remoteServer = null;
  }
  remoteError = null;

  if (!config.remoteAccess || HOST !== "127.0.0.1") return;
  if (!config.authToken) {
    config.authToken = generateAuthToken();
    saveConfig(config);
  }
  try {
    remoteServer = Bun.serve<WsData>({
      hostname: "0.0.0.0",
      port: config.remotePort,
      ...createServerHandlers(true),
    });
  } catch (err) {
    remoteError = err instanceof Error ? err.message : `Failed to listen on port ${config.remotePort}`;
    remoteServer = null;
  }
}

const server = Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,
  ...createServerHandlers(HOST !== "127.0.0.1"),
});

syncRemoteListener();
syncKeepAwake();

process.on("SIGTERM", () => {
  if (caffeinateProc) {
    try { caffeinateProc.kill(); } catch {}
  }
  process.exit(0);
});

ptyManager.setServerUrl(`http://${HOST}:${server.port}`);
console.log(`TERMDECK_READY http://${HOST}:${server.port}`);
console.log(
  `persistence: ${ptyManager.localTmuxAvailable ? "tmux (-L termdeck) + sessions.json" : "in-memory PTY + CLI --resume (install tmux for cross-restart persistence)"}`
);
