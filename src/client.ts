import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import type { AgentKind, SessionStatus, SessionView } from "./types";

declare global {
  interface Window {
    termdeckDesktop?: {
      isDesktop: boolean;
      isMac: boolean;
      setBadge: (count: number) => void;
      pickFolder: (defaultPath?: string) => Promise<string | null>;
      openExternal?: (url: string) => void;
      notify?: (payload: { sessionId: string; title: string; body: string; bounce?: boolean }) => void;
      onSelectSession?: (cb: (sessionId: string) => void) => void;
      onFontZoom?: (cb: (delta: number) => void) => void;
    };
  }
}

interface DiscoveredSession {
  agent: AgentKind;
  sessionId: string;
  title: string;
  updatedAt: string;
  updatedAtMs: number;
}

interface MetaResponse {
  homeDir: string;
  projects: Array<{ name: string; path: string }>;
  sshHosts: string[];
  binaries: Record<string, boolean>;
  localTmux: boolean;
}

interface MountedTerminal {
  sessionId: string;
  el: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  ws: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
}

const AGENT_META: Array<{ id: AgentKind; label: string; bin: string; color: string }> = [
  { id: "claude", label: "Claude", bin: "claude", color: "#d97757" },
  { id: "antigravity", label: "Antigravity", bin: "agy", color: "#6c8cff" },
  { id: "codex", label: "Codex", bin: "codex", color: "#10b981" },
  { id: "gemini", label: "Gemini", bin: "gemini", color: "#38bdf8" },
  { id: "shell", label: "Shell", bin: "", color: "#9ca3af" },
];

function agentIconSvg(agent: AgentKind, size = 15): string {
  switch (agent) {
    case "claude":
      return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none">
        <path d="M8 1.6L9.4 6.1L13.8 4.6L10.3 8L13.8 11.4L9.4 9.9L8 14.4L6.6 9.9L2.2 11.4L5.7 8L2.2 4.6L6.6 6.1L8 1.6Z" fill="#d97757"/>
      </svg>`;
    case "antigravity":
      return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none">
        <path d="M8 2L13.5 12.8C13.7 13.2 13.3 13.6 12.9 13.4L8 11.1L3.1 13.4C2.7 13.6 2.3 13.2 2.5 12.8L8 2Z" stroke="#6c8cff" stroke-width="1.45" stroke-linejoin="round" fill="rgba(108,140,255,0.2)"/>
        <circle cx="8" cy="7.8" r="1.4" fill="#a5b8ff"/>
      </svg>`;
    case "codex":
      return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none">
        <polygon points="8,1.7 13.4,4.8 13.4,11.2 8,14.3 2.6,11.2 2.6,4.8" stroke="#10b981" stroke-width="1.4" fill="rgba(16,185,129,0.16)"/>
        <path d="M6.2 6.4L8.8 8L6.2 9.6" stroke="#34d399" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
    case "gemini":
      return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none">
        <path d="M8 1.5C8.5 5.4 10.6 7.5 14.5 8C10.6 8.5 8.5 10.6 8 14.5C7.5 10.6 5.4 8.5 1.5 8C5.4 7.5 7.5 5.4 8 1.5Z" fill="#38bdf8"/>
      </svg>`;
    default:
      return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none">
        <path d="M3.2 5.2L6.6 8L3.2 10.8" stroke="#9ca3af" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M8.2 10.8H12.8" stroke="#9ca3af" stroke-width="1.5" stroke-linecap="round"/>
      </svg>`;
  }
}

const STORAGE_ACTIVE_KEY = "termdeck:activeSessionId";
const STORAGE_NOTIFY_KEY = "termdeck:notifyEnabled";
const STORAGE_NOTIFY_UNFOCUSED_KEY = "termdeck:notifyOnlyUnfocused";
const STORAGE_DOCK_BADGE_KEY = "termdeck:dockBadge";
const STORAGE_DOCK_BOUNCE_KEY = "termdeck:dockBounce";
const STORAGE_NOTIFY_DECISION_KEY = "termdeck:notifyOnDecision";
const STORAGE_NOTIFY_COMPLETE_KEY = "termdeck:notifyOnComplete";
const STORAGE_NOTIFY_EXIT_KEY = "termdeck:notifyOnExit";
const STORAGE_NOTIFY_BELL_KEY = "termdeck:notifyOnBell";
const STORAGE_FONT_SIZE_KEY = "termdeck:fontSize";
const STORAGE_UI_SIZE_KEY = "termdeck:uiFontSize";
const STORAGE_SIDEBAR_WIDTH_KEY = "termdeck:sidebarWidth";
const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
const DEFAULT_UI_SIZE = 14;
const DEFAULT_SIDEBAR_WIDTH = 248;

let meta: MetaResponse = {
  homeDir: "~",
  projects: [],
  sshHosts: [],
  binaries: {},
  localTmux: false,
};
let sessions: SessionView[] = [];
let activeSessionId: string | null = localStorage.getItem(STORAGE_ACTIVE_KEY);
let notifyEnabled = localStorage.getItem(STORAGE_NOTIFY_KEY) === "1";
let notifyOnlyUnfocused = localStorage.getItem(STORAGE_NOTIFY_UNFOCUSED_KEY) !== "0";
let dockBadgeEnabled = localStorage.getItem(STORAGE_DOCK_BADGE_KEY) !== "0";
let dockBounceEnabled = localStorage.getItem(STORAGE_DOCK_BOUNCE_KEY) !== "0";
let notifyOnDecision = localStorage.getItem(STORAGE_NOTIFY_DECISION_KEY) !== "0";
let notifyOnComplete = localStorage.getItem(STORAGE_NOTIFY_COMPLETE_KEY) === "1";
let notifyOnExit = localStorage.getItem(STORAGE_NOTIFY_EXIT_KEY) === "1";
let notifyOnBell = localStorage.getItem(STORAGE_NOTIFY_BELL_KEY) !== "0";
let termFontSize = Math.max(
  MIN_FONT_SIZE,
  Math.min(MAX_FONT_SIZE, Number(localStorage.getItem(STORAGE_FONT_SIZE_KEY)) || DEFAULT_FONT_SIZE)
);
let uiFontSize = Math.max(
  12,
  Math.min(18, Number(localStorage.getItem(STORAGE_UI_SIZE_KEY)) || DEFAULT_UI_SIZE)
);
let sidebarWidth = Math.max(
  180,
  Math.min(360, Number(localStorage.getItem(STORAGE_SIDEBAR_WIDTH_KEY)) || DEFAULT_SIDEBAR_WIDTH)
);
let selectedModalAgent: AgentKind = "claude";
let discoveredForCwd: DiscoveredSession[] = [];
let selectedDiscoveredId: string | null = null;
let discoverTimer: ReturnType<typeof setTimeout> | null = null;
const unreadSessionIds = new Set<string>();
const mounted = new Map<string, MountedTerminal>();

