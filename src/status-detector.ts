import type { AgentKind, SessionStatus } from "./types";

export interface DetectedState {
  status: SessionStatus;
  detail?: string;
}

const MAX_TAIL_CHARS = 3000;
const ECHO_WINDOW_MS = 180;
const REDRAW_SUPPRESS_MS = 500;
const SETTLE_CHECK_MS = 750;
const IDLE_AFTER_MS = 2600;

// OSC sequences: \x1b]<code>;<payload>(\x07|\x1b\\)
const OSC_REGEX = /\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

// Strip ANSI CSI, OSC, and other escape sequences for clean text inspection
function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r/g, "");
}

// Decision / approval prompt patterns across Claude Code, Antigravity, Codex, Gemini, and CLI tools
const DECISION_PATTERNS: Array<{ re: RegExp; detail: string }> = [
  { re: /do you want to (?:proceed|continue|run|execute|make this edit|create|delete|overwrite|allow)/i, detail: "Needs approval" },
  { re: /allow (?:once|always|for this session|this action|tool|command)/i, detail: "Needs approval" },
  { re: /yes,\s*(?:allow|proceed|continue|don't ask again)/i, detail: "Needs approval" },
  { re: /permission (?:required|needed|request)/i, detail: "Permission required" },
  { re: /approve(?:\/| or )reject|approve this/i, detail: "Needs approval" },
  { re: /trust (?:this|the) (?:folder|directory|workspace|project)/i, detail: "Trust prompt" },
  { re: /(?:enter|↑\/↓|arrow keys) to (?:select|choose|confirm)/i, detail: "Needs decision" },
  { re: /select an option|choose an option|which option|pick one/i, detail: "Needs decision" },
  { re: /waiting for (?:your )?(?:input|approval|decision|confirmation)/i, detail: "Waiting for input" },
  { re: /press enter to continue|hit enter to continue/i, detail: "Press Enter" },
  { re: /\(y\/n\)|\[y\/n\]|\[Y\/n\]|\[y\/N\]|\(yes\/no\)/, detail: "Confirm (y/n)" },
  { re: /would you like (?:me )?to\b.*\?\s*$/im, detail: "Waiting for answer" },
];

// Active working cues (spinners, interrupt hints, tool activity)
const SPINNER_CHARS = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒✶✳✽✢✻]/;
const WORKING_PATTERNS: Array<{ re: RegExp; detail: string }> = [
  { re: /esc to interrupt|ctrl\+c to interrupt|ctrl-c to cancel/i, detail: "Working…" },
  { re: /\b(?:thinking|reasoning|pondering|analyzing|planning)\b\.{0,3}/i, detail: "Thinking…" },
  { re: /\b(?:reading|searching|editing|writing|running|executing|building|testing)\b/i, detail: "Running tool…" },
];

// Explicit idle prompt hints at the end of output (shell prompts & agent input bars)
const IDLE_PROMPT_RE = /(?:^|\n)\s*(?:❯|>|\$|%|›)\s*$/;
const IDLE_FOOTER_RE = /\?\s+for shortcuts|shift\+tab to cycle|type your message|ask anything/i;

export class SessionStatusDetector {
  private agent: AgentKind;
  private cleanTail = "";
  private lastInputAt = 0;
  private lastRedrawTriggerAt = 0;
  private lastOutputAt = 0;
  private status: SessionStatus = "idle";
  private detail: string | undefined;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onChange: (state: DetectedState, bell?: boolean) => void;

  constructor(agent: AgentKind, onChange: (state: DetectedState, bell?: boolean) => void) {
    this.agent = agent;
    this.onChange = onChange;
  }

  get state(): DetectedState {
    return { status: this.status, detail: this.detail };
  }

  dispose() {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.settleTimer = null;
    this.idleTimer = null;
  }

  /** External deterministic hook override (e.g. from Claude Code / agy hooks) */
  applyExternalHook(event: string, message?: string) {
    const lower = event.toLowerCase();
    if (lower === "permissionrequest" || lower === "permission" || lower === "needs_input" || lower === "decision") {
      this.clearTimers();
      this.setState("needs_input", message || "Needs approval", true);
    } else if (lower === "notification") {
      this.clearTimers();
      this.setState("needs_input", message || "Needs attention", true);
    } else if (lower === "userpromptsubmit" || lower === "pretooluse" || lower === "working") {
      this.clearTimers();
      this.setState("working", message || "Working…");
    } else if (lower === "stop" || lower === "idle" || lower === "done") {
      this.clearTimers();
      this.setState("idle", message || "Ready");
    }
  }

  onResize() {
    this.lastRedrawTriggerAt = Date.now();
  }

  onUserInput(data: string) {
    // Terminal focus-in/out reports (\x1b[I, \x1b[O) trigger a TUI repaint, not real work
    if (data === "\x1b[I" || data === "\x1b[O") {
      this.lastRedrawTriggerAt = Date.now();
      return;
    }
    this.lastInputAt = Date.now();
    const submitted = data.includes("\r") || data.includes("\n");
    if (submitted) {
      // Clear previous turn's tail so old output can't false-trigger on the next turn
      this.cleanTail = "";
    }
    // Submitting a key/Enter clears any pending decision banner immediately
    if (this.status === "needs_input") {
      this.clearTimers();
      const confirmed = submitted || data === "y" || data === "n" || data === "1" || data === "2";
      this.setState(confirmed && this.agent !== "shell" ? "working" : "idle", confirmed && this.agent !== "shell" ? "Working…" : undefined);
    }
  }

  onExit(exitCode: number) {
    this.clearTimers();
    this.setState("exited", `Exited (${exitCode})`);
  }

  onOutput(rawChunk: string) {
    const now = Date.now();
    this.lastOutputAt = now;

    // 1. Inspect OSC sequences before stripping ANSI
    let oscBell = false;
    let oscNotification: string | null = null;
    let oscTitleWorking = false;

    for (const match of rawChunk.matchAll(OSC_REGEX)) {
      const code = match[1];
      const payload = match[2].trim();
      if (code === "9" || code === "99" || code === "777") {
        // Desktop notification OSC (used by Claude Code / modern TUIs)
        oscNotification = payload.replace(/^notify;/i, "").slice(0, 48) || "Needs attention";
        oscBell = true;
      } else if (code === "0" || code === "2") {
        if (SPINNER_CHARS.test(payload)) {
          oscTitleWorking = true;
        }
      }
    }

    // Detect standalone BEL (\x07 not used as an OSC terminator)
    const withoutOsc = rawChunk.replace(OSC_REGEX, "");
    const standaloneBell = withoutOsc.includes("\x07");

    // 2. Append ANSI-stripped text to rolling tail (reset on full-screen clear)
    if (rawChunk.includes("\x1b[2J") || rawChunk.includes("\x1b[3J")) {
      this.cleanTail = "";
    }
    const clean = stripAnsi(rawChunk);
    if (clean) {
      this.cleanTail = (this.cleanTail + clean).slice(-MAX_TAIL_CHARS);
    }

    // Immediate OSC notification => needs_input
    if (oscNotification) {
      this.clearTimers();
      this.setState("needs_input", oscNotification, true);
      return;
    }

    // Ignore tiny keystroke echo right after user input so typing doesn't flash "Working"
    const isLikelyEcho =
      now - this.lastInputAt < ECHO_WINDOW_MS &&
      clean.length <= 16 &&
      !clean.includes("\n") &&
      !oscTitleWorking &&
      !standaloneBell;

    if (isLikelyEcho) {
      return;
    }

    // Ignore TUI redraws caused by focus reporting or terminal resize when currently idle
    const isLikelyRedraw =
      this.status === "idle" &&
      now - this.lastRedrawTriggerAt < REDRAW_SUPPRESS_MS &&
      !oscTitleWorking &&
      !standaloneBell;

    if (isLikelyRedraw) {
      return;
    }

    // 3. Determine immediate state while output is flowing
    const recentLines = this.getRecentLines(14);
    const workingHint = this.detectWorkingHint(recentLines, oscTitleWorking);

    if (workingHint) {
      this.setState("working", workingHint, standaloneBell);
    } else if (clean.trim().length > 0 && !IDLE_PROMPT_RE.test(recentLines)) {
      this.setState("working", this.agent === "shell" ? "Running…" : "Working…", standaloneBell);
    } else if (standaloneBell) {
      this.onChange(this.state, true);
    }

    // 4. Schedule quiet-time inspection: once output settles for ~750ms, check if it stopped on a decision prompt
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.inspectSettledTail(standaloneBell || oscBell);
    }, SETTLE_CHECK_MS);

    // 5. Fallback transition to idle if no output arrives for IDLE_AFTER_MS and no decision prompt was matched
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.status === "working") {
        const recent = this.getRecentLines(8);
        const bottom = this.getRecentLines(3);
        const decision = IDLE_FOOTER_RE.test(bottom) ? null : this.detectDecision(recent);
        if (decision) {
          this.setState("needs_input", decision, true);
        } else {
          this.setState("idle", "Ready");
        }
      }
    }, IDLE_AFTER_MS);
  }

  private inspectSettledTail(hadBell: boolean) {
    if (this.status === "exited") return;
    const recent = this.getRecentLines(8);
    const bottom = this.getRecentLines(3);

    // If the CLI clearly returned to its normal idle input footer/prompt, settle to idle
    if (IDLE_FOOTER_RE.test(bottom) && !this.detectWorkingHint(recent, false)) {
      this.clearTimers();
      this.setState("idle", "Ready");
      return;
    }

    const decision = this.detectDecision(recent);
    if (decision) {
      this.clearTimers();
      this.setState("needs_input", decision, true);
      return;
    }

    // If a standalone bell rang and output stopped, treat as needing attention
    if (hadBell && this.agent !== "shell") {
      this.clearTimers();
      this.setState("needs_input", "Needs attention", true);
      return;
    }

    // If it clearly returned to an idle shell/agent prompt, settle to idle quickly
    if (IDLE_PROMPT_RE.test(recent) && !this.detectWorkingHint(recent, false)) {
      this.clearTimers();
      this.setState("idle", "Ready");
    }
  }

  private getRecentLines(count: number): string {
    const lines = this.cleanTail.split("\n").filter((l) => l.trim().length > 0);
    return lines.slice(-count).join("\n");
  }

  private detectDecision(recentText: string): string | null {
    if (!recentText) return null;
    for (const pattern of DECISION_PATTERNS) {
      if (pattern.re.test(recentText)) {
        return pattern.detail;
      }
    }
    return null;
  }

  private detectWorkingHint(recentText: string, oscSpinner: boolean): string | null {
    if (oscSpinner) return "Working…";
    // Check last 6 non-empty lines for active spinners or interrupt prompts
    const bottom = recentText.split("\n").slice(-6).join("\n");
    for (const p of WORKING_PATTERNS) {
      if (p.re.test(bottom)) return p.detail;
    }
    if (SPINNER_CHARS.test(bottom)) return "Working…";
    return null;
  }

  private clearTimers() {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.settleTimer = null;
    this.idleTimer = null;
  }

  private setState(status: SessionStatus, detail?: string, bell = false) {
    const changed = this.status !== status || this.detail !== detail;
    this.status = status;
    this.detail = detail;
    if (changed || bell) {
      this.onChange({ status, detail }, bell);
    }
  }
}
