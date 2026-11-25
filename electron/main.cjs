const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, screen, shell } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");

const APP_ROOT = path.resolve(__dirname, "..");

let mainWindow = null;
let serverProc = null;
let serverUrl = null;

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
      HOST: "127.0.0.1",
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
        serverUrl = match[1];
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

  if (Notification.isSupported()) {
    const n = new Notification({ title, body, silent: false });
    n.on("failed", () => {
      if (process.platform === "darwin") {
        const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        spawn("osascript", [
          "-e",
          `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`,
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

app.setName("termdeck");

app.whenReady().then(async () => {
  buildAppMenu();
  try {
    const url = await startBackendServer();
    createWindow(url);
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
  if (serverProc && !serverProc.killed) {
    serverProc.kill("SIGTERM");
    serverProc = null;
  }
});
