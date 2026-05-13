const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("@playwright/test");
const { createDebouncedRerunner } = require("./dev-extension-runner-utils");

const repoRoot = path.resolve(__dirname, "..");
const extensionPath = path.join(repoRoot, "build/chrome");
const userDataDir = path.join(repoRoot, ".tmp/chrome-dev-profile");
const watchPaths = ["src/**/*", "public/**/*"];
const debounceMs = Number(process.env.DEV_CHROME_DEBOUNCE_MS || 1500);

let context = null;
let page = null;
let runNumber = 0;
let shuttingDown = false;
let watcher = null;

function log(message) {
  console.log(`[dev:chrome:open] ${message}`);
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        FORCE_COLOR: "1",
      },
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

async function closeBrowser() {
  const activeContext = context;
  context = null;
  page = null;

  if (activeContext) {
    await activeContext.close().catch((error) => {
      log(`failed to close previous browser: ${error.message}`);
    });
  }
}

function attachPageDiagnostics(activePage) {
  if (activePage.__kissTranslatorDiagnosticsAttached) {
    return;
  }
  activePage.__kissTranslatorDiagnosticsAttached = true;

  activePage.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      log(`page ${message.type()}: ${message.text()}`);
    }
  });

  activePage.on("pageerror", (error) => {
    log(`page error: ${error.message}`);
  });
}

async function openExtension() {
  if (!fs.existsSync(path.join(extensionPath, "manifest.json"))) {
    throw new Error(`Chrome extension manifest not found at ${extensionPath}`);
  }

  await closeBrowser();

  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  context.on("page", attachPageDiagnostics);

  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", {
      timeout: 15000,
    });
  }

  const extensionId = serviceWorker.url().split("/")[2];
  if (!extensionId) {
    throw new Error(`Could not resolve extension id from ${serviceWorker.url()}`);
  }

  page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.locator("#root").waitFor({ state: "attached", timeout: 15000 });

  log(`opened options.html for extension ${extensionId}`);
}

async function rebuildAndRestart() {
  const currentRun = ++runNumber;
  log(`run #${currentRun}: building Chrome extension`);

  try {
    await runCommand("pnpm", ["build:chrome"]);
    if (shuttingDown) {
      return;
    }
    await openExtension();
    log(`run #${currentRun}: ready`);
  } catch (error) {
    log(`run #${currentRun}: failed`);
    console.error(error);
  }
}

async function main() {
  const { watch } = await import("chokidar");
  const rerunner = createDebouncedRerunner({
    delayMs: debounceMs,
    run: rebuildAndRestart,
  });

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    rerunner.dispose();
    if (watcher) {
      await watcher.close();
    }
    await closeBrowser();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  watcher = watch(watchPaths, {
    cwd: repoRoot,
    ignoreInitial: true,
    ignored: [
      "build/**",
      ".tmp/**",
      "node_modules/**",
      "test-results/**",
      "playwright-report/**",
    ],
  });

  watcher.on("all", (eventName, filePath) => {
    log(`${eventName} ${filePath}; scheduling rebuild`);
    rerunner.requestRun();
  });

  log(`watching ${watchPaths.join(", ")} with ${debounceMs}ms debounce`);
  await rerunner.runNow();
}

main().catch(async (error) => {
  console.error(error);
  await closeBrowser();
  process.exit(1);
});
