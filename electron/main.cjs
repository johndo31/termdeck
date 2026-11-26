const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, screen, shell } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");

const APP_ROOT = path.resolve(__dirname, "..");
const DESKTOP_CONFIG_PATH = path.join(homedir(), ".termdeck", "desktop.json");

let mainWindow = null;
let serverProc = null;
let serverUrl = null;
let activeMode = "local";

function readDesktopConfig() {
  try {
    if (!existsSync(DESKTOP_CONFIG_PATH)) return { remoteServerUrl: "" };
    const parsed = JSON.parse(readFileSync(DESKTOP_CONFIG_PATH, "utf8"));
    return {
      remoteServerUrl: typeof parsed?.remoteServerUrl === "string" ? parsed.remoteServerUrl.trim() : "",
    };
  } catch {
    return { remoteServerUrl: "" };
  }
}

function writeDesktopConfig(next) {
  const dir = path.dirname(DESKTOP_CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DESKTOP_CONFIG_PATH, JSON.stringify({ remoteServerUrl: next.remoteServerUrl || "" }, null, 2), "utf8");
}

function stopBackendServer() {
  if (serverProc && !serverProc.killed) {
    serverProc.kill("SIGTERM");
  }
  serverProc = null;
}

function normalizeServerUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const withProto = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const parsed = new URL(withProto);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("URL must use http:// or https://");
  }
  return parsed.toString();
}

function resolveBunBinary() {
  const candidates = [
    process.env.BUN_BIN,
    path.join(homedir(), ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
    "bun",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === "bun" || existsSync(candidate)) {
      return candidate;
    }
  }
  return "bun";
}

function startBackendServer() {
  return new Promise((resolve, reject) => {
    const bunBin = resolveBunBinary();
    const serverEntry = path.join(APP_ROOT, "src", "server.ts");

    const extraPaths = [
      path.join(homedir(), ".bun", "bin"),
      path.join(homedir(), ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ];
    const mergedPath = [...extraPaths, process.env.PATH || ""].filter(Boolean).join(":");

    const serverEnv = {
      ...process.env,
      PATH: mergedPath,
      PORT: process.env.PORT || "0",
      HOST: process.env.HOST || "127.0.0.1",
    };
    delete serverEnv.SSH_CONNECTION;
    delete serverEnv.SSH_CLIENT;
    delete serverEnv.SSH_TTY;
    if (serverEnv.TMPDIR && !existsSync(serverEnv.TMPDIR)) {
      serverEnv.TMPDIR = "/tmp";
    }

    serverProc = spawn(bunBin, [serverEntry], {
      cwd: APP_ROOT,
      env: serverEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let stderrBuf = "";
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Backend startup timed out. stderr: ${stderrBuf}`));
      }
    }, 10000);

    serverProc.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      const match = /TERMDECK_READY\s+(http:\/\/[^\s]+)/.exec(text);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        // Always load the local desktop window via 127.0.0.1 even when listening on 0.0.0.0
        serverUrl = match[1].replace("://0.0.0.0:", "://127.0.0.1:");
        resolve(serverUrl);
      }
    });

    serverProc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
    });

    serverProc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    serverProc.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Backend exited early (code ${code}): ${stderrBuf}`));
      }
    });
  });
}