// DOM refs
const sidebarEl = document.getElementById("sidebar")!;
const sidebarBackdropEl = document.getElementById("sidebar-backdrop")!;
const mobileKeybarEl = document.getElementById("mobile-keybar")!;
const appEl = document.getElementById("app")!;
const attentionBarEl = document.getElementById("attention-bar")!;
const sessionListEl = document.getElementById("session-list")!;
const persistencePillEl = document.getElementById("persistence-pill")!;
const btnNotifyToggleEl = document.getElementById("btn-notify-toggle")!;
const btnSettingsEl = document.getElementById("btn-settings")!;
const sidebarResizerEl = document.getElementById("sidebar-resizer")!;
const settingsBackdropEl = document.getElementById("settings-backdrop")!;
const deleteBackdropEl = document.getElementById("delete-backdrop")!;
const deleteModalMessageEl = document.getElementById("delete-modal-message")!;
const btnDeleteConfirmEl = document.getElementById("btn-delete-confirm") as HTMLButtonElement;
const rangeUiSizeEl = document.getElementById("range-ui-size") as HTMLInputElement;
const valUiSizeEl = document.getElementById("val-ui-size")!;
const rangeTermSizeEl = document.getElementById("range-term-size") as HTMLInputElement;
const valTermSizeEl = document.getElementById("val-term-size")!;
const rangeSidebarWidthEl = document.getElementById("range-sidebar-width") as HTMLInputElement;
const valSidebarWidthEl = document.getElementById("val-sidebar-width")!;
const notifySubsettingsEl = document.getElementById("notify-subsettings")!;
const chkNotifyEnabledEl = document.getElementById("chk-notify-enabled") as HTMLInputElement;
const chkNotifyUnfocusedEl = document.getElementById("chk-notify-unfocused") as HTMLInputElement;
const chkDockBadgeEl = document.getElementById("chk-dock-badge") as HTMLInputElement;
const chkDockBounceEl = document.getElementById("chk-dock-bounce") as HTMLInputElement;
const chkNotifyDecisionEl = document.getElementById("chk-notify-decision") as HTMLInputElement;
const chkNotifyCompleteEl = document.getElementById("chk-notify-complete") as HTMLInputElement;
const chkNotifyExitEl = document.getElementById("chk-notify-exit") as HTMLInputElement;
const chkNotifyBellEl = document.getElementById("chk-notify-bell") as HTMLInputElement;
const chkRemoteAccessEl = document.getElementById("chk-remote-access") as HTMLInputElement;
const remoteSubsettingsEl = document.getElementById("remote-subsettings")!;
const remoteStatusBadgeEl = document.getElementById("remote-status-badge")!;
const inputRemotePortEl = document.getElementById("input-remote-port") as HTMLInputElement;
const btnRotateTokenEl = document.getElementById("btn-rotate-token") as HTMLButtonElement;
const remoteUrlsListEl = document.getElementById("remote-urls-list")!;
const remoteRestartNoteEl = document.getElementById("remote-restart-note")!;
const headerSessionInfoEl = document.getElementById("header-session-info")!;
const headerEmptyTitleEl = document.getElementById("header-empty-title")!;
const headerActionsEl = document.getElementById("header-actions")!;
const headerAgentIconEl = document.getElementById("header-agent-icon")!;
const headerTitleInputEl = document.getElementById("header-title-input") as HTMLInputElement;
const headerProjectEl = document.getElementById("header-project")!;
const headerBranchEl = document.getElementById("header-branch")!;
const headerHostEl = document.getElementById("header-host")!;
const headerStatusEl = document.getElementById("header-status")!;
const emptyStateEl = document.getElementById("empty-state")!;
const terminalsMountEl = document.getElementById("terminals-mount")!;

// Modal DOM refs
const modalBackdropEl = document.getElementById("modal-backdrop")!;
const agentGridEl = document.getElementById("agent-grid")!;
const newSessionFormEl = document.getElementById("new-session-form") as HTMLFormElement;
const inputHostEl = document.getElementById("input-host") as HTMLInputElement;
const hostOptionsEl = document.getElementById("host-options")!;
const inputTitleEl = document.getElementById("input-title") as HTMLInputElement;
const inputCwdEl = document.getElementById("input-cwd") as HTMLInputElement;
const btnPickFolderEl = document.getElementById("btn-pick-folder") as HTMLButtonElement;
const projectOptionsEl = document.getElementById("project-options")!;
const quickProjectsEl = document.getElementById("quick-projects")!;
const discoveredBoxEl = document.getElementById("discovered-box")!;
const discoveredListEl = document.getElementById("discovered-list")!;
const inputCustomCmdEl = document.getElementById("input-custom-cmd") as HTMLInputElement;
const inputCustomResumeEl = document.getElementById("input-custom-resume") as HTMLInputElement;

function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}

async function fetchMeta() {
  const res = await fetch("/api/meta");
  meta = (await res.json()) as MetaResponse;

  persistencePillEl.textContent = meta.localTmux
    ? "local: tmux · remote: ssh+tmux"
    : "local: pty+resume · remote: ssh+tmux";

  hostOptionsEl.innerHTML = ["local", ...meta.sshHosts]
    .map((h) => `<option value="${escapeAttr(h)}"></option>`)
    .join("");

  projectOptionsEl.innerHTML = meta.projects
    .map((p) => `<option value="${escapeAttr(p.path)}">${escapeHtml(p.name)}</option>`)
    .join("");

  renderQuickProjects();
  renderAgentPicker();
}

async function fetchSessions() {
  const res = await fetch("/api/sessions");
  const data = (await res.json()) as { sessions: SessionView[] };
  sessions = data.sessions;

  // Clean up terminals for deleted sessions
  const liveIds = new Set(sessions.map((s) => s.id));
  for (const [id] of mounted) {
    if (!liveIds.has(id)) disposeTerminal(id);
  }

  if (activeSessionId && !liveIds.has(activeSessionId)) {
    activeSessionId = sessions[0]?.id ?? null;
  } else if (!activeSessionId && sessions.length > 0) {
    activeSessionId = sessions[0].id;
  }

  renderSidebar();
  renderHeader();

  if (activeSessionId) {
    selectSession(activeSessionId);
  } else {
    emptyStateEl.classList.remove("hidden");
  }
}

function formatStatusLabel(status: SessionStatus, detail?: string): string {
  switch (status) {
    case "needs_input":
      return `◆ ${detail || "Needs decision"}`;
    case "working":
      return `● ${detail || "Working…"}`;
    case "idle":
      return "○ Ready";
    case "exited":
      return `◌ ${detail || "Exited"}`;
    case "dormant":
      return "◌ Dormant";
  }
}

