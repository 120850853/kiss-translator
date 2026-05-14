const RELOADER_WS_URL = "ws://127.0.0.1:17787/kiss-dev-reloader";
const RECONNECT_DELAY_MS = 1000;
const TARGET_ENABLE_DELAY_MS = 250;
const TARGET_RELOAD_SETTLE_MS = 1500;
const MSG_DEV_EXTERNAL_RELOAD = "dev_external_reload";

let socket = null;
let reconnectTimer = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(
    JSON.stringify({
      ...message,
      from: "kiss-dev-reloader",
      at: new Date().toISOString(),
    })
  );
}

async function writeStatus(status) {
  await chrome.storage.local.set({
    lastStatus: {
      ...status,
      at: new Date().toISOString(),
    },
  });
}

function sendExternalReload(targetId, runId) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      targetId,
      {
        action: MSG_DEV_EXTERNAL_RELOAD,
        runId,
      },
      (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        if (!response?.ok) {
          reject(new Error(response?.error || "Target extension rejected reload"));
          return;
        }

        resolve(response);
      }
    );
  });
}

async function reloadTargetByManagement(targetId) {
  await chrome.management.setEnabled(targetId, false);
  await sleep(TARGET_ENABLE_DELAY_MS);
  await chrome.management.setEnabled(targetId, true);
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY_MS);
}

async function reloadTarget({ targetId, runId }) {
  if (!targetId) {
    throw new Error("Missing targetId");
  }

  if (targetId === chrome.runtime.id) {
    throw new Error("Refusing to reload the reloader extension itself");
  }

  await writeStatus({ state: "reloading", targetId, runId });

  const before = await chrome.management.get(targetId);
  let method = "external-runtime-reload";
  let externalResponse = null;
  try {
    externalResponse = await sendExternalReload(targetId, runId);
  } catch (error) {
    method = "management-setEnabled-fallback";
    await reloadTargetByManagement(targetId);
    externalResponse = { ok: false, error: error.message };
  }

  await sleep(TARGET_RELOAD_SETTLE_MS);
  const after = await chrome.management.get(targetId);

  await writeStatus({
    state: "reloaded",
    targetId,
    runId,
    method,
    name: after.name,
    version: after.version,
    enabled: after.enabled,
    previousVersion: before.version,
    externalResponse,
  });

  send({
    type: "reload-result",
    ok: true,
    targetId,
    runId,
    method,
    name: after.name,
    version: after.version,
    enabled: after.enabled,
    previousVersion: before.version,
    externalResponse,
    wasEnabled: before.enabled,
  });
}

async function handleMessage(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch (error) {
    send({ type: "client-error", error: `Invalid JSON: ${error.message}` });
    return;
  }

  if (message.type === "ping") {
    send({ type: "pong", serverTime: message.at });
    return;
  }

  if (message.type !== "reload-target") {
    return;
  }

  try {
    await reloadTarget(message);
  } catch (error) {
    await writeStatus({
      state: "error",
      targetId: message.targetId,
      runId: message.runId,
      error: error.message,
    });
    send({
      type: "reload-result",
      ok: false,
      targetId: message.targetId,
      runId: message.runId,
      error: error.message,
    });
  }
}

function connect() {
  try {
    socket = new WebSocket(RELOADER_WS_URL);
  } catch (error) {
    void writeStatus({ state: "connect-error", error: error.message });
    scheduleReconnect();
    return;
  }

  socket.addEventListener("open", () => {
    void writeStatus({ state: "connected" });
    send({
      type: "hello",
      extensionId: chrome.runtime.id,
      userAgent: navigator.userAgent,
    });
  });

  socket.addEventListener("message", (event) => {
    void handleMessage(event);
  });

  socket.addEventListener("close", () => {
    void writeStatus({ state: "disconnected" });
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    void writeStatus({ state: "socket-error" });
  });
}

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);

connect();
