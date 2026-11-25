import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST_DIR = join(ROOT, "dist");
const ASSETS_DIR = join(ROOT, "assets");
const APP_PATH = join(DIST_DIR, "termdeck.app");
const INSTALL_PATH = "/Applications/termdeck.app";

function run(cmd: string[], cwd = ROOT) {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) {
    throw new Error(`Command failed (${proc.exitCode}): ${cmd.join(" ")}`);
  }
}

console.log("1/5 Building client bundle...");
run(["bun", "run", "build:client"]);

console.log("2/5 Generating macOS app icon...");
mkdirSync(ASSETS_DIR, { recursive: true });
const png1024 = join(ASSETS_DIR, "icon-1024.png");
const iconsetDir = join(ASSETS_DIR, "icon.iconset");
const icnsPath = join(ASSETS_DIR, "icon.icns");

run(["swift", join(ROOT, "scripts", "make-icon.swift"), png1024]);
rmSync(iconsetDir, { recursive: true, force: true });
mkdirSync(iconsetDir, { recursive: true });

const sizes: Array<[number, string]> = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];
for (const [px, name] of sizes) {
  run(["sips", "-z", String(px), String(px), png1024, "--out", join(iconsetDir, name)]);
}
run(["iconutil", "-c", "icns", iconsetDir, "-o", icnsPath]);
rmSync(iconsetDir, { recursive: true, force: true });

console.log("3/5 Assembling dist/termdeck.app...");
const electronApp = join(ROOT, "node_modules", "electron", "dist", "Electron.app");
if (!existsSync(electronApp)) {
  throw new Error("Electron.app not found. Run: node node_modules/electron/install.js");
}

mkdirSync(DIST_DIR, { recursive: true });
rmSync(APP_PATH, { recursive: true, force: true });
// Use macOS `cp -R` to preserve Electron framework symlinks cleanly
run(["cp", "-R", electronApp, APP_PATH]);

const resourcesDir = join(APP_PATH, "Contents", "Resources");
const appPayloadDir = join(resourcesDir, "app");
rmSync(join(resourcesDir, "default_app.asar"), { force: true });
mkdirSync(appPayloadDir, { recursive: true });

for (const item of ["electron", "src", "public", "package.json"]) {
  cpSync(join(ROOT, item), join(appPayloadDir, item), { recursive: true });
}

// Install custom icon
cpSync(icnsPath, join(resourcesDir, "termdeck.icns"));
rmSync(join(resourcesDir, "electron.icns"), { force: true });

// Rename main executable & patch Info.plist so macOS shows "termdeck"
const macosDir = join(APP_PATH, "Contents", "MacOS");
if (existsSync(join(macosDir, "Electron"))) {
  renameSync(join(macosDir, "Electron"), join(macosDir, "termdeck"));
}

const plist = join(APP_PATH, "Contents", "Info.plist");
const plistUpdates: Array<[string, string]> = [
  ["CFBundleName", "termdeck"],
  ["CFBundleDisplayName", "termdeck"],
  ["CFBundleIdentifier", "com.local.termdeck"],
  ["CFBundleExecutable", "termdeck"],
  ["CFBundleIconFile", "termdeck.icns"],
  ["CFBundleShortVersionString", "0.1.0"],
  ["CFBundleVersion", "1"],
  ["NSUserNotificationAlertStyle", "banner"],
];
for (const [key, value] of plistUpdates) {
  run(["plutil", "-replace", key, "-string", value, plist]);
}

console.log("4/5 Ad-hoc signing termdeck.app...");
run(["codesign", "--force", "--deep", "--sign", "-", APP_PATH]);

console.log("5/5 Installing to /Applications/termdeck.app...");
rmSync(INSTALL_PATH, { recursive: true, force: true });
run(["cp", "-R", APP_PATH, INSTALL_PATH]);

console.log("Done! Installed /Applications/termdeck.app");
