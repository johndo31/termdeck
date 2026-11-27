import type { ServerWebSocket } from "bun";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSessionFileExists } from "./discover";
import { SessionStatusDetector } from "./status-detector";
import { TERMDECK_DIR } from "./store";
import { AGENT_PRESETS, shellQuote, type SessionRecord, type SessionStatus } from "./types";

export interface TermSocketData {
  kind: "term";
  sessionId: string;
  cols?: number;
  rows?: number;
}

export interface EventSocketData {
  kind: "events";
}

export type WsData = TermSocketData | EventSocketData;

interface LivePty {
  sessionId: string;
  proc: ReturnType<typeof Bun.spawn>;
  backend: "tmux" | "pty";
  detector: SessionStatusDetector;
  exitCode: number | null;
  lastOutputAt: number;
  buffer: string[];
  bufferBytes: number;
  clients: Set<ServerWebSocket<WsData>>;
  cols: number;
  rows: number;
}

const MAX_BUFFER_BYTES = 256 * 1024;

function tmuxSessionName(id: string): string {
  return `td_${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export class PtyManager {
  private live = new Map<string, LivePty>();
  private eventClients = new Set<ServerWebSocket<WsData>>();
  private hasLocalTmux: boolean;
  private serverUrl: string;
  private onSessionStarted: (sessionId: string) => void;

  constructor(serverUrl: string, onSessionStarted: (sessionId: string) => void) {
    this.hasLocalTmux = Bun.which("tmux") !== null;
    this.serverUrl = serverUrl;
    this.onSessionStarted = onSessionStarted;
  }

  get localTmuxAvailable(): boolean {
    return this.hasLocalTmux;
  }

  setServerUrl(url: string) {
    this.serverUrl = url;
  }

  addEventClient(ws: ServerWebSocket<WsData>) {
    this.eventClients.add(ws);
  }

  removeEventClient(ws: ServerWebSocket<WsData>) {
    this.eventClients.delete(ws);
  }

  broadcastEvent(payload: Record<string, unknown>) {
    const text = JSON.stringify(payload);
    for (const ws of this.eventClients) {
      try {
        ws.send(text);
      } catch {
        this.eventClients.delete(ws);
      }
    }
  }

  applyExternalHook(sessionId: string, event: string, message?: string): boolean {
    const entry = this.live.get(sessionId);
    if (!entry) return false;
    entry.detector.applyExternalHook(event, message);
    return true;
  }

  getRuntimeInfo(session: SessionRecord): {
    status: SessionStatus;
    statusDetail?: string;
    backend: "tmux" | "pty";
    lastOutputAt?: number;
    exitCode?: number | null;
  } {
    const entry = this.live.get(session.id);
    if (entry) {
      const { status, detail } = entry.detector.state;
      return {
        status,
        statusDetail: detail,
        backend: entry.backend,
        lastOutputAt: entry.lastOutputAt,
        exitCode: entry.exitCode,
      };
    }
    const backend: "tmux" | "pty" = session.host !== "local" || this.hasLocalTmux ? "tmux" : "pty";
    return {
      status: "dormant",
      statusDetail: "Click to resume",
      backend,
    };
  }

  attachClient(session: SessionRecord, ws: ServerWebSocket<WsData>, cols = 120, rows = 36) {
    let entry = this.live.get(session.id);
    if (!entry) {
      entry = this.spawnSession(session, { resume: session.hasStarted, cols, rows });
    }
    entry.clients.add(ws);

    if (entry.buffer.length > 0) {
      ws.send(JSON.stringify({ type: "data", data: entry.buffer.join("") }));
    }

    const { status, detail } = entry.detector.state;
    ws.send(
      JSON.stringify({
        type: "status",
        sessionId: session.id,
        status,
        statusDetail: detail,
        backend: entry.backend,
        exitCode: entry.exitCode,
      })
    );
  }

  detachClient(sessionId: string, ws: ServerWebSocket<WsData>) {
    const entry = this.live.get(sessionId);
    if (!entry) return;
    entry.clients.delete(ws);
  }

  writeInput(session: SessionRecord, data: string) {
    const entry = this.live.get(session.id);
    if (!entry) {
      const spawned = this.spawnSession(session, { resume: session.hasStarted });
      spawned.detector.onUserInput(data);
      spawned.proc.terminal?.write(data);
      return;
    }
    if (entry.detector.state.status === "exited") {
      if (data === "\r" || data === "\n") {
        this.restartSession(session, { fresh: false });
      }
      return;
    }
    entry.detector.onUserInput(data);
    entry.proc.terminal?.write(data);
  }

  resize(sessionId: string, cols: number, rows: number) {
    const entry = this.live.get(sessionId);
    if (!entry || entry.detector.state.status === "exited") return;
    const safeCols = Math.max(20, Math.min(500, Math.floor(cols)));
    const safeRows = Math.max(5, Math.min(200, Math.floor(rows)));
    if (safeCols === entry.cols && safeRows === entry.rows) return;
    entry.cols = safeCols;
    entry.rows = safeRows;
    entry.detector.onResize();
    try {
      entry.proc.terminal?.resize(safeCols, safeRows);
    } catch {
      // ignore if terminal already closed
    }
  }

  restartSession(session: SessionRecord, opts: { fresh: boolean }) {
    const existing = this.live.get(session.id);
    const prevClients = existing ? new Set(existing.clients) : new Set<ServerWebSocket<WsData>>();
    const cols = existing?.cols ?? 120;
    const rows = existing?.rows ?? 36;

    if (existing) {
      this.teardownEntry(existing, opts.fresh);
    } else if (opts.fresh) {
      this.killTmuxSession(session);
    }

    const entry = this.spawnSession(session, { resume: !opts.fresh, cols, rows });
    const { status, detail } = entry.detector.state;
    for (const ws of prevClients) {
      entry.clients.add(ws);
      ws.send(JSON.stringify({ type: "clear" }));
      ws.send(
        JSON.stringify({
          type: "status",
          sessionId: session.id,
          status,
          statusDetail: detail,
          backend: entry.backend,
          exitCode: null,
        })
      );
    }
  }

  killSession(session: SessionRecord) {
    const existing = this.live.get(session.id);
    if (existing) {
      for (const ws of existing.clients) {
        try {
          ws.close(1000, "Session deleted");
        } catch {
          // ignore
        }
      }
      this.teardownEntry(existing, true);
    } else {
      this.killTmuxSession(session);
    }
  }

  private teardownEntry(entry: LivePty, killTmux: boolean) {
    entry.detector.dispose();
    this.live.delete(entry.sessionId);
    try {
      entry.proc.terminal?.close();
    } catch {
      // ignore
    }
    try {
      entry.proc.kill();
    } catch {
      // ignore
    }
    if (killTmux && entry.backend === "tmux" && this.hasLocalTmux) {
      try {
        Bun.spawn(["tmux", "-L", "termdeck", "kill-session", "-t", tmuxSessionName(entry.sessionId)], {
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch {
        // ignore
      }
    }
  }

  private killTmuxSession(session: SessionRecord) {
    const name = tmuxSessionName(session.id);
    if (session.host === "local") {
      if (!this.hasLocalTmux) return;
      Bun.spawn(["tmux", "-L", "termdeck", "kill-session", "-t", name], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } else {
      Bun.spawn(
        [
          "ssh",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=5",
          session.host,
          `tmux -L termdeck kill-session -t ${shellQuote(name)} 2>/dev/null || true`,
        ],
        { stdout: "ignore", stderr: "ignore" }
      );
    }
  }

  private resolveAgentCommand(session: SessionRecord, resume: boolean): string {
    const preset = AGENT_PRESETS[session.agent] ?? AGENT_PRESETS.shell;
    if (resume) {
      if (session.customResumeCommand) return session.customResumeCommand;
      if (session.customCommand) return session.customCommand;
      // Claude Code only writes <uuid>.jsonl after the first message is sent.
      // If it doesn't exist yet on disk, start cleanly with --session-id instead of failing --resume.
      if (
        session.agent === "claude" &&
        session.host === "local" &&
        !claudeSessionFileExists(session.cwd, session.sessionUuid)
      ) {
        return preset.buildStartCommand(session);
      }
      return preset.buildResumeCommand(session);
    }
    if (session.customCommand) return session.customCommand;
    return preset.buildStartCommand(session);
  }

  private buildSpawnSpec(
    session: SessionRecord,
    resume: boolean
  ): { argv: string[]; cwd: string; backend: "tmux" | "pty" } {
    const userShell = process.env.SHELL || "/bin/zsh";
    const agentCmd = this.resolveAgentCommand(session, resume).trim();
    const tmuxName = tmuxSessionName(session.id);

    if (session.host !== "local") {
      const controlPath = join(TERMDECK_DIR, "ssh-%r@%h:%p");
      const remoteDir = session.cwd || "~";
      const cdExpr =
        remoteDir === "~"
          ? `cd "$HOME"`
          : remoteDir.startsWith("~/")
            ? `cd "$HOME"/${shellQuote(remoteDir.slice(2))}`
            : `cd ${shellQuote(remoteDir)}`;
      const launchExpr = agentCmd
        ? `exec "\${SHELL:-/bin/sh}" -lc ${shellQuote(agentCmd)}`
        : `exec "\${SHELL:-/bin/sh}" -l`;

      const remoteScript = [
        `${cdExpr} || true`,
        `if command -v tmux >/dev/null 2>&1; then`,
        `  if ! tmux -L termdeck has-session -t ${shellQuote(tmuxName)} 2>/dev/null; then`,
        `    tmux -L termdeck new-session -d -s ${shellQuote(tmuxName)} ${shellQuote(launchExpr)}`,
        `    tmux -L termdeck set-option -t ${shellQuote(tmuxName)} status off 2>/dev/null || true`,
        `    tmux -L termdeck set-option -t ${shellQuote(tmuxName)} mouse on 2>/dev/null || true`,
        `    tmux -L termdeck set-option -t ${shellQuote(tmuxName)} history-limit 50000 2>/dev/null || true`,
        `    tmux -L termdeck set-option -t ${shellQuote(tmuxName)} window-size latest 2>/dev/null || true`,
        `    tmux -L termdeck set-option -t ${shellQuote(tmuxName)} allow-passthrough on 2>/dev/null || true`,
        `  fi`,
        `  exec tmux -L termdeck attach-session -t ${shellQuote(tmuxName)}`,
        `else`,
        `  ${launchExpr}`,
        `fi`,
      ].join("\n");

      return {
        argv: [
          "ssh",
          "-tt",
          "-o",
          "ServerAliveInterval=15",
          "-o",
          "ControlMaster=auto",
          "-o",
          `ControlPath=${controlPath}`,
          "-o",
          "ControlPersist=10m",
          session.host,
          remoteScript,
        ],
        cwd: homedir(),
        backend: "tmux",
      };
    }

    const localCwd = existsSync(session.cwd) ? session.cwd : homedir();

    if (this.hasLocalTmux) {
      const innerCmd = agentCmd
        ? `${shellQuote(userShell)} -lc ${shellQuote(agentCmd)}`
        : `${shellQuote(userShell)} -l`;
      const script = [
        `if ! tmux -L termdeck has-session -t ${shellQuote(tmuxName)} 2>/dev/null; then`,
        `  tmux -L termdeck new-session -d -s ${shellQuote(tmuxName)} -c ${shellQuote(localCwd)} ${shellQuote(innerCmd)}`,
        `  tmux -L termdeck set-option -t ${shellQuote(tmuxName)} status off 2>/dev/null || true`,
        `  tmux -L termdeck set-option -t ${shellQuote(tmuxName)} mouse on 2>/dev/null || true`,
        `  tmux -L termdeck set-option -t ${shellQuote(tmuxName)} history-limit 50000 2>/dev/null || true`,
        `  tmux -L termdeck set-option -t ${shellQuote(tmuxName)} window-size latest 2>/dev/null || true`,
        `  tmux -L termdeck set-option -t ${shellQuote(tmuxName)} allow-passthrough on 2>/dev/null || true`,
        `fi`,
        `exec tmux -L termdeck attach-session -t ${shellQuote(tmuxName)}`,
      ].join("\n");

      return {
        argv: ["/bin/sh", "-c", script],
        cwd: localCwd,
        backend: "tmux",
      };
    }

    const argv = agentCmd ? [userShell, "-lc", agentCmd] : [userShell, "-l"];
    return { argv, cwd: localCwd, backend: "pty" };
  }

  private spawnSession(
    session: SessionRecord,
    opts: { resume: boolean; cols?: number; rows?: number }
  ): LivePty {
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 36;
    const spec = this.buildSpawnSpec(session, opts.resume);
    const decoder = new TextDecoder();

    const entry: LivePty = {
      sessionId: session.id,
      proc: null as unknown as ReturnType<typeof Bun.spawn>,
      backend: spec.backend,
      detector: null as unknown as SessionStatusDetector,
      exitCode: null,
      lastOutputAt: Date.now(),
      buffer: [],
      bufferBytes: 0,
      clients: new Set(),
      cols,
      rows,
    };

    entry.detector = new SessionStatusDetector(session.agent, (state, bell) => {
      this.broadcastStatus(entry, state.status, state.detail, bell);
    });

    const browserHelper = join(import.meta.dir, "..", "scripts", "termdeck-open");
    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "termdeck",
      TERMDECK_SESSION_ID: session.id,
      TERMDECK_URL: this.serverUrl,
      ...(existsSync(browserHelper) ? { BROWSER: browserHelper } : {}),
    };

    if (session.host === "local") {
      // Never let inherited parent SSH vars trick local CLIs into thinking they're remote
      delete spawnEnv.SSH_CONNECTION;
      delete spawnEnv.SSH_CLIENT;
      delete spawnEnv.SSH_TTY;
    }

    if (spawnEnv.TMPDIR && !existsSync(spawnEnv.TMPDIR)) {
      const fallbackTmp = tmpdir();
      spawnEnv.TMPDIR = existsSync(fallbackTmp) ? fallbackTmp : "/tmp";
    }

    const proc = Bun.spawn(spec.argv, {
      cwd: spec.cwd,
      env: spawnEnv,
      terminal: {
        cols,
        rows,
        data: (_term, chunk) => {
          const text = decoder.decode(chunk, { stream: true });
          if (!text) return;
          this.handleOutput(entry, text);
        },
        exit: (_term, exitCode) => {
          this.handleExit(entry, exitCode);
        },
      },
    });

    entry.proc = proc;
    this.live.set(session.id, entry);

    if (!session.hasStarted) {
      this.onSessionStarted(session.id);
    }

    this.broadcastStatus(entry, entry.detector.state.status, entry.detector.state.detail, false);
    return entry;
  }

  private handleOutput(entry: LivePty, text: string) {
    entry.buffer.push(text);
    entry.bufferBytes += text.length;
    while (entry.bufferBytes > MAX_BUFFER_BYTES && entry.buffer.length > 1) {
      const removed = entry.buffer.shift();
      if (removed) entry.bufferBytes -= removed.length;
    }

    entry.lastOutputAt = Date.now();

    const payload = JSON.stringify({ type: "data", data: text });
    for (const ws of entry.clients) {
      try {
        ws.send(payload);
      } catch {
        entry.clients.delete(ws);
      }
    }

    entry.detector.onOutput(text);
  }

  private handleExit(entry: LivePty, exitCode: number) {
    if (this.live.get(entry.sessionId) !== entry) return;

    entry.exitCode = exitCode;
    const notice = `\r\n\x1b[90m[termdeck] session exited (code ${exitCode}) — press Enter or click Resume to continue\x1b[0m\r\n`;
    entry.buffer.push(notice);
    entry.bufferBytes += notice.length;

    const dataPayload = JSON.stringify({ type: "data", data: notice });
    for (const ws of entry.clients) {
      try {
        ws.send(dataPayload);
      } catch {
        entry.clients.delete(ws);
      }
    }

    entry.detector.onExit(exitCode);
  }

  private broadcastStatus(
    entry: LivePty,
    status: SessionStatus,
    statusDetail?: string,
    bell = false
  ) {
    const statusPayload = {
      type: "status",
      sessionId: entry.sessionId,
      status,
      statusDetail,
      backend: entry.backend,
      exitCode: entry.exitCode,
      lastOutputAt: entry.lastOutputAt,
    };
    const serialized = JSON.stringify(statusPayload);

    for (const ws of entry.clients) {
      try {
        ws.send(serialized);
      } catch {
        entry.clients.delete(ws);
      }
    }
    this.broadcastEvent(statusPayload);

    if (bell) {
      this.broadcastEvent({
        type: "bell",
        sessionId: entry.sessionId,
        status,
        statusDetail,
      });
    }
  }
}
