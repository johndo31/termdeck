import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AgentKind, SessionRecord } from "./types";

export const TERMDECK_DIR = join(homedir(), ".termdeck");
const SESSIONS_FILE = join(TERMDECK_DIR, "sessions.json");

function ensureDir() {
  if (!existsSync(TERMDECK_DIR)) {
    mkdirSync(TERMDECK_DIR, { recursive: true });
  }
}

export function loadSessions(): SessionRecord[] {
  ensureDir();
  if (!existsSync(SESSIONS_FILE)) return [];
  try {
    const raw = readFileSync(SESSIONS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveSessions(sessions: SessionRecord[]): void {
  ensureDir();
  const tmp = `${SESSIONS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(sessions, null, 2), "utf8");
  renameSync(tmp, SESSIONS_FILE);
}

export function expandTilde(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

export function deriveProjectName(cwd: string): string {
  const cleaned = cwd.replace(/\/+$/, "");
  if (!cleaned || cleaned === "~") return "home";
  return basename(cleaned) || cleaned;
}

export function createSessionRecord(params: {
  title?: string;
  cwd: string;
  host?: string;
  agent: AgentKind;
  resumeSessionId?: string;
  customCommand?: string;
  customResumeCommand?: string;
}): SessionRecord {
  const host = (params.host || "local").trim() || "local";
  const cwd = host === "local" ? resolve(expandTilde(params.cwd.trim() || homedir())) : (params.cwd.trim() || "~");
  const project = deriveProjectName(cwd);
  const now = new Date().toISOString();
  const shortId = crypto.randomUUID().slice(0, 8);
  const defaultTitle = params.title?.trim() || `${project}`;
  const resumeId = params.resumeSessionId?.trim() || undefined;

  return {
    id: shortId,
    title: defaultTitle,
    project,
    cwd,
    host,
    agent: params.agent,
    sessionUuid: resumeId && params.agent === "claude" ? resumeId : crypto.randomUUID(),
    externalSessionId: resumeId && params.agent !== "claude" ? resumeId : undefined,
    customCommand: params.customCommand?.trim() || undefined,
    customResumeCommand: params.customResumeCommand?.trim() || undefined,
    hasStarted: Boolean(resumeId),
    createdAt: now,
    lastActiveAt: now,
  };
}

export interface ProjectSuggestion {
  name: string;
  path: string;
}

export function discoverLocalProjects(): ProjectSuggestion[] {
  const candidates = ["Development", "development", "code", "Code", "projects", "Projects"].map((d) =>
    join(homedir(), d)
  );
  const seenRoots = new Set<string>();
  const seen = new Set<string>();
  const results: ProjectSuggestion[] = [];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    let root = candidate;
    try {
      root = realpathSync.native(candidate);
    } catch {
      // fall back to candidate path
    }
    const rootKey = root.toLowerCase();
    if (seenRoots.has(rootKey)) continue;
    seenRoots.add(rootKey);

    try {
      const entries = readdirSync(root);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const full = join(root, entry);
        const key = full.toLowerCase();
        if (seen.has(key)) continue;
        try {
          if (statSync(full).isDirectory()) {
            seen.add(key);
            results.push({ name: entry, path: full });
          }
        } catch {
          // ignore unreadable entry
        }
      }
    } catch {
      // ignore unreadable root
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export function discoverSshHosts(): string[] {
  const configPath = join(homedir(), ".ssh", "config");
  if (!existsSync(configPath)) return [];
  try {
    const content = readFileSync(configPath, "utf8");
    const hosts = new Set<string>();
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = /^Host\s+(.+)$/i.exec(trimmed);
      if (!match) continue;
      for (const token of match[1].split(/\s+/)) {
        if (!token || token.includes("*") || token.includes("?") || token.startsWith("!")) continue;
        hosts.add(token);
      }
    }
    return [...hosts].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function readLocalGitBranch(cwd: string): string | undefined {
  try {
    let dir = resolve(expandTilde(cwd));
    for (let depth = 0; depth < 6; depth++) {
      const gitPath = join(dir, ".git");
      if (existsSync(gitPath)) {
        const stat = statSync(gitPath);
        let headPath = join(gitPath, "HEAD");
        if (stat.isFile()) {
          // Worktree or submodule: `.git` contains `gitdir: ...`
          const ptr = readFileSync(gitPath, "utf8").trim();
          const m = /^gitdir:\s*(.+)$/.exec(ptr);
          if (m) {
            headPath = join(resolve(dir, m[1].trim()), "HEAD");
          }
        }
        if (existsSync(headPath)) {
          const head = readFileSync(headPath, "utf8").trim();
          if (head.startsWith("ref: refs/heads/")) {
            return head.slice("ref: refs/heads/".length);
          }
          return head.slice(0, 7);
        }
        return undefined;
      }
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function detectLocalBinaries(): Record<string, boolean> {
  const bins = ["claude", "agy", "codex", "gemini", "tmux"];
  const found: Record<string, boolean> = {};
  for (const bin of bins) {
    found[bin] = Bun.which(bin) !== null;
  }
  return found;
}