function buildAppMenu() {
  const sendZoom = (delta) => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    win?.webContents.send("termdeck:font-zoom", delta);
  };

  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Increase Terminal Font Size",
          accelerator: "CmdOrCtrl+=",
          click: () => sendZoom(1),
        },
        {
          label: "Increase Terminal Font Size (Plus)",
          accelerator: "CmdOrCtrl+Plus",
          visible: false,
          click: () => sendZoom(1),
        },
        {
          label: "Decrease Terminal Font Size",
          accelerator: "CmdOrCtrl+-",
          click: () => sendZoom(-1),
        },
        {
          label: "Reset Terminal Font Size",
          accelerator: "CmdOrCtrl+0",
          click: () => sendZoom(0),
        },
        { type: "separator" },
        {
          label: "Switch to Local Server",
          click: () => {
            void switchToTargetUrl("");
          },
        },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(url) {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1260, Math.max(820, workArea.width - 48));
  const height = Math.min(820, Math.max(560, workArea.height - 48));

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 680,
    minHeight: 460,
    backgroundColor: "#0b0d11",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: process.platform === "darwin" ? { x: 14, y: 14 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Lock page zoom to 100% so Chromium zoom never breaks xterm.js cell geometry;
  // Cmd+ / Cmd- / Cmd+0 adjust terminal fontSize cleanly instead.
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow?.webContents.setZoomFactor(1);
    mainWindow?.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  });

  // Open clicked URLs in the user's default browser
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl.startsWith("http://") || targetUrl.startsWith("https://")) {
      void shell.openExternal(targetUrl);
    }
    return { action: "deny" };
  });

  // Show a clean recovery page if a remote Mac mini / VPN server is unreachable
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDesc, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || activeMode !== "remote") return;
    const safeUrl = String(validatedUrl || "").replace(/[<>&"]/g, "");
    const safeErr = String(errorDesc || "Connection failed").replace(/[<>&"]/g, "");
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{margin:0;height:100vh;background:#0b0d11;color:#f0f4fa;font-family:"SF Mono",Menlo,monospace;display:flex;align-items:center;justify-content:center;padding:24px;}
      .card{max-width:440px;background:#12161d;border:1px solid #2d3546;border-radius:12px;padding:22px;display:flex;flex-direction:column;gap:12px;}
      h1{margin:0;font-size:15px;} p{margin:0;font-size:12.5px;color:#95a2b8;line-height:1.5;word-break:break-all;}
      .row{display:flex;gap:8px;margin-top:6px;}
      button{height:34px;padding:0 14px;border-radius:7px;font-family:inherit;font-size:12.5px;font-weight:600;cursor:pointer;}
      .primary{border:none;background:#6c8cff;color:#090b10;}
      .secondary{border:1px solid #2d3546;background:#171c25;color:#f0f4fa;}
    </style></head><body><div class="card">
      <h1>Could not reach remote termdeck</h1>
      <p>${safeUrl}<br/>${safeErr}</p>
      <p>Check that your VPN is connected and termdeck is running on the remote machine.</p>
      <div class="row">
        <button class="primary" onclick="location.href=decodeURIComponent('${encodeURIComponent(serverUrl || "")}')">Retry</button>
        <button class="secondary" onclick="window.termdeckDesktop?.setServerTarget('')">Switch to Local</button>
      </div>
    </div></body></html>`;
    mainWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });

  mainWindow.loadURL(url);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.on("termdeck:badge", (_event, count) => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.setBadge(count > 0 ? String(count) : "");
  }
});

ipcMain.on("termdeck:notify", (_event, payload) => {
  if (!payload || typeof payload !== "object") return;
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : "termdeck";
  const body = typeof payload.body === "string" && payload.body.trim() ? payload.body.trim() : "Waiting for your decision";
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";

  const silent = payload.sound === false;
  if (payload.banner !== false && Notification.isSupported()) {
    const n = new Notification({ title, body, silent });
    n.on("failed", () => {
      if (process.platform === "darwin") {
        const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const soundClause = silent ? "" : ' sound name "Glass"';
        spawn("osascript", [
          "-e",
          `display notification "${esc(body)}" with title "${esc(title)}"${soundClause}`,
        ], { stdio: "ignore" });
      }
    });
    n.on("click", () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      } else if (serverUrl) {
        createWindow(serverUrl);
      }
      if (process.platform === "darwin") {
        app.focus({ steal: true });
      }
      if (sessionId && mainWindow) {
        mainWindow.webContents.send("termdeck:select-session", sessionId);
      }
    });
    n.show();
  }

  if (payload.bounce !== false && process.platform === "darwin" && app.dock && (!mainWindow || !mainWindow.isFocused())) {
    app.dock.bounce("informational");
  }
});

ipcMain.on("termdeck:open-external", (_event, targetUrl) => {
  if (typeof targetUrl !== "string") return;
  const trimmed = targetUrl.trim();
  if (
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("mailto:")
  ) {
    void shell.openExternal(trimmed);
  } else if (trimmed.startsWith("file://")) {
    try {
      const filePath = decodeURIComponent(new URL(trimmed).pathname);
      if (filePath && existsSync(filePath)) {
        void shell.openPath(filePath);
      }
    } catch {
      // ignore invalid file URL
    }
  }
});

ipcMain.handle("termdeck:pick-folder", async (_event, defaultPath) => {
  const fallback = existsSync(path.join(homedir(), "Development"))
    ? path.join(homedir(), "Development")
    : homedir();
  const resolvedDefault =
    typeof defaultPath === "string" && defaultPath.trim() && existsSync(defaultPath.trim())
      ? defaultPath.trim()
      : fallback;

  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: "Choose Project Folder",
    defaultPath: resolvedDefault,
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

async function switchToTargetUrl(rawUrl) {
  const normalized = normalizeServerUrl(rawUrl);
  writeDesktopConfig({ remoteServerUrl: normalized });

  if (normalized) {
    stopBackendServer();
    activeMode = "remote";
    serverUrl = normalized;
  } else {
    if (!serverProc || serverProc.killed) {
      serverUrl = await startBackendServer();
    }
    activeMode = "local";
  }

  if (mainWindow) {
    mainWindow.loadURL(serverUrl);
  } else {
    createWindow(serverUrl);
  }
  return { mode: activeMode, remoteServerUrl: normalized };
}

ipcMain.handle("termdeck:get-server-target", () => {
  const cfg = readDesktopConfig();
  return {
    mode: activeMode,
    remoteServerUrl: process.env.TERMDECK_SERVER_URL || cfg.remoteServerUrl || "",
  };
});

ipcMain.handle("termdeck:set-server-target", async (_event, rawUrl) => {
  return switchToTargetUrl(rawUrl);
});

app.setName("termdeck");

app.whenReady().then(async () => {
  buildAppMenu();
  try {
    const cfg = readDesktopConfig();
    const configuredRemote = (process.env.TERMDECK_SERVER_URL || cfg.remoteServerUrl || "").trim();
    if (configuredRemote) {
      activeMode = "remote";
      serverUrl = normalizeServerUrl(configuredRemote);
    } else {
      activeMode = "local";
      serverUrl = await startBackendServer();
    }
    createWindow(serverUrl);
  } catch (err) {
    console.error("Failed to start termdeck:", err);
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverUrl) {
      createWindow(serverUrl);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopBackendServer();
});