function renderAttentionBar() {
  const needingDecision = sessions.filter((s) => s.status === "needs_input");
  const working = sessions.filter((s) => s.status === "working");

  if (needingDecision.length === 0 && working.length === 0) {
    attentionBarEl.classList.add("hidden");
    attentionBarEl.innerHTML = "";
    return;
  }

  attentionBarEl.classList.remove("hidden");
  attentionBarEl.innerHTML = "";

  if (needingDecision.length > 0) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "attention-chip decision";
    chip.textContent = `◆ ${needingDecision.length} needs decision`;
    chip.title = "Jump to session waiting for a decision";
    chip.addEventListener("click", () => {
      // Cycle through sessions needing decision
      const idx = needingDecision.findIndex((s) => s.id === activeSessionId);
      const next = needingDecision[(idx + 1) % needingDecision.length];
      selectSession(next.id);
    });
    attentionBarEl.appendChild(chip);
  }

  if (working.length > 0) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "attention-chip working";
    chip.textContent = `● ${working.length} working`;
    chip.title = "Jump to active session";
    chip.addEventListener("click", () => {
      const idx = working.findIndex((s) => s.id === activeSessionId);
      const next = working[(idx + 1) % working.length];
      selectSession(next.id);
    });
    attentionBarEl.appendChild(chip);
  }
}

function updateDocumentTitle() {
  const decisionIds = sessions.filter((s) => s.status === "needs_input").map((s) => s.id);
  const badgeCount = new Set([...decisionIds, ...unreadSessionIds]).size;
  const workingCount = sessions.filter((s) => s.status === "working").length;
  const prefix = badgeCount > 0 ? `(${badgeCount}!) ` : workingCount > 0 ? "● " : "";
  const s = sessions.find((x) => x.id === activeSessionId);
  document.title = s ? `${prefix}${s.title} · ${s.project} — termdeck` : `${prefix}termdeck`;
  window.termdeckDesktop?.setBadge(dockBadgeEnabled ? badgeCount : 0);
}

function renderSidebar() {
  renderAttentionBar();
  updateDocumentTitle();

  if (sessions.length === 0) {
    sessionListEl.innerHTML = `<div class="sidebar-empty">No sessions yet.<br/>Click <strong>New</strong> or press <strong>⌘K</strong>.</div>`;
    return;
  }

  // Group sessions by project name
  const groups = new Map<string, SessionView[]>();
  for (const s of sessions) {
    const list = groups.get(s.project) ?? [];
    list.push(s);
    groups.set(s.project, list);
  }

  const fragment = document.createDocumentFragment();
  for (const [project, items] of groups) {
    const groupEl = document.createElement("div");
    groupEl.className = "project-group";

    const groupHeader = document.createElement("div");
    groupHeader.className = "project-group-header";

    const label = document.createElement("span");
    label.textContent = project;

    const addBtn = document.createElement("button");
    addBtn.className = "project-group-add";
    addBtn.title = `New session in ${project}`;
    addBtn.textContent = "+";
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openModal({ cwd: items[0].cwd, host: items[0].host });
    });

    groupHeader.append(label, addBtn);
    groupEl.appendChild(groupHeader);

    for (const s of items) {
      const btn = document.createElement("button");
      const isSelected = s.id === activeSessionId;
      const needsInput = s.status === "needs_input";
      btn.className = `session-item${isSelected ? " selected" : ""}${needsInput ? " needs-input" : ""}`;
      btn.dataset.id = s.id;

      const hostBadge = s.host !== "local" ? `<span class="host-tag">${escapeHtml(s.host)}</span>` : "";
      const agentLabel = AGENT_META.find((a) => a.id === s.agent)?.label ?? s.agent;
      const subText =
        s.status === "needs_input"
          ? s.statusDetail || "Needs decision"
          : s.status === "working"
            ? s.statusDetail || "Working…"
            : agentLabel;

      const rightIndicator =
        s.status === "needs_input"
          ? `<span class="session-badge needs_input" title="${escapeAttr(s.statusDetail || "Needs decision")}">Decision</span>`
          : s.status === "working"
            ? `<span class="status-dot working" title="${escapeAttr(s.statusDetail || "Working…")}"></span>`
            : `<span class="status-dot ${s.status}" title="${escapeAttr(s.status)}"></span>`;

      btn.innerHTML = `
        <span class="session-icon">${agentIconSvg(s.agent, 15)}</span>
        <span class="session-meta">
          <span class="session-title">${escapeHtml(s.title)}</span>
          <span class="session-sub">
            <span>${escapeHtml(subText)}</span>
            ${hostBadge}
          </span>
        </span>
        <span class="session-indicator">${rightIndicator}</span>
      `;
      btn.addEventListener("click", () => selectSession(s.id));
      groupEl.appendChild(btn);
    }

    fragment.appendChild(groupEl);
  }

  sessionListEl.innerHTML = "";
  sessionListEl.appendChild(fragment);
}

function renderHeader() {
  const s = sessions.find((x) => x.id === activeSessionId);
  if (!s) {
    headerSessionInfoEl.classList.add("hidden");
    headerActionsEl.classList.add("hidden");
    headerEmptyTitleEl.classList.remove("hidden");
    updateDocumentTitle();
    return;
  }

  headerEmptyTitleEl.classList.add("hidden");
  headerSessionInfoEl.classList.remove("hidden");
  headerActionsEl.classList.remove("hidden");

  headerAgentIconEl.innerHTML = agentIconSvg(s.agent, 14);
  if (document.activeElement !== headerTitleInputEl) {
    headerTitleInputEl.value = s.title;
  }
  headerProjectEl.textContent = s.project;
  headerProjectEl.title = s.cwd;

  if (s.gitBranch) {
    headerBranchEl.textContent = s.gitBranch;
    headerBranchEl.classList.remove("hidden");
  } else {
    headerBranchEl.classList.add("hidden");
  }

  headerHostEl.textContent = s.host === "local" ? `local · ${s.backend}` : `ssh: ${s.host}`;
  headerStatusEl.className = `pill pill-status ${s.status}`;
  headerStatusEl.textContent = formatStatusLabel(s.status, s.statusDetail);
  updateDocumentTitle();
}

function selectSession(id: string) {
  activeSessionId = id;
  unreadSessionIds.delete(id);
  localStorage.setItem(STORAGE_ACTIVE_KEY, id);
  emptyStateEl.classList.add("hidden");

  // Auto-close slide-over sidebar drawer on mobile after picking a session
  if (window.innerWidth <= 720) {
    sidebarEl.classList.add("collapsed");
    sidebarBackdropEl.classList.add("hidden");
  }

  for (const [sid, m] of mounted) {
    m.el.classList.toggle("active", sid === id);
  }

  let m = mounted.get(id);
  if (!m) {
    m = mountTerminal(id);
  } else {
    m.el.classList.add("active");
  }

  renderSidebar();
  renderHeader();

  requestAnimationFrame(() => {
    fitAndSync(m!);
    m!.term.focus();
  });
}

function openExternalLink(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return;
  if (window.termdeckDesktop?.openExternal) {
    window.termdeckDesktop.openExternal(trimmed);
  } else if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("mailto:")) {
    window.open(trimmed, "_blank", "noopener,noreferrer");
  }
}

