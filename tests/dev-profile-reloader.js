const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { spawn } = require("child_process");
const { createDebouncedRerunner } = require("./dev-extension-runner-utils");

const repoRoot = path.resolve(__dirname, "..");
const targetExtensionPath = path.join(repoRoot, "build/chrome");
const reloaderSourcePath = path.join(__dirname, "dev-reloader-extension");
const reloaderBuildPath = path.join(repoRoot, "build/dev-reloader");
const watchPaths = ["src/**/*", "public/**/*"];
const debounceMs = Number(process.env.DEV_CHROME_DEBOUNCE_MS || 1500);
const serverPort = Number(process.env.DEV_RELOADER_PORT || 17787);
const explicitTargetId = process.env.DEV_RELOADER_TARGET_ID || "";
const chromeProfileRoot = path.join(
  process.env.HOME || "",
  "Library/Application Support/Google/Chrome"
);

let runNumber = 0;
let watcher = null;
let shuttingDown = false;

function log(message) {
  console.log(`[dev:chrome:profile] ${message}`);
}

function copyDir(source, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(sourcePath, destPath);
    } else {
      fs.copyFileSync(sourcePath, destPath);
    }
  }
}

function writeDevReloaderExtension() {
  copyDir(reloaderSourcePath, reloaderBuildPath);
  log(`dev reloader extension ready at ${reloaderBuildPath}`);
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

function chromeTimeToDate(value) {
  if (!value) {
    return null;
  }

  return new Date(Number(value) / 1000 - 11644473600000).toISOString();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function findLoadedTargetExtension() {
  if (explicitTargetId) {
    return {
      id: explicitTargetId,
      source: "DEV_RELOADER_TARGET_ID",
    };
  }

  if (!fs.existsSync(chromeProfileRoot)) {
    return null;
  }

  const targetPath = path.resolve(targetExtensionPath);
  const profileNames = fs
    .readdirSync(chromeProfileRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const profileName of profileNames) {
    const prefsPath = path.join(
      chromeProfileRoot,
      profileName,
      "Secure Preferences"
    );
    if (!fs.existsSync(prefsPath)) {
      continue;
    }

    let prefs;
    try {
      prefs = readJson(prefsPath);
    } catch {
      continue;
    }

    const settings = prefs.extensions?.settings || {};
    for (const [id, extension] of Object.entries(settings)) {
      if (path.resolve(extension.path || "") === targetPath) {
        return {
          id,
          profileName,
          source: prefsPath,
          lastUpdateTime: chromeTimeToDate(extension.last_update_time),
          state: extension.state,
        };
      }
    }
  }

  return null;
}

function encodeWebSocketFrame(data) {
  const payload = Buffer.from(data);
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  return Buffer.concat([header, payload]);
}

function decodeWebSocketFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) === 0x80;
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (buffer.length - offset < 4) {
        break;
      }
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) {
        break;
      }
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (buffer.length - offset < frameLength) {
      break;
    }

    const maskStart = offset + headerLength;
    const payloadStart = maskStart + maskLength;
    const payload = Buffer.from(buffer.slice(payloadStart, payloadStart + length));

    if (masked) {
      const mask = buffer.slice(maskStart, maskStart + 4);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }

    if (opcode === 0x1) {
      messages.push(payload.toString("utf8"));
    }

    offset += frameLength;
  }

  return {
    messages,
    rest: buffer.slice(offset),
  };
}

