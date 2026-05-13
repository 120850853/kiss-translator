const fs = require("fs");
const path = require("path");
const { test, expect, chromium } = require("@playwright/test");

const extensionPath = path.resolve(__dirname, "../build/chrome");
const userDataDir = path.resolve(__dirname, "../.tmp/chrome-dev-profile");

test("loads the built Chrome extension in a dedicated development profile", async () => {
  expect(fs.existsSync(path.join(extensionPath, "manifest.json"))).toBe(true);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker", {
        timeout: 15000,
      });
    }

    const extensionId = serviceWorker.url().split("/")[2];
    expect(extensionId).toBeTruthy();

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(page.locator("#root")).not.toBeEmpty();
  } finally {
    await context.close();
  }
});