function mountTerminal(sessionId: string): MountedTerminal {
  const pane = document.createElement("div");
  pane.className = "term-pane active";
  terminalsMountEl.appendChild(pane);

  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: "bar",
    fontSize: termFontSize,
    lineHeight: 1.28,
    fontFamily: '"JetBrains Mono", "SF Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
    scrollback: 10000,
    linkHandler: {
      allowNonHttpProtocols: true,
      activate(_event, text) {
        openExternalLink(text);
      },
    },
    theme: {
      background: "#0b0d11",
      foreground: "#e6ebf4",
      cursor: "#6c8cff",
      cursorAccent: "#0b0d11",
      selectionBackground: "rgba(108, 140, 255, 0.28)",
      black: "#181c24",
      red: "#f87171",
      green: "#34d399",
      yellow: "#fbbf24",
      blue: "#60a5fa",
      magenta: "#c084fc",
      cyan: "#38bdf8",
      white: "#e6ebf4",
      brightBlack: "#5c6577",
      brightRed: "#fca5a5",
      brightGreen: "#6ee7b7",
      brightYellow: "#fcd34d",
      brightBlue: "#93c5fd",
      brightMagenta: "#d8b4fe",
      brightCyan: "#7dd3fc",
      brightWhite: "#ffffff",
    },
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_event, uri) => openExternalLink(uri)));
  term.open(pane);
  try {
    fit.fit();
  } catch {
    // ignore if container not yet laid out
  }

  const entry: MountedTerminal = {
    sessionId,
    el: pane,
    term,
    fit,
    ws: null,
    reconnectTimer: null,
    disposed: false,
  };

  term.onData((data) => {
    if (entry.ws?.readyState === WebSocket.OPEN) {
      entry.ws.send(JSON.stringify({ type: "input", data }));
    }
  });

  mounted.set(sessionId, entry);
  connectTerminalWs(entry);
  return entry;
}

function connectTerminalWs(entry: MountedTerminal) {
  if (entry.disposed) return;
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }

  const ws = new WebSocket(wsUrl(`/ws/term/${encodeURIComponent(entry.sessionId)}`));
  entry.ws = ws;
  let isInitialReplay = true;

  ws.addEventListener("open", () => {
    fitAndSync(entry);
  });

  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      const msg = JSON.parse(ev.data) as
        | { type: "data"; data: string }
        | { type: "clear" }
        | {
            type: "status";
            status: SessionStatus;
            statusDetail?: string;
            backend?: "tmux" | "pty";
            exitCode?: number | null;
          };

      if (msg.type === "data") {
        if (isInitialReplay) {
          isInitialReplay = false;
          entry.term.write(msg.data, () => {
            entry.term.scrollToBottom();
          });
        } else {
          entry.term.write(msg.data);
        }
      } else if (msg.type === "clear") {
        entry.term.reset();
      } else if (msg.type === "status") {
        updateSessionStatus(entry.sessionId, msg.status, msg.statusDetail, msg.backend);
      }
    } catch {
      // ignore
    }
  });

  ws.addEventListener("close", (ev) => {
    if (entry.disposed || ev.code === 1000 || ev.code === 1008) return;
    entry.reconnectTimer = setTimeout(() => connectTerminalWs(entry), 1500);
  });
}

function disposeTerminal(sessionId: string) {
  const entry = mounted.get(sessionId);
  if (!entry) return;
  entry.disposed = true;
  if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
  try {
    entry.ws?.close(1000);
  } catch {
    // ignore
  }
  entry.term.dispose();
  entry.el.remove();
  mounted.delete(sessionId);
}

function fitAndSync(entry: MountedTerminal) {
  if (!entry.el.classList.contains("active")) return;
  try {
    const buf = entry.term.buffer.active;
    const wasNearBottom = buf.baseY - buf.viewportY <= 2;
    entry.fit.fit();
    const { cols, rows } = entry.term;
    if (cols > 0 && rows > 0 && entry.ws?.readyState === WebSocket.OPEN) {
      entry.ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
    if (wasNearBottom) {
      entry.term.scrollToBottom();
    }
  } catch {
    // ignore if container hidden
  }
}

function maybeNotifyDecision(session: SessionView, detail?: string) {
  if (!notifyEnabled) return;
  const appFocused = document.hasFocus() && document.visibilityState === "visible";
  if (notifyOnlyUnfocused && appFocused) return;
  if (appFocused && session.id === activeSessionId) return;

  unreadSessionIds.add(session.id);
  updateDocumentTitle();

  const title = `${session.title} (${session.project})`;
  const body = detail || "Waiting for your decision";

  if (window.termdeckDesktop?.notify) {
    window.termdeckDesktop.notify({ sessionId: session.id, title, body, bounce: dockBounceEnabled });
    return;
  }

  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const n = new Notification(title, {
    body,
    tag: `termdeck-${session.id}`,
  });
  n.onclick = () => {
    window.focus();
    selectSession(session.id);
    n.close();
  };
}

function updateSessionRowInPlace(s: SessionView): boolean {
  const btn = sessionListEl.querySelector<HTMLButtonElement>(`.session-item[data-id="${CSS.escape(s.id)}"]`);
  if (!btn) return false;

  const isSelected = s.id === activeSessionId;
  const needsInput = s.status === "needs_input";
  btn.className = `session-item${isSelected ? " selected" : ""}${needsInput ? " needs-input" : ""}`;

  const hostBadge = s.host !== "local" ? `<span class="host-tag">${escapeHtml(s.host)}</span>` : "";
  const agentLabel = AGENT_META.find((a) => a.id === s.agent)?.label ?? s.agent;
  const subText =
    s.status === "needs_input"
      ? s.statusDetail || "Needs decision"
      : s.status === "working"
        ? s.statusDetail || "Working…"
        : agentLabel;

  const subEl = btn.querySelector(".session-sub");
  if (subEl) {
    subEl.innerHTML = `<span>${escapeHtml(subText)}</span>${hostBadge}`;
  }

  const rightEl = btn.querySelector(".session-indicator");
  if (rightEl) {
    rightEl.innerHTML =
      s.status === "needs_input"
        ? `<span class="session-badge needs_input" title="${escapeAttr(s.statusDetail || "Needs decision")}">Decision</span>`
        : s.status === "working"
          ? `<span class="status-dot working" title="${escapeAttr(s.statusDetail || "Working…")}"></span>`
          : `<span class="status-dot ${s.status}" title="${escapeAttr(s.status)}"></span>`;
  }

  return true;
}

function updateSessionStatus(
  sessionId: string,
  status: SessionStatus,
  statusDetail?: string,
  backend?: "tmux" | "pty"
) {
  const s = sessions.find((x) => x.id === sessionId);
  if (!s) return;
  const prevStatus = s.status;
  s.status = status;
  s.statusDetail = statusDetail;
  if (backend) s.backend = backend;

  if (notifyOnDecision && status === "needs_input" && prevStatus !== "needs_input") {
    maybeNotifyDecision(s, statusDetail);
  } else if (notifyOnComplete && status === "idle" && prevStatus === "working" && s.agent !== "shell") {
    maybeNotifyDecision(s, "Finished turn");
  } else if (notifyOnExit && status === "exited" && prevStatus !== "exited") {
    maybeNotifyDecision(s, statusDetail || "Session exited");
  }

  if (!updateSessionRowInPlace(s)) {
    renderSidebar();
  } else {
    renderAttentionBar();
    updateDocumentTitle();
  }
  if (sessionId === activeSessionId) renderHeader();
}

// Global events WebSocket (status updates across all tabs + bells)
function connectEventsWs() {
  const ws = new WebSocket(wsUrl("/ws/events"));
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      const msg = JSON.parse(ev.data) as {
        type: string;
        sessionId?: string;
        status?: SessionStatus;
        statusDetail?: string;
        backend?: "tmux" | "pty";
      };
      if (msg.type === "sessions_changed") {
        void fetchSessions();
      } else if (msg.type === "status" && msg.sessionId && msg.status) {
        updateSessionStatus(msg.sessionId, msg.status, msg.statusDetail, msg.backend);
      } else if (msg.type === "bell" && msg.sessionId) {
        const s = sessions.find((x) => x.id === msg.sessionId);
        if (s && notifyOnBell) {
          maybeNotifyDecision(s, msg.statusDetail || "Terminal bell");
        }
      }
    } catch {
      // ignore
    }
  });
  ws.addEventListener("close", () => {
    setTimeout(connectEventsWs, 2000);
  });
}