function createDevReloaderServer() {
  const clients = new Set();
  const pendingReloads = new Map();
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("KISS Translator dev reloader is running.\n");
  });

  function send(socket, message) {
    if (socket.destroyed) {
      return;
    }

    socket.write(encodeWebSocketFrame(JSON.stringify(message)));
  }

  function broadcast(message) {
    for (const client of clients) {
      send(client, message);
    }
  }

  function handleClientMessage(socket, rawMessage) {
    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch (error) {
      log(`invalid reloader message: ${error.message}`);
      return;
    }

    if (message.type === "hello") {
      log(`reloader connected: ${message.extensionId}`);
      return;
    }

    if (message.type === "reload-result") {
      const pending = pendingReloads.get(message.runId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingReloads.delete(message.runId);
        pending.resolve(message);
      }
    }
  }

  server.on("upgrade", (request, socket) => {
    if (request.url !== "/kiss-dev-reloader") {
      socket.destroy();
      return;
    }

    const key = request.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n")
    );

    socket.__kissFrameBuffer = Buffer.alloc(0);
    clients.add(socket);

    socket.on("data", (chunk) => {
      socket.__kissFrameBuffer = Buffer.concat([
        socket.__kissFrameBuffer,
        chunk,
      ]);
      const decoded = decodeWebSocketFrames(socket.__kissFrameBuffer);
      socket.__kissFrameBuffer = decoded.rest;
      decoded.messages.forEach((message) => handleClientMessage(socket, message));
    });

    socket.on("close", () => {
      clients.delete(socket);
      log("reloader disconnected");
    });

    socket.on("error", (error) => {
      clients.delete(socket);
      log(`reloader socket error: ${error.message}`);
    });
  });

  const keepAliveTimer = setInterval(() => {
    broadcast({ type: "ping", at: new Date().toISOString() });
  }, 20000);

  function requestReload({ targetId, runId }) {
    if (clients.size === 0) {
      log(
        `no dev reloader connected; load ${reloaderBuildPath} once in chrome://extensions`
      );
      return Promise.resolve({ ok: false, skipped: true });
    }

    broadcast({ type: "reload-target", targetId, runId });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingReloads.delete(runId);
        resolve({ ok: false, timeout: true });
      }, 10000);
      pendingReloads.set(runId, { resolve, timer });
    });
  }

  function close() {
    clearInterval(keepAliveTimer);
    for (const client of clients) {
      client.destroy();
    }
    server.close();
  }

  return {
    listen: () =>
      new Promise((resolve) => {
        server.listen(serverPort, "127.0.0.1", resolve);
      }),
    close,
    requestReload,
  };
}

async function rebuildAndReload(server) {
  const currentRun = ++runNumber;
  const runId = `run-${currentRun}-${Date.now()}`;
  log(`run #${currentRun}: building Chrome extension`);

  try {
    await runCommand("pnpm", ["build:chrome:dev"]);
    if (shuttingDown) {
      return;
    }

    const target = findLoadedTargetExtension();
    if (!target) {
      log(
        `run #${currentRun}: build completed, but target extension was not found in Chrome preferences`
      );
      log(`load ${targetExtensionPath} once, or set DEV_RELOADER_TARGET_ID`);
      return;
    }

    log(
      `run #${currentRun}: target ${target.id} (${target.profileName || target.source})`
    );
    const result = await server.requestReload({ targetId: target.id, runId });
    if (result.ok) {
      log(
        `run #${currentRun}: reloaded ${result.name} ${result.version} (${target.id})`
      );
    } else if (result.timeout) {
      log(`run #${currentRun}: reload request timed out`);
    } else if (result.error) {
      log(`run #${currentRun}: reload failed: ${result.error}`);
    }
  } catch (error) {
    log(`run #${currentRun}: failed`);
    console.error(error);
  }
}

async function main() {
  writeDevReloaderExtension();

  if (process.argv.includes("--write-reloader-only")) {
    return;
  }

  const { watch } = await import("chokidar");
  const server = createDevReloaderServer();
  const rerunner = createDebouncedRerunner({
    delayMs: debounceMs,
    run: () => rebuildAndReload(server),
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
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  await server.listen();
  log(`reloader server listening on ws://127.0.0.1:${serverPort}`);
  log(`load the helper once from ${reloaderBuildPath}`);

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

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  createDevReloaderServer,
  decodeWebSocketFrames,
  encodeWebSocketFrame,
  findLoadedTargetExtension,
  reloaderBuildPath,
  writeDevReloaderExtension,
};
