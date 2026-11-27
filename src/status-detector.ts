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

// Multi-line TUI approval / picker dialogs (can sit 2-8 lines above the bottom border)
const TUI_DECISION_PATTERNS: Array<{ re: RegExp; detail: string }> = [
  { re: /requesting permission/i, detail: "Permission required" },
  { re: /run this command\?/i, detail: "Approve command" },
  { re: /do you want to (?:proceed|continue|run|execute|make this edit|create|delete|overwrite|allow)/i, detail: "Needs approval" },
  { re: /allow (?:once|always|for this session|this action|tool|command)/i, detail: "Needs approval" },
  { re: /yes,\s*(?:run|allow|proceed|continue|approve|don't ask again)/i, detail: "Needs approval" },
  { re: /permission (?:required|needed|request)/i, detail: "Permission required" },
  { re: /approve(?:\/| or )reject|approve this/i, detail: "Needs approval" },
  { re: /trust (?:this|the) (?:folder|directory|workspace|project)/i, detail: "Trust prompt" },
  { re: /(?:enter|↑\/↓|arrow keys) to (?:select|choose|confirm)|↑\/↓\s*navigate/i, detail: "Needs decision" },
  { re: /select an option|choose an option|which option|pick one/i, detail: "Needs decision" },
  { re: /waiting for (?:your )?(?:input|approval|decision|confirmation)/i, detail: "Waiting for input" },
];

// Single-line interactive prompts: only match at the very end (last 1-2 lines)
const TAIL_LINE_DECISION_PATTERNS: Array<{ re: RegExp; detail: string }> = [
  { re: /press enter to continue|hit enter to continue/i, detail: "Press Enter" },
  { re: /(?:\(y\/n\)|\[y\/n\]|\[Y\/n\]|\[y\/N\]|\(yes\/no\))\s*[:?]?\s*$/m, detail: "Confirm (y/n)" },
  { re: /would you like (?:me )?to\b.*\?\s*$/im, detail: "Waiting for answer" },
];

// Active working cues (interrupt hints, braille spinners, background agents, tool activity)
const BRAILLE_SPINNER_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]/;
const ACTIVE_INTERRUPT_RE = /esc to interrupt|esc to cancel|ctrl\+c to interrupt|ctrl-c to cancel/i;
const BACKGROUND_AGENT_RE = /·\s*[1-9]\d*\s+subagent\(s\)/i;
const SUBAGENT_ROW_RE = /[●•]\s*Agent\([^)]+\)\s*·/;
const WORKING_PATTERNS: Array<{ re: RegExp; detail: string }> = [
  { re: ACTIVE_INTERRUPT_RE, detail: "Working…" },
  { re: BACKGROUND_AGENT_RE, detail: "Subagent running…" },
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
  private hasPendingTurn = false;
  private backgroundAgentActive = false;
  private lastBgAgentSeenAt = 0;
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
      this.hasPendingTurn = true;
      this.clearTimers();
      this.setState("working", message || "Working…");
    } else if (lower === "stop" || lower === "idle" || lower === "done") {
      this.hasPendingTurn = false;
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
      this.hasPendingTurn = true;
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
    let osc7501State: { status: SessionStatus; detail?: string; bell?: boolean } | null = null;
    let oscProgressState: "working" | "clear" | "paused" | null = null;

    for (const match of rawChunk.matchAll(OSC_REGEX)) {
      const code = match[1];
      const payload = match[2].trim();
      if (code === "7501") {
        // OSC 7501 Program Status Protocol: key=value:key=value
        const fields: Record<string, string> = {};
        for (const part of payload.split(":")) {
          const eq = part.indexOf("=");
          if (eq > 0) {
            fields[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
          }
        }
        const st = (fields.state || "").toLowerCase();
        let msg = fields.msg || "";
        if (msg && /^[A-Za-z0-9+/]+=*$/.test(msg) && msg.length % 4 === 0 && msg.length >= 8) {
          try {
            const decoded = Buffer.from(msg, "base64").toString("utf8");
            if (/^[\x20-\x7E\u00A0-\uFFFF]+$/.test(decoded)) msg = decoded;
          } catch {
            // keep raw msg
          }
        }
        const detail = msg.slice(0, 48) || undefined;
        if (st === "working") {
          osc7501State = { status: "working", detail: detail || "Working…" };
        } else if (st === "blocked" || st === "error") {
          const kind = fields.kind ? `${fields.kind[0].toUpperCase()}${fields.kind.slice(1)}` : undefined;
          osc7501State = { status: "needs_input", detail: detail || kind || "Needs attention", bell: true };
        } else if (st === "idle" || st === "done" || st === "clear") {
          osc7501State = { status: "idle", detail: detail || "Ready", bell: st === "done" };
        }
      } else if (code === "9" && /^4;/.test(payload)) {
        // OSC 9;4;<state>;<progress> (ConEmu / Windows Terminal / Ghostty / iTerm2 progress)
        const parts = payload.split(";");
        const progressState = parts[1];
        if (progressState === "1" || progressState === "3") {
          oscProgressState = "working";
          oscTitleWorking = true;
        } else if (progressState === "0") {
          oscProgressState = "clear";
        } else if (progressState === "2" || progressState === "4") {
          oscProgressState = "paused";
        }
      } else if (code === "9" || code === "99" || code === "777") {
        // Desktop notification OSC (used by Claude Code / modern TUIs)
        oscNotification = payload.replace(/^notify;/i, "").slice(0, 48) || "Needs attention";
        oscBell = true;
      } else if (code === "0" || code === "2") {
        if (BRAILLE_SPINNER_RE.test(payload)) {
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
      if (this.agent === "antigravity" && (BACKGROUND_AGENT_RE.test(clean) || SUBAGENT_ROW_RE.test(clean))) {
        this.backgroundAgentActive = true;
        this.lastBgAgentSeenAt = now;
      }
    }

    // Structured OSC 7501 status takes precedence over text heuristics
    if (osc7501State) {
      this.clearTimers();
      if (osc7501State.status === "idle" && this.backgroundAgentActive) {
        this.hasPendingTurn = true;
        this.setState("working", "Subagent running…", Boolean(osc7501State.bell));
        return;
      }
      this.hasPendingTurn = osc7501State.status === "working";
      this.setState(osc7501State.status, osc7501State.detail, Boolean(osc7501State.bell));
      return;
    }

    // Immediate OSC notification: only classify as needs_input if it mentions approval/decision/input;
    // otherwise treat as a turn-finished completion signal (idle unless a background agent is still running).
    if (oscNotification) {
      this.clearTimers();
      if (/permission|approv|decision|confirm|waiting|input|question/i.test(oscNotification)) {
        this.setState("needs_input", oscNotification, true);
      } else if (this.backgroundAgentActive) {
        this.setState("working", "Subagent running…", true);
      } else {
        this.hasPendingTurn = false;
        this.setState("idle", "Ready", true);
      }
      return;
    }

    if (oscProgressState === "clear" && !clean.trim() && this.status === "working" && !this.backgroundAgentActive) {
      this.hasPendingTurn = false;
      this.clearTimers();
      this.setState("idle", "Ready");
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
    const bottomLines = this.getRecentLines(3);
    const lastTwoLines = this.getRecentLines(2);
    const hasBackgroundAgent =
      this.agent === "antigravity" &&
      (this.backgroundAgentActive ||
        BACKGROUND_AGENT_RE.test(lastTwoLines) ||
        SUBAGENT_ROW_RE.test(lastTwoLines));
    const strongWorkingCue = oscTitleWorking || ACTIVE_INTERRUPT_RE.test(bottomLines) || hasBackgroundAgent;
    const workingHint = this.hasPendingTurn || strongWorkingCue
      ? this.detectWorkingHint(recentLines, oscTitleWorking, hasBackgroundAgent)
      : null;

    if (strongWorkingCue) {
      this.hasPendingTurn = true;
      this.setState("working", workingHint || (hasBackgroundAgent ? "Subagent running…" : "Working…"), false);
    } else if (
      this.hasPendingTurn &&
      clean.trim().length > 0 &&
      !IDLE_PROMPT_RE.test(recentLines) &&
      !(this.status === "idle" && IDLE_FOOTER_RE.test(bottomLines))
    ) {
      this.setState("working", workingHint || (this.agent === "shell" ? "Running…" : "Working…"), false);
    } else if (standaloneBell && this.status !== "working") {
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
        const tailTwo = this.getRecentLines(2);
        if (
          this.agent === "antigravity" &&
          (this.backgroundAgentActive || BACKGROUND_AGENT_RE.test(tailTwo) || SUBAGENT_ROW_RE.test(tailTwo))
        ) {
          return;
        }
        const isIdlePrompt = IDLE_FOOTER_RE.test(bottom) || IDLE_PROMPT_RE.test(bottom);
        const decision = isIdlePrompt ? null : this.detectDecision(recent, tailTwo);
        if (decision) {
          this.setState("needs_input", decision, true);
        } else {
          this.hasPendingTurn = false;
          this.setState("idle", "Ready");
        }
      }
    }, IDLE_AFTER_MS);
  }

  private inspectSettledTail(hadBell: boolean) {
    if (this.status === "exited") return;
    const recent = this.getRecentLines(8);
    const bottom = this.getRecentLines(3);
    const tailTwo = this.getRecentLines(2);

    // Clear backgroundAgentActive once agy settles on its idle footer without any subagent indicator
    if (
      this.backgroundAgentActive &&
      IDLE_FOOTER_RE.test(bottom) &&
      !BACKGROUND_AGENT_RE.test(bottom) &&
      !SUBAGENT_ROW_RE.test(bottom) &&
      Date.now() - this.lastBgAgentSeenAt > 1500
    ) {
      this.backgroundAgentActive = false;
    }

    // Keep working state if a background agent/subagent is visibly active
    if (
      this.agent === "antigravity" &&
      (this.backgroundAgentActive || BACKGROUND_AGENT_RE.test(tailTwo) || SUBAGENT_ROW_RE.test(tailTwo))
    ) {
      this.hasPendingTurn = true;
      this.setState("working", "Subagent running…");
      return;
    }

    // If the CLI clearly returned to its normal idle input footer or shell prompt, settle to idle first
    if ((IDLE_FOOTER_RE.test(bottom) || IDLE_PROMPT_RE.test(bottom)) && !this.detectWorkingHint(recent, false, false)) {
      this.hasPendingTurn = false;
      this.clearTimers();
      this.setState("idle", "Ready");
      return;
    }

    const decision = this.detectDecision(recent, tailTwo);
    if (decision) {
      this.clearTimers();
      this.setState("needs_input", decision, true);
      return;
    }

    // A plain bell without a decision prompt usually signals turn completion, not a blocking decision
    if (hadBell && this.agent !== "shell") {
      this.hasPendingTurn = false;
      this.clearTimers();
      this.setState("idle", "Ready", true);
    }
  }

  private getRecentLines(count: number): string {
    const lines = this.cleanTail.split("\n").filter((l) => l.trim().length > 0);
    return lines.slice(-count).join("\n");
  }

  private detectDecision(recentBlock: string, lastTwoLines: string): string | null {
    if (lastTwoLines) {
      for (const pattern of TAIL_LINE_DECISION_PATTERNS) {
        if (pattern.re.test(lastTwoLines)) {
          return pattern.detail;
        }
      }
    }
    if (recentBlock) {
      for (const pattern of TUI_DECISION_PATTERNS) {
        if (pattern.re.test(recentBlock)) {
          return pattern.detail;
        }
      }
    }
    return null;
  }

  private detectWorkingHint(recentText: string, oscSpinner: boolean, hasBackgroundAgent = false): string | null {
    if (oscSpinner) return "Working…";
    if (hasBackgroundAgent) return "Subagent running…";
    // Check last 6 non-empty lines for active spinners or interrupt prompts
    const bottom = recentText.split("\n").slice(-6).join("\n");
    for (const p of WORKING_PATTERNS) {
      if (p.re === BACKGROUND_AGENT_RE) continue;
      if (p.re.test(bottom)) return p.detail;
    }
    if (BRAILLE_SPINNER_RE.test(bottom)) return "Working…";
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