function formatRelativeTime(ms: number): string {
  if (!ms) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return "just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function renderDiscoveredSessions() {
  if (discoveredForCwd.length === 0) {
    discoveredBoxEl.classList.add("hidden");
    discoveredListEl.innerHTML = "";
    return;
  }

  discoveredBoxEl.classList.remove("hidden");
  discoveredListEl.innerHTML = "";

  for (const item of discoveredForCwd) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `discovered-item${selectedDiscoveredId === item.sessionId ? " selected" : ""}`;
    btn.innerHTML = `
      <span class="session-icon">${agentIconSvg(item.agent, 14)}</span>
      <span class="discovered-item-title">${escapeHtml(item.title)}</span>
      <span class="discovered-item-time">${escapeHtml(formatRelativeTime(item.updatedAtMs))}</span>
    `;
    btn.addEventListener("click", () => {
      selectedDiscoveredId = item.sessionId;
      selectedModalAgent = item.agent;
      renderAgentPicker();
      renderDiscoveredSessions();
    });
    discoveredListEl.appendChild(btn);
  }

  const freshBtn = document.createElement("button");
  freshBtn.type = "button";
  freshBtn.className = `discovered-item${selectedDiscoveredId === null ? " selected" : ""}`;
  freshBtn.innerHTML = `
    <span class="session-icon">+</span>
    <span class="discovered-item-title">Start a fresh session instead</span>
  `;
  freshBtn.addEventListener("click", () => {
    selectedDiscoveredId = null;
    renderDiscoveredSessions();
  });
  discoveredListEl.appendChild(freshBtn);
}

async function discoverForCurrentModalCwd() {
  const host = (inputHostEl.value.trim() || "local").toLowerCase();
  const cwd = inputCwdEl.value.trim();
  if (host !== "local" || !cwd) {
    discoveredForCwd = [];
    selectedDiscoveredId = null;
    renderDiscoveredSessions();
    return;
  }

  try {
    const res = await fetch(`/api/discover?cwd=${encodeURIComponent(cwd)}`);
    const data = (await res.json()) as { sessions: DiscoveredSession[] };
    discoveredForCwd = data.sessions || [];
    if (discoveredForCwd.length > 0) {
      // Auto-pick the most recently used agent + conversation in this folder
      selectedDiscoveredId = discoveredForCwd[0].sessionId;
      selectedModalAgent = discoveredForCwd[0].agent;
      renderAgentPicker();
    } else {
      selectedDiscoveredId = null;
    }
    renderDiscoveredSessions();
  } catch {
    discoveredForCwd = [];
    selectedDiscoveredId = null;
    renderDiscoveredSessions();
  }
}

function scheduleDiscoverForModal() {
  if (discoverTimer) clearTimeout(discoverTimer);
  discoverTimer = setTimeout(() => void discoverForCurrentModalCwd(), 140);
}

// Modal logic
function renderAgentPicker() {
  agentGridEl.innerHTML = "";
  for (const agent of AGENT_META) {
    const installed = !agent.bin || meta.binaries[agent.bin];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `agent-card${selectedModalAgent === agent.id ? " selected" : ""}`;
    btn.innerHTML = `
      ${agentIconSvg(agent.id, 18)}
      <span>${escapeHtml(agent.label)}</span>
      <span class="installed-dot">${installed ? "ready" : "remote/custom"}</span>
    `;
    btn.addEventListener("click", () => {
      selectedModalAgent = agent.id;
      const matching = discoveredForCwd.find((d) => d.agent === agent.id);
      selectedDiscoveredId = matching ? matching.sessionId : null;
      renderAgentPicker();
      renderDiscoveredSessions();
    });
    agentGridEl.appendChild(btn);
  }
}

function renderQuickProjects() {
  quickProjectsEl.innerHTML = "";
  for (const proj of meta.projects.slice(0, 14)) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "quick-chip";
    chip.textContent = proj.name;
    chip.title = proj.path;
    chip.addEventListener("click", () => {
      inputCwdEl.value = proj.path;
      inputHostEl.value = "local";
      void discoverForCurrentModalCwd();
    });
    quickProjectsEl.appendChild(chip);
  }
}

function openModal(prefill?: { cwd?: string; host?: string; agent?: AgentKind }) {
  if (prefill?.agent) selectedModalAgent = prefill.agent;
  renderAgentPicker();
  inputHostEl.value = prefill?.host || "local";
  inputCwdEl.value = prefill?.cwd || meta.projects[0]?.path || meta.homeDir;
  inputTitleEl.value = "";
  inputCustomCmdEl.value = "";
  inputCustomResumeEl.value = "";
  discoveredForCwd = [];
  selectedDiscoveredId = null;
  renderDiscoveredSessions();
  modalBackdropEl.classList.remove("hidden");
  inputCwdEl.focus();
  inputCwdEl.select();
  void discoverForCurrentModalCwd();
}

function closeModal() {
  modalBackdropEl.classList.add("hidden");
  if (activeSessionId) {
    mounted.get(activeSessionId)?.term.focus();
  }
}

// Event bindings
document.getElementById("btn-new-session")!.addEventListener("click", () => openModal());
document.getElementById("btn-empty-new")!.addEventListener("click", () => openModal());
document.getElementById("btn-modal-close")!.addEventListener("click", closeModal);
document.getElementById("btn-modal-cancel")!.addEventListener("click", closeModal);

modalBackdropEl.addEventListener("click", (e) => {
  if (e.target === modalBackdropEl) closeModal();
});

