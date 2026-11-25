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
  loadSessions,
  readLocalGitBranch,
  saveSessions,
} from "./store";
import type { AgentKind, SessionRecord, SessionView } from "./types";

const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 3434;
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = join(import.meta.dir, "..", "public");

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

function isAllowedOrigin(req: Request, actualPort: number): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const allowedHosts = new Set(["127.0.0.1", "localhost", HOST]);
    const effectivePort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return allowedHosts.has(parsed.hostname) && effectivePort === String(actualPort);
  } catch {
    return false;
  }
}

const server = Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const { pathname } = url;

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
    open(ws) {
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
    message(ws, raw) {
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
    close(ws) {
      if (ws.data.kind === "events") {
        ptyManager.removeEventClient(ws);
        return;
      }
      ptyManager.detachClient(ws.data.sessionId, ws);
    },
  },
});

ptyManager.setServerUrl(`http://${HOST}:${server.port}`);
console.log(`TERMDECK_READY http://${HOST}:${server.port}`);
console.log(
  `persistence: ${ptyManager.localTmuxAvailable ? "tmux (-L termdeck) + sessions.json" : "in-memory PTY + CLI --resume (install tmux for cross-restart persistence)"}`
);
