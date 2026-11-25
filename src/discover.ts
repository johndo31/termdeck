import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandTilde } from "./store";
import type { AgentKind } from "./types";

export interface DiscoveredSession {
  agent: AgentKind;
  sessionId: string;
  title: string;
  updatedAt: string;
  updatedAtMs: number;
}

export function encodeClaudeProjectDir(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9-]/g, "-");
}

export function claudeSessionFileExists(cwd: string, sessionUuid: string): boolean {
  try {
    const absCwd = resolve(expandTilde(cwd.trim()));
    const filePath = join(
      homedir(),
      ".claude",
      "projects",
      encodeClaudeProjectDir(absCwd),
      `${sessionUuid}.jsonl`
    );
    return existsSync(filePath) && statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function extractClaudeTitle(filePath: string, fallbackId: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(24 * 1024);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    const chunk = buf.toString("utf8", 0, bytesRead);
    const lines = chunk.split(/\r?\n/);

    let firstUserText = "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as {
          type?: string;
          customTitle?: string;
          summary?: string;
          message?: { role?: string; content?: string | Array<{ type?: string; text?: string }> };
        };
        if (typeof obj.customTitle === "string" && obj.customTitle.trim()) {
          return obj.customTitle.trim().slice(0, 72);
        }
        if (obj.type === "summary" && typeof obj.summary === "string" && obj.summary.trim()) {
          return obj.summary.trim().slice(0, 72);
        }
        if (!firstUserText && (obj.type === "user" || obj.message?.role === "user")) {
          const content = obj.message?.content;
          let text = "";
          if (typeof content === "string") {
            text = content;
          } else if (Array.isArray(content)) {
            const textPart = content.find((p) => p.type === "text" && typeof p.text === "string");
            if (textPart?.text) text = textPart.text;
          }
          // Strip leading XML wrapper tags if present
          const cleaned = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
          if (cleaned && !cleaned.startsWith("Caveat:")) {
            firstUserText = cleaned.slice(0, 72);
          }
        }
      } catch {
        // partial last line is expected
      }
    }
    return firstUserText || `Claude session ${fallbackId.slice(0, 8)}`;
  } catch {
    return `Claude session ${fallbackId.slice(0, 8)}`;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function discoverClaudeSessions(absCwd: string): DiscoveredSession[] {
  const projectsRoot = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsRoot)) return [];

  const encoded = encodeClaudeProjectDir(absCwd);
  const projectDir = join(projectsRoot, encoded);
  if (!existsSync(projectDir)) return [];

  const results: DiscoveredSession[] = [];
  try {
    const entries = readdirSync(projectDir);
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const sessionId = entry.slice(0, -".jsonl".length);
      if (!sessionId || sessionId.startsWith("agent-")) continue;
      const fullPath = join(projectDir, entry);
      try {
        const st = statSync(fullPath);
        if (!st.isFile() || st.size === 0) continue;
        results.push({
          agent: "claude",
          sessionId,
          title: extractClaudeTitle(fullPath, sessionId),
          updatedAt: st.mtime.toISOString(),
          updatedAtMs: st.mtimeMs,
        });
      } catch {
        // ignore unreadable file
      }
    }
  } catch {
    return [];
  }

  return results.sort((a, b) => b.updatedAtMs - a.updatedAtMs).slice(0, 10);
}

function workspaceMatches(workspaceUrisRaw: string, absCwd: string): boolean {
  if (!workspaceUrisRaw) return false;
  const normalizedTarget = absCwd.replace(/\/+$/, "");
  const fileUriTarget = `file://${normalizedTarget}`;

  try {
    const parsed = JSON.parse(workspaceUrisRaw);
    if (Array.isArray(parsed)) {
      return parsed.some((u) => {
        if (typeof u !== "string") return false;
        const clean = decodeURIComponent(u).replace(/\/+$/, "");
        return clean === normalizedTarget || clean === fileUriTarget;
      });
    }
  } catch {
    // Fallback for non-JSON comma/newline separated strings
  }

  const parts = workspaceUrisRaw.split(/[\s,]+/).filter(Boolean);
  return parts.some((u) => {
    const clean = decodeURIComponent(u.replace(/^["']|["']$/g, "")).replace(/\/+$/, "");
    return clean === normalizedTarget || clean === fileUriTarget;
  });
}

function discoverAntigravitySessions(absCwd: string): DiscoveredSession[] {
  const dbPath = join(homedir(), ".gemini", "antigravity-cli", "conversation_summaries.db");
  if (!existsSync(dbPath)) return [];

  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .query(
        `SELECT conversation_id, title, last_modified_time, workspace_uris
         FROM conversation_summaries
         WHERE parent_conversation_id = ''
           AND workspace_uris LIKE ?
         ORDER BY last_modified_time DESC
         LIMIT 25`
      )
      .all(`%${absCwd.replace(/\/+$/, "")}%`) as Array<{
      conversation_id: string;
      title: string;
      last_modified_time: string;
      workspace_uris: string;
    }>;

    const results: DiscoveredSession[] = [];
    for (const row of rows) {
      if (!workspaceMatches(row.workspace_uris, absCwd)) continue;
      const ms = Date.parse(row.last_modified_time) || 0;
      results.push({
        agent: "antigravity",
        sessionId: row.conversation_id,
        title: (row.title || "").trim().slice(0, 72) || `Antigravity ${row.conversation_id.slice(0, 8)}`,
        updatedAt: ms ? new Date(ms).toISOString() : row.last_modified_time,
        updatedAtMs: ms,
      });
      if (results.length >= 10) break;
    }
    return results;
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

export function discoverSessionsForFolder(cwd: string): DiscoveredSession[] {
  const absCwd = resolve(expandTilde(cwd.trim()));
  if (!existsSync(absCwd)) return [];

  const all = [...discoverClaudeSessions(absCwd), ...discoverAntigravitySessions(absCwd)];
  return all.sort((a, b) => b.updatedAtMs - a.updatedAtMs).slice(0, 12);
}