inputCwdEl.addEventListener("input", scheduleDiscoverForModal);
inputCwdEl.addEventListener("change", () => void discoverForCurrentModalCwd());
inputHostEl.addEventListener("input", scheduleDiscoverForModal);

if (window.termdeckDesktop?.pickFolder) {
  btnPickFolderEl.classList.remove("hidden");
  btnPickFolderEl.addEventListener("click", async () => {
    const picked = await window.termdeckDesktop!.pickFolder(inputCwdEl.value.trim());
    if (picked) {
      inputCwdEl.value = picked;
      inputHostEl.value = "local";
      void discoverForCurrentModalCwd();
    }
  });
}

newSessionFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const chosenDiscovered = selectedDiscoveredId
    ? discoveredForCwd.find((d) => d.sessionId === selectedDiscoveredId)
    : undefined;
  const payload = {
    agent: selectedModalAgent,
    host: inputHostEl.value.trim() || "local",
    cwd: inputCwdEl.value.trim() || meta.homeDir,
    title: inputTitleEl.value.trim() || chosenDiscovered?.title || undefined,
    resumeSessionId: chosenDiscovered?.sessionId || undefined,
    customCommand: inputCustomCmdEl.value.trim() || undefined,
    customResumeCommand: inputCustomResumeEl.value.trim() || undefined,
  };
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as { session: SessionView };
  closeModal();
  sessions.unshift(data.session);
  selectSession(data.session.id);
});

function syncSidebarBackdrop() {
  const isMobile = window.innerWidth <= 720;
  const isOpen = !sidebarEl.classList.contains("collapsed");
  sidebarBackdropEl.classList.toggle("hidden", !(isMobile && isOpen));
}

document.getElementById("btn-toggle-sidebar")!.addEventListener("click", () => {
  sidebarEl.classList.toggle("collapsed");
  syncSidebarBackdrop();
  setTimeout(() => {
    if (activeSessionId) {
      const m = mounted.get(activeSessionId);
      if (m) fitAndSync(m);
    }
  }, 160);
});

sidebarBackdropEl.addEventListener("click", () => {
  sidebarEl.classList.add("collapsed");
  syncSidebarBackdrop();
});

// Mobile quick-key bar (prevent stealing focus so phone keyboard stays open)
mobileKeybarEl.addEventListener("mousedown", (e) => e.preventDefault());
mobileKeybarEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".mkey");
  if (!btn || !activeSessionId) return;
  const entry = mounted.get(activeSessionId);
  if (!entry) return;
  if (btn.dataset.action === "bottom") {
    entry.term.scrollToBottom();
    entry.term.focus();
    return;
  }
  const seq = btn.dataset.seq;
  if (seq && entry.ws?.readyState === WebSocket.OPEN) {
    entry.ws.send(JSON.stringify({ type: "input", data: seq }));
  }
  entry.term.focus();
});

// Adapt height cleanly when iOS/Android on-screen keyboard opens
if (window.visualViewport) {
  const syncVisualViewport = () => {
    if (window.innerWidth <= 720 && window.visualViewport) {
      appEl.style.height = `${Math.round(window.visualViewport.height)}px`;
    } else {
      appEl.style.height = "";
    }
    if (activeSessionId) {
      const m = mounted.get(activeSessionId);
      if (m) fitAndSync(m);
    }
  };
  window.visualViewport.addEventListener("resize", syncVisualViewport);
}

async function commitTitleRename() {
  if (!activeSessionId) return;
  const next = headerTitleInputEl.value.trim();
  if (!next) return;
  const s = sessions.find((x) => x.id === activeSessionId);
  if (!s || s.title === next) return;
  s.title = next;
  renderSidebar();
  await fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: next }),
  });
}

headerTitleInputEl.addEventListener("blur", () => void commitTitleRename());
headerTitleInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    headerTitleInputEl.blur();
    if (activeSessionId) mounted.get(activeSessionId)?.term.focus();
  }
});

document.getElementById("btn-spawn-shell")!.addEventListener("click", async () => {
  const current = sessions.find((x) => x.id === activeSessionId);
  if (!current) return;
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent: "shell",
      host: current.host,
      cwd: current.cwd,
      title: `${current.project} shell`,
    }),
  });
  const data = (await res.json()) as { session: SessionView };
  sessions.unshift(data.session);
  selectSession(data.session.id);
});

document.getElementById("btn-resume")!.addEventListener("click", async () => {
  if (!activeSessionId) return;
  await fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fresh: false }),
  });
  mounted.get(activeSessionId)?.term.focus();
});

let pendingDeleteId: string | null = null;

function openDeleteModal(sessionId: string) {
  const s = sessions.find((x) => x.id === sessionId);
  if (!s) return;
  pendingDeleteId = sessionId;
  deleteModalMessageEl.textContent = `Remove "${s.title}" (${s.project})?`;
  deleteBackdropEl.classList.remove("hidden");
  btnDeleteConfirmEl.focus();
}

function closeDeleteModal() {
  pendingDeleteId = null;
  deleteBackdropEl.classList.add("hidden");
  if (activeSessionId) {
    mounted.get(activeSessionId)?.term.focus();
  }
}

async function performDeleteSession(id: string) {
  unreadSessionIds.delete(id);
  disposeTerminal(id);
  await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  sessions = sessions.filter((s) => s.id !== id);
  activeSessionId = sessions[0]?.id ?? null;
  if (activeSessionId) {
    selectSession(activeSessionId);
  } else {
    localStorage.removeItem(STORAGE_ACTIVE_KEY);
    renderSidebar();
    renderHeader();
    emptyStateEl.classList.remove("hidden");
  }
}

document.getElementById("btn-delete")!.addEventListener("click", () => {
  if (!activeSessionId) return;
  openDeleteModal(activeSessionId);
});

document.getElementById("btn-delete-close")!.addEventListener("click", closeDeleteModal);
document.getElementById("btn-delete-cancel")!.addEventListener("click", closeDeleteModal);
deleteBackdropEl.addEventListener("click", (e) => {
  if (e.target === deleteBackdropEl) closeDeleteModal();
});
btnDeleteConfirmEl.addEventListener("click", async () => {
  const id = pendingDeleteId;
  closeDeleteModal();
  if (id) {
    await performDeleteSession(id);
  }
});

// Resize observer for terminal stage
const ro = new ResizeObserver(() => {
  if (!activeSessionId) return;
  const m = mounted.get(activeSessionId);
  if (m) fitAndSync(m);
});
ro.observe(terminalsMountEl);

