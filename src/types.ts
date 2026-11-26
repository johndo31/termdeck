export type AgentKind = "claude" | "antigravity" | "codex" | "gemini" | "shell";

export type SessionStatus = "working" | "needs_input" | "idle" | "exited" | "dormant";

export interface SessionRecord {
  id: string;
  title: string;
  project: string;
  cwd: string;
  host: string; // "local" or SSH host / user@host
  agent: AgentKind;
  sessionUuid: string;
  externalSessionId?: string;
  customCommand?: string;
  customResumeCommand?: string;
  hasStarted: boolean;
  createdAt: string;
  lastActiveAt: string;
}

export interface SessionView extends SessionRecord {
  status: SessionStatus;
  statusDetail?: string;
  backend: "tmux" | "pty";
  gitBranch?: string;
  lastOutputAt?: number;
  exitCode?: number | null;
}

export interface AgentPreset {
  id: AgentKind;
  label: string;
  shortLabel: string;
  cliBinary: string;
  accent: string;
  buildStartCommand: (session: SessionRecord) => string;
  buildResumeCommand: (session: SessionRecord) => string;
}

export const AGENT_PRESETS: Record<AgentKind, AgentPreset> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    shortLabel: "Claude",
    cliBinary: "claude",
    accent: "#d97757",
    buildStartCommand: (s) => `claude --session-id ${shellQuote(s.sessionUuid)}`,
    buildResumeCommand: (s) => `claude --resume ${shellQuote(s.sessionUuid)}`,
  },
  antigravity: {
    id: "antigravity",
    label: "Antigravity",
    shortLabel: "Antigravity",
    cliBinary: "agy",
    accent: "#6c8cff",
    buildStartCommand: () => "agy",
    buildResumeCommand: (s) =>
      s.externalSessionId ? `agy --conversation ${shellQuote(s.externalSessionId)}` : "agy --continue",
  },
  codex: {
    id: "codex",
    label: "Codex CLI",
    shortLabel: "Codex",
    cliBinary: "codex",
    accent: "#10b981",
    buildStartCommand: () => "codex",
    buildResumeCommand: (s) =>
      s.externalSessionId ? `codex resume ${shellQuote(s.externalSessionId)}` : "codex resume --last",
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    shortLabel: "Gemini",
    cliBinary: "gemini",
    accent: "#38bdf8",
    buildStartCommand: () => "gemini",
    buildResumeCommand: () => "gemini --resume latest",
  },
  shell: {
    id: "shell",
    label: "Terminal",
    shortLabel: "Shell",
    cliBinary: "",
    accent: "#9ca3af",
    buildStartCommand: () => "",
    buildResumeCommand: () => "",
  },
};

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
