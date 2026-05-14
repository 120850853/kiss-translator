const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const {
  encodeWebSocketFrame,
  decodeWebSocketFrames,
  reloaderBuildPath,
  writeDevReloaderExtension,
} = require("./dev-profile-reloader");

test("writes a management-based dev reloader extension", () => {
  writeDevReloaderExtension();

  const manifest = JSON.parse(
    fs.readFileSync(path.join(reloaderBuildPath, "manifest.json"), "utf8")
  );
  const background = fs.readFileSync(
    path.join(reloaderBuildPath, "background.js"),
    "utf8"
  );

  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toContain("management");
  expect(manifest.background.service_worker).toBe("background.js");
  expect(background).toContain("new WebSocket");
  expect(background).toContain("chrome.runtime.sendMessage");
  expect(background).toContain("dev_external_reload");
  expect(background).toContain("chrome.management.setEnabled(targetId, false)");
  expect(background).toContain("chrome.management.setEnabled(targetId, true)");
});

test("encodes and decodes websocket text frames used by the local server", () => {
  const frame = encodeWebSocketFrame(JSON.stringify({ type: "ping" }));
  const decoded = decodeWebSocketFrames(frame);

  expect(decoded.rest.length).toBe(0);
  expect(decoded.messages).toEqual([JSON.stringify({ type: "ping" })]);
});