function applyAppearance() {
  document.documentElement.style.setProperty("--ui-font-size", `${uiFontSize}px`);
  document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  rangeUiSizeEl.value = String(uiFontSize);
  valUiSizeEl.textContent = `${uiFontSize}px`;
  rangeTermSizeEl.value = String(termFontSize);
  valTermSizeEl.textContent = `${termFontSize}px`;
  rangeSidebarWidthEl.value = String(sidebarWidth);
  valSidebarWidthEl.textContent = `${sidebarWidth}px`;
  chkNotifyEnabledEl.checked = notifyEnabled;
  chkNotifyUnfocusedEl.checked = notifyOnlyUnfocused;
  chkDockBadgeEl.checked = dockBadgeEnabled;
  chkDockBounceEl.checked = dockBounceEnabled;
  chkNotifyDecisionEl.checked = notifyOnDecision;
  chkNotifyCompleteEl.checked = notifyOnComplete;
  chkNotifyExitEl.checked = notifyOnExit;
  chkNotifyBellEl.checked = notifyOnBell;
  notifySubsettingsEl.classList.toggle("disabled", !notifyEnabled);
}

function setTerminalFontSize(nextSize: number) {
  const clamped = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(nextSize)));
  if (clamped === termFontSize) return;
  termFontSize = clamped;
  localStorage.setItem(STORAGE_FONT_SIZE_KEY, String(termFontSize));
  applyAppearance();
  for (const m of mounted.values()) {
    m.term.options.fontSize = termFontSize;
  }
  if (activeSessionId) {
    const active = mounted.get(activeSessionId);
    if (active) {
      requestAnimationFrame(() => fitAndSync(active));
    }
  }
}

function adjustTerminalFontSize(delta: number) {
  setTerminalFontSize(delta === 0 ? DEFAULT_FONT_SIZE : termFontSize + delta);
}

interface RemoteConfigResponse {
  remoteAccess: boolean;
  remotePort: number;
  authToken: string;
  activeHost: string;
  activePort: number;
  activeRemote: boolean;
  needsRestart: boolean;
  urls: Array<{ iface: string; address: string; kind: "vpn" | "lan"; url: string }>;
}

function renderRemoteConfig(cfg: RemoteConfigResponse) {
  chkRemoteAccessEl.checked = cfg.remoteAccess;
  inputRemotePortEl.value = String(cfg.remotePort);
  remoteSubsettingsEl.classList.toggle("disabled", !cfg.remoteAccess);
  remoteStatusBadgeEl.textContent = cfg.activeRemote ? `Listening :${cfg.activePort}` : "Local only";
  remoteStatusBadgeEl.classList.toggle("active", cfg.activeRemote);
  remoteRestartNoteEl.classList.toggle("hidden", !cfg.needsRestart);

  remoteUrlsListEl.innerHTML = "";
  if (!cfg.remoteAccess) return;

  if (cfg.urls.length === 0) {
    remoteUrlsListEl.innerHTML = `<div class="muted" style="font-size:11.5px;">No VPN or LAN interfaces detected.</div>`;
    return;
  }

  for (const item of cfg.urls) {
    const row = document.createElement("div");
    row.className = "remote-url-row";
    row.innerHTML = `
      <span class="remote-url-kind ${item.kind}">${item.kind === "vpn" ? "VPN" : "LAN"}</span>
      <span class="remote-url-text" title="${escapeAttr(item.url)}">${escapeHtml(item.url)}</span>
      <button type="button" class="remote-copy-btn">Copy</button>
    `;
    const copyBtn = row.querySelector<HTMLButtonElement>(".remote-copy-btn")!;
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(item.url);
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
          copyBtn.textContent = "Copy";
        }, 1400);
      } catch {
        // ignore clipboard failure
      }
    });
    remoteUrlsListEl.appendChild(row);
  }
}

async function fetchRemoteConfig() {
  try {
    const res = await fetch("/api/remote-config");
    if (!res.ok) return;
    renderRemoteConfig((await res.json()) as RemoteConfigResponse);
  } catch {
    // ignore
  }
}

async function patchRemoteConfig(body: { remoteAccess?: boolean; remotePort?: number; regenerateToken?: boolean }) {
  try {
    const res = await fetch("/api/remote-config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return;
    renderRemoteConfig((await res.json()) as RemoteConfigResponse);
  } catch {
    // ignore
  }
}

chkRemoteAccessEl.addEventListener("change", () => {
  void patchRemoteConfig({ remoteAccess: chkRemoteAccessEl.checked });
});

inputRemotePortEl.addEventListener("change", () => {
  const port = Number(inputRemotePortEl.value);
  if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
    void patchRemoteConfig({ remotePort: port });
  }
});

btnRotateTokenEl.addEventListener("click", () => {
  void patchRemoteConfig({ regenerateToken: true });
});

function openSettingsModal() {
  applyAppearance();
  void fetchRemoteConfig();
  settingsBackdropEl.classList.remove("hidden");
}

function closeSettingsModal() {
  settingsBackdropEl.classList.add("hidden");
  if (activeSessionId) {
    mounted.get(activeSessionId)?.term.focus();
  }
}

btnSettingsEl.addEventListener("click", openSettingsModal);
document.getElementById("btn-settings-close")!.addEventListener("click", closeSettingsModal);
document.getElementById("btn-settings-done")!.addEventListener("click", closeSettingsModal);
settingsBackdropEl.addEventListener("click", (e) => {
  if (e.target === settingsBackdropEl) closeSettingsModal();
});

rangeUiSizeEl.addEventListener("input", () => {
  uiFontSize = Math.max(12, Math.min(18, Number(rangeUiSizeEl.value) || DEFAULT_UI_SIZE));
  localStorage.setItem(STORAGE_UI_SIZE_KEY, String(uiFontSize));
  applyAppearance();
});

rangeTermSizeEl.addEventListener("input", () => {
  setTerminalFontSize(Number(rangeTermSizeEl.value) || DEFAULT_FONT_SIZE);
});

