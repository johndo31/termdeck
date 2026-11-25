# termdeck

A minimal, zero-injection desktop and web UI for your local and remote coding agent terminals (`xterm.js` + session sidebar + persistent resume).

![termdeck preview](docs/preview.png)

## Features

- **Zero prompt/tool injection** — runs real `claude`, `agy` (Antigravity), `codex`, `gemini`, or plain `$SHELL` inside a real PTY with clickable URL & OSC 8 `file://` links.
- **Always resuming** — remembers every session's directory, host, agent, and UUID in `~/.termdeck/sessions.json` and auto-discovers existing Claude / Antigravity conversations in a folder.
  - Uses `tmux -L termdeck` automatically when `tmux` is installed (locally or on remote SSH hosts) so sessions survive restarts and network drops.
  - Works out of the box without `tmux` via Bun's native PTY + scrollback replay + native CLI `--resume` / `--continue` flags.
- **Clean sidebar & compact header** — sessions grouped by project with agent icons, live `Working` / `Decision` indicators, git branch pill, inline rename, `+ Shell` companion button, `⌘K` quick launcher, and `⌘,` settings (persisted in `~/.termdeck/config.json`).
- **Native macOS notifications** — configurable desktop banners, Dock icon badge count, and Dock bounce with per-event toggles (permission/decision prompts, finished turns, session exits, terminal bell) plus an optional `/api/hooks/:id` webhook endpoint.
- **Remote over SSH & VPN mobile access** — auto-discovers hosts from `~/.ssh/config` (`ControlMaster` for fast reconnects), and includes a live-toggleable **Remote / VPN Access** listener with token auth, slide-over mobile drawer, and touch quick-key bar (`Esc`, `Tab`, `↑`, `↓`, `1`, `2`, `^C`, `Enter`).

## Run

```bash
bun install
bun run start
```

This launches the native Electron desktop app (with integrated macOS titlebar and Dock notifications).

To run in browser-only mode instead:

```bash
bun run web
# Open http://127.0.0.1:3434
```

To build and install a standalone macOS `.app` bundle (`/Applications/termdeck.app`, macOS only):

```bash
bun run build:app
```

Tip: install `tmux` (`brew install tmux`) if you also want local sessions to survive quitting `termdeck` itself.

## Security

`termdeck` binds to `127.0.0.1` by default with WebSocket/API `Origin` validation. When **Remote / VPN Access** is enabled in Settings, non-loopback connections require the auto-generated access token (stored in an `HttpOnly` cookie on login). Only expose it over a private VPN (WireGuard / Tailscale) or trusted LAN, never directly to the public internet.

## License

[MIT](LICENSE)
