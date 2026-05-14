const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { test, expect } = require("@playwright/test");

const repoRoot = path.resolve(__dirname, "..");
const extensionPath = path.join(repoRoot, "build/chrome");
const backgroundPath = path.join(extensionPath, "background.js");

function runPnpmScript(script) {
  execFileSync("pnpm", [script], {
    cwd: repoRoot,
    env: { ...process.env, CI: "false" },
    stdio: "inherit",
  });
}

function readBackground() {
  return fs.readFileSync(backgroundPath, "utf8");
}

test("ordinary Chrome build does not include the dev external reload handler", () => {
  runPnpmScript("build:chrome");

  expect(readBackground()).not.toContain("dev_external_reload");
});

test("dev Chrome build includes the external reload handler", () => {
  runPnpmScript("build:chrome:dev");

  expect(readBackground()).toContain("dev_external_reload");
  expect(readBackground()).toContain("runtime.reload()");
});