rangeSidebarWidthEl.addEventListener("input", () => {
  sidebarWidth = Math.max(180, Math.min(360, Number(rangeSidebarWidthEl.value) || DEFAULT_SIDEBAR_WIDTH));
  localStorage.setItem(STORAGE_SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  applyAppearance();
});

async function setNotificationsEnabled(next: boolean, sendConfirmation = false) {
  if (window.termdeckDesktop?.notify) {
    notifyEnabled = next;
    localStorage.setItem(STORAGE_NOTIFY_KEY, notifyEnabled ? "1" : "0");
    syncNotifyBtn();
    applyAppearance();
    if (notifyEnabled && sendConfirmation) {
      window.termdeckDesktop.notify({
        sessionId: activeSessionId || "",
        title: "termdeck notifications enabled",
        body: "Alerts will fire for your selected events.",
      });
    }
    return;
  }

  if (!("Notification" in window)) return;
  if (!next) {
    notifyEnabled = false;
    localStorage.setItem(STORAGE_NOTIFY_KEY, "0");
    syncNotifyBtn();
    applyAppearance();
    return;
  }
  const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  notifyEnabled = perm === "granted";
  localStorage.setItem(STORAGE_NOTIFY_KEY, notifyEnabled ? "1" : "0");
  syncNotifyBtn();
  applyAppearance();
}

chkNotifyEnabledEl.addEventListener("change", () => {
  void setNotificationsEnabled(chkNotifyEnabledEl.checked, false);
});

chkNotifyUnfocusedEl.addEventListener("change", () => {
  notifyOnlyUnfocused = chkNotifyUnfocusedEl.checked;
  localStorage.setItem(STORAGE_NOTIFY_UNFOCUSED_KEY, notifyOnlyUnfocused ? "1" : "0");
});

chkDockBadgeEl.addEventListener("change", () => {
  dockBadgeEnabled = chkDockBadgeEl.checked;
  localStorage.setItem(STORAGE_DOCK_BADGE_KEY, dockBadgeEnabled ? "1" : "0");
  updateDocumentTitle();
});

chkDockBounceEl.addEventListener("change", () => {
  dockBounceEnabled = chkDockBounceEl.checked;
  localStorage.setItem(STORAGE_DOCK_BOUNCE_KEY, dockBounceEnabled ? "1" : "0");
});

chkNotifyDecisionEl.addEventListener("change", () => {
  notifyOnDecision = chkNotifyDecisionEl.checked;
  localStorage.setItem(STORAGE_NOTIFY_DECISION_KEY, notifyOnDecision ? "1" : "0");
});

chkNotifyCompleteEl.addEventListener("change", () => {
  notifyOnComplete = chkNotifyCompleteEl.checked;
  localStorage.setItem(STORAGE_NOTIFY_COMPLETE_KEY, notifyOnComplete ? "1" : "0");
});

chkNotifyExitEl.addEventListener("change", () => {
  notifyOnExit = chkNotifyExitEl.checked;
  localStorage.setItem(STORAGE_NOTIFY_EXIT_KEY, notifyOnExit ? "1" : "0");
});

chkNotifyBellEl.addEventListener("change", () => {
  notifyOnBell = chkNotifyBellEl.checked;
  localStorage.setItem(STORAGE_NOTIFY_BELL_KEY, notifyOnBell ? "1" : "0");
});

document.getElementById("btn-notify-test")!.addEventListener("click", () => {
  if (window.termdeckDesktop?.notify) {
    if (dockBadgeEnabled) {
      window.termdeckDesktop.setBadge(1);
      setTimeout(() => updateDocumentTitle(), 3500);
    }
    window.termdeckDesktop.notify({
      sessionId: activeSessionId || "",
      title: "termdeck test notification",
      body: "Notifications are working.",
      bounce: dockBounceEnabled,
    });
  } else if ("Notification" in window && Notification.permission === "granted") {
    new Notification("termdeck test notification", { body: "Notifications are working." });
  }
});

document.getElementById("btn-settings-reset")!.addEventListener("click", () => {
  uiFontSize = DEFAULT_UI_SIZE;
  sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
  notifyOnlyUnfocused = true;
  dockBadgeEnabled = true;
  dockBounceEnabled = true;
  notifyOnDecision = true;
  notifyOnComplete = false;
  notifyOnExit = false;
  notifyOnBell = true;
  localStorage.setItem(STORAGE_UI_SIZE_KEY, String(uiFontSize));
  localStorage.setItem(STORAGE_SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  localStorage.setItem(STORAGE_NOTIFY_UNFOCUSED_KEY, "1");
  localStorage.setItem(STORAGE_DOCK_BADGE_KEY, "1");
  localStorage.setItem(STORAGE_DOCK_BOUNCE_KEY, "1");
  localStorage.setItem(STORAGE_NOTIFY_DECISION_KEY, "1");
  localStorage.setItem(STORAGE_NOTIFY_COMPLETE_KEY, "0");
  localStorage.setItem(STORAGE_NOTIFY_EXIT_KEY, "0");
  localStorage.setItem(STORAGE_NOTIFY_BELL_KEY, "1");
  setTerminalFontSize(DEFAULT_FONT_SIZE);
  applyAppearance();
  updateDocumentTitle();
});

// Drag-to-resize sidebar handle
sidebarResizerEl.addEventListener("mousedown", (e) => {
  e.preventDefault();
  sidebarEl.classList.add("resizing");
  sidebarResizerEl.classList.add("dragging");

  const onMove = (ev: MouseEvent) => {
    const next = Math.max(180, Math.min(360, Math.round(ev.clientX)));
    sidebarWidth = next;
    applyAppearance();
  };

  const onUp = () => {
    sidebarEl.classList.remove("resizing");
    sidebarResizerEl.classList.remove("dragging");
    localStorage.setItem(STORAGE_SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
});

window.addEventListener("focus", () => {
  if (activeSessionId) {
    if (unreadSessionIds.delete(activeSessionId)) {
      updateDocumentTitle();
    }
    // Re-sync PTY size on desktop focus in case a phone client resized it
    const m = mounted.get(activeSessionId);
    if (m) requestAnimationFrame(() => fitAndSync(m));
  }
});

window.termdeckDesktop?.onFontZoom?.((delta) => adjustTerminalFontSize(delta));
window.termdeckDesktop?.onSelectSession?.((sessionId) => {
  if (sessions.some((s) => s.id === sessionId)) {
    selectSession(sessionId);
  }
});

// Global keyboard shortcuts
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openModal();
  } else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
    e.preventDefault();
    openSettingsModal();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
    e.preventDefault();
    document.getElementById("btn-toggle-sidebar")!.click();
  } else if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) {
    e.preventDefault();
    adjustTerminalFontSize(1);
  } else if ((e.metaKey || e.ctrlKey) && e.key === "-") {
    e.preventDefault();
    adjustTerminalFontSize(-1);
  } else if ((e.metaKey || e.ctrlKey) && e.key === "0") {
    e.preventDefault();
    adjustTerminalFontSize(0);
  } else if (e.key === "Escape") {
    if (!deleteBackdropEl.classList.contains("hidden")) {
      closeDeleteModal();
    } else if (!settingsBackdropEl.classList.contains("hidden")) {
      closeSettingsModal();
    } else if (!modalBackdropEl.classList.contains("hidden")) {
      closeModal();
    }
  }
});

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(str: string): string {
  return escapeHtml(str).replace(/'/g, "&#39;");
}

function syncNotifyBtn() {
  const desktopReady = Boolean(window.termdeckDesktop?.notify);
  const granted = desktopReady || ("Notification" in window && Notification.permission === "granted");
  const active = notifyEnabled && granted;
  btnNotifyToggleEl.classList.toggle("enabled", active);
  btnNotifyToggleEl.setAttribute(
    "data-tooltip",
    active ? "Notifications: On" : "Notifications: Off"
  );
}

btnNotifyToggleEl.addEventListener("click", () => {
  void setNotificationsEnabled(!notifyEnabled, true);
});

// Boot
async function boot() {
  if (window.termdeckDesktop?.isMac) {
    document.body.classList.add("desktop-mac");
  }
  if (window.innerWidth <= 720) {
    sidebarEl.classList.add("collapsed");
  }
  applyAppearance();
  syncNotifyBtn();
  await fetchMeta();
  await fetchSessions();
  connectEventsWs();
}

void boot();
