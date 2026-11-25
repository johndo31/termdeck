# termdeck

A minimal, zero-injection web UI for your local and remote coding agent terminals (`xterm.js` + session sidebar + persistent resume).

## Features

- **Zero prompt/tool injection** — runs real `claude`, `agy` (Antigravity), `codex`, `gemini`, or plain `$SHELL` inside a real PTY.
- **Always resuming** — remembers every session's directory, host, agent, and UUID in `~/.termdeck/sessions.json`.
  - Uses `tmux -L termdeck` automatically when `tmux` is installed (locally or on remote SSH hosts) so sessions survive restarts and network drops.
  - Works out of the box without `tmux` via Bun's native PTY + scrollback replay + native CLI `--resume` / `--continue` flags.
- **Clean sidebar & compact header** — sessions grouped by project with agent icons, live activity dots, git branch pill, inline rename, `+ Shell` companion button, and `⌘K` quick launcher.
- **Remote over SSH** — auto-discovers hosts from `~/.ssh/config` and uses `ControlMaster` for fast reconnection.

## Run

```bash
bun install
bun run start
```

This launches the native Electron desktop app (with integrated macOS titlebar and Dock badge for sessions needing decisions).

To run in browser-only mode instead:

```bash
bun run web
# Open http://127.0.0.1:3434
```

To build and install a standalone macOS `.app` bundle (`/Applications/termdeck.app`, macOS only):

```bash
bun run build:app
```

Tip: install `tmux` (`brew install tmux`) if you also want local sessions to survive restarting `termdeck` itself.

## Security

`termdeck` is designed for local use and binds to `127.0.0.1` by default with WebSocket/API `Origin` validation. Do not expose it directly on an untrusted network (e.g. `HOST=0.0.0.0`); use an SSH tunnel or Tailscale if you want remote access.

## License

[MIT](LICENSE)
