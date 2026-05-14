const fs = require("fs");
const path = require("path");
const { test, expect, chromium } = require("@playwright/test");

const extensionPath = path.resolve(__dirname, "../build/chrome");
const userDataDir = path.resolve(__dirname, "../.tmp/x-tweet-profile");

const fakeTweetHtml = String.raw`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>X tweet fixture</title>
  </head>
  <body>
    <article>
      <div data-testid="tweetText" lang="en">
        <span>Andrej Karpathy: "90% of your AI coding bill is paying for context you didn't need to send"

Here are 10 things senior AI engineers stopped wasting tokens on:

1. Auto-context loading 50 files for a 30-line fix: $1.20/turn for tokens you'll never read. 80% input waste, every session</span>
      </div>
    </article>
  </body>
</html>`;

const fakeArticleCardHtml = String.raw`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>X article card fixture</title>
    <style>
      [data-card-content] {
        max-height: 48px;
        overflow: hidden;
      }
      [data-card-summary] {
        display: -webkit-box;
        -webkit-line-clamp: 1;
        max-height: 20px;
        overflow: hidden;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <article data-testid="tweet">
      <div data-testid="tweetText" lang="en">
        <span>Sharing this article.</span>
      </div>
      <div role="link">
        <div data-testid="article-cover-image">Article</div>
        <div data-card-content>
          <div dir="auto">
            <span>The AI Agent Complexity Ratchet: Why 90% Test Coverage Is Required</span>
          </div>
          <div dir="auto" data-card-summary>
            <span>I've been coding with AI for the past year. Not just prompting -- building real software. Two open-source projects: GStack, which makes AI coding agents better, and GBrain, which turns everything you...</span>
          </div>
        </div>
      </div>
    </article>
  </body>
</html>`;

const fakeHomeArticleCardHtml = String.raw`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>X home article fixture</title>
    <style>
      [data-card-content] {
        max-height: 48px;
        overflow: hidden;
      }
      [data-card-summary] {
        display: -webkit-box;
        -webkit-line-clamp: 1;
        max-height: 20px;
        overflow: hidden;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <article data-testid="tweet">
      <div data-testid="article-cover-image">Article</div>
      <div data-card-content>
        <div dir="auto">
          <span>The 9 Claude Agents That Work While You Sleep</span>
        </div>
        <div dir="auto" data-card-summary>
          <span>Every founder, freelancer, and operator wakes up to the same wall: a 9 AM that already feels behind.</span>
        </div>
      </div>
    </article>
  </body>
</html>`;

async function getTweetChildSequence(page) {
  return page.locator('[data-testid="tweetText"]').evaluate((el) =>
    Array.from(el.querySelector("span").childNodes).map((node) => ({
      nodeName: node.nodeName,
      text: (node.textContent || "").trim(),
    }))
  );
}

async function getChildSequence(locator) {
  return locator.evaluate((el) =>
    Array.from(el.childNodes)
      .map((node) => ({
        nodeName: node.nodeName,
        text: (node.textContent || "").trim(),
      }))
      .filter((item) => item.nodeName !== "#text" || item.text)
  );
}

async function getTweetTranslationPairs(page) {
  return page.locator('[data-testid="tweetText"] span').evaluate((el) => {
    const pairs = [];
    let originText = "";

    for (const node of el.childNodes) {
      if (node.nodeName === "KISS-TRANSLATOR") {
        pairs.push({
          origin: originText.trim(),
          translation: (node.textContent || "").trim(),
        });
        originText = "";
        continue;
      }

      if (node.nodeName === "BR") continue;
      originText += node.textContent || "";
    }

    return pairs;
  });
}

async function waitForTweetTranslations(page) {
  await expect(
    page.locator('[data-testid="tweetText"] kiss-translator')
  ).toHaveCount(3, { timeout: 15000 });
}

async function waitForTweetInlineTranslationLayout(page) {
  await expect
    .poll(async () => {
      const layout = await getTweetChildSequence(page);
      return layout.filter((item) => item.nodeName === "KISS-TRANSLATOR")
        .length;
    })
    .toBe(3);
}

async function getLeadingBreakCounts(locator) {
  return locator.evaluateAll((wrappers) =>
    wrappers.map((wrapper) => {
      let count = 0;
      for (const child of wrapper.childNodes) {
        if (child.nodeName !== "BR") break;
        count += 1;
      }
      return count;
    })
  );
}

async function toggleTranslateFromExtension(serviceWorker, page) {
  const url = page.url();
  await serviceWorker.evaluate(async (targetUrl) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((item) => item.url === targetUrl);
    if (!tab?.id) {
      throw new Error(`Unable to find tab for ${targetUrl}`);
    }
    await chrome.tabs.sendMessage(tab.id, { action: "toggle_translate" });
  }, url);
}

test("places translations after each paragraph in long X tweet text", async () => {
  expect(fs.existsSync(path.join(extensionPath, "manifest.json"))).toBe(true);
  fs.rmSync(userDataDir, { recursive: true, force: true });

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

    const stored = await serviceWorker.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await chrome.storage.local.set({
        "KISS-Translator_setting_v2": JSON.stringify({
          transAllnow: true,
          langDetector: "-",
        }),
        "KISS-Translator_rules_v2": JSON.stringify([
          {
            pattern: "*",
            transOpen: "false",
            apiSlug: "Google",
            toLang: "zh-CN",
          },
          {
            pattern: "https://x.com",
            selector: "[data-testid='tweetText']",
            keepSelector: "img, svg, a, span:has(a), div:has(a)",
            transOpen: "true",
            apiSlug: "Google",
            autoScan: "false",
            splitParagraph: "split_textlength",
            splitLength: 10000,
          },
        ]),
      });
      return chrome.storage.local.get([
        "KISS-Translator_setting_v2",
        "KISS-Translator_rules_v2",
      ]);
    });
    expect(JSON.parse(stored["KISS-Translator_setting_v2"]).transAllnow).toBe(
      true
    );

    await context.route(
      "https://translate.googleapis.com/translate_a/single?**",
      async (route) => {
        const url = new URL(route.request().url());
        const text = url.searchParams.get("q") || "";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            sentences: [{ trans: `译文：${text.slice(0, 24)}` }],
            src: "en",
          }),
        });
      }
    );

    await context.route(
      "https://x.com/DeRonin_/status/2054255152555545079",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: fakeTweetHtml,
        })
    );

    const page = await context.newPage();
    await page.goto("https://x.com/DeRonin_/status/2054255152555545079");

    await waitForTweetTranslations(page);
    await expect(
      page.locator('[data-testid="tweetText"] kiss-translator').nth(1)
    ).toContainText("Here are 10 things", { timeout: 15000 });
    await expect(
      page.locator('[data-testid="tweetText"] kiss-translator').nth(2)
    ).toContainText("Auto-context loading", { timeout: 15000 });

    const layout = await getTweetChildSequence(page);

    expect(
      layout.filter((item) => item.nodeName === "KISS-TRANSLATOR")
    ).toHaveLength(3);
    const wrappers = layout.filter(
      (item) => item.nodeName === "KISS-TRANSLATOR"
    );
    expect(wrappers[0].text).toContain("Andrej Karpathy");
    expect(wrappers[1].text).toContain("Here are 10 things");
    expect(wrappers[2].text).toContain("Auto-context loading");
    const pairs = await getTweetTranslationPairs(page);
    expect(pairs).toHaveLength(3);
    expect(pairs[0].origin).toContain("Andrej Karpathy");
    expect(pairs[0].translation).toContain("Andrej Karpathy");
    expect(pairs[1].origin).toContain("Here are 10 things");
    expect(pairs[1].translation).toContain("Here are 10 things");
    expect(pairs[2].origin).toContain("Auto-context loading");
    expect(pairs[2].translation).toContain("Auto-context loading");
    expect(
      await getLeadingBreakCounts(
        page.locator('[data-testid="tweetText"] kiss-translator')
      )
    ).toEqual([2, 2, 2]);

    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        "KISS-Translator_rules_v2": JSON.stringify([
          {
            pattern: "*",
            transOpen: "false",
            apiSlug: "Google",
            toLang: "zh-CN",
          },
          {
            pattern: "https://x.com",
            selector: "[data-testid='tweetText']",
            keepSelector: "img, svg, a, span:has(a), div:has(a)",
            transOpen: "true",
            apiSlug: "Google",
            autoScan: "false",
            splitParagraph: "split_textlength",
            splitLength: 9999,
          },
        ]),
      });
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForTweetTranslations(page);

    await toggleTranslateFromExtension(serviceWorker, page);
    await expect(
      page.locator('[data-testid="tweetText"] kiss-translator')
    ).toHaveCount(0, { timeout: 15000 });

    const originalTextAfterCleanup = await page
      .locator('[data-testid="tweetText"] span')
      .evaluate((el) => el.textContent);
    expect(originalTextAfterCleanup).toContain(
      'need to send"\n\nHere are 10 things'
    );
    expect(originalTextAfterCleanup).toContain(
      "on:\n\n1. Auto-context loading"
    );

    await toggleTranslateFromExtension(serviceWorker, page);
    await waitForTweetTranslations(page);

    await waitForTweetInlineTranslationLayout(page);
    expect(
      await getLeadingBreakCounts(
        page.locator('[data-testid="tweetText"] kiss-translator')
      )
    ).toEqual([2, 2, 2]);
  } finally {
    await context.close();
  }
});

test("translates X article card title and summary", async () => {
  expect(fs.existsSync(path.join(extensionPath, "manifest.json"))).toBe(true);
  fs.rmSync(userDataDir, { recursive: true, force: true });

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

    await serviceWorker.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await chrome.storage.local.set({
        "KISS-Translator_setting_v2": JSON.stringify({
          transAllnow: true,
          langDetector: "-",
        }),
        "KISS-Translator_rules_v2": JSON.stringify([
          {
            pattern: "*",
            transOpen: "false",
            apiSlug: "Google",
            toLang: "zh-CN",
          },
          {
            pattern: "https://x.com",
            selector:
              "[data-testid='tweetText'], [data-testid='twitter-article-title'], [data-testid='UserDescription']",
            keepSelector: "img, svg, a, span:has(a), div:has(a)",
            transOpen: "true",
            apiSlug: "Google",
            autoScan: "false",
            splitParagraph: "split_textlength",
            splitLength: 10000,
            selectStyle:
              "-webkit-line-clamp: unset; max-height: none; height: auto; overflow: visible;",
            parentStyle:
              "-webkit-line-clamp: unset; max-height: none; height: auto; overflow: visible;",
            grandStyle:
              "-webkit-line-clamp: unset; max-height: none; height: auto; overflow: visible;",
          },
        ]),
      });
    });

    await context.route(
      "https://translate.googleapis.com/translate_a/single?**",
      async (route) => {
        const url = new URL(route.request().url());
        const text = url.searchParams.get("q") || "";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            sentences: [{ trans: `译文：${text.slice(0, 36)}` }],
            src: "en",
          }),
        });
      }
    );

    await context.route(
      "https://x.com/garrytan/status/0000000000000000000",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: fakeArticleCardHtml,
        })
    );

    const page = await context.newPage();
    await page.goto("https://x.com/garrytan/status/0000000000000000000");

    const cardTextBlocks = page.locator(
      '[role="link"] [data-testid="article-cover-image"] ~ div div[dir="auto"]'
    );
    await expect(cardTextBlocks).toHaveCount(2);
    await expect(
      cardTextBlocks.nth(0).locator("kiss-translator")
    ).toContainText("The AI Agent Complexity Ratchet", { timeout: 15000 });
    await expect(
      cardTextBlocks.nth(1).locator("kiss-translator")
    ).toContainText("I've been coding with AI", { timeout: 15000 });
    expect(await getChildSequence(cardTextBlocks.nth(0))).toEqual([
      expect.objectContaining({
        nodeName: "SPAN",
        text: expect.stringContaining("The AI Agent Complexity Ratchet"),
      }),
      expect.objectContaining({
        nodeName: "KISS-TRANSLATOR",
        text: expect.stringContaining("The AI Agent Complexity Ratchet"),
      }),
    ]);
    expect(await getChildSequence(cardTextBlocks.nth(1))).toEqual([
      expect.objectContaining({
        nodeName: "SPAN",
        text: expect.stringContaining("I've been coding with AI"),
      }),
      expect.objectContaining({
        nodeName: "KISS-TRANSLATOR",
        text: expect.stringContaining("I've been coding with AI"),
      }),
    ]);
    expect(
      await getLeadingBreakCounts(cardTextBlocks.locator("kiss-translator"))
    ).toEqual([2, 2]);

    await expect(page.locator("[data-card-content]")).toHaveCSS(
      "overflow",
      "visible"
    );
    await expect(cardTextBlocks.nth(1)).toHaveCSS("overflow", "visible");
    await expect(cardTextBlocks.nth(1)).toHaveCSS("-webkit-line-clamp", "none");

    await expect(
      page.locator('[role="link"] [data-testid="article-cover-image"]')
    ).not.toContainText("译文");
  } finally {
    await context.close();
  }
});

test("translates X home timeline article cards without link wrapper", async () => {
  expect(fs.existsSync(path.join(extensionPath, "manifest.json"))).toBe(true);
  fs.rmSync(userDataDir, { recursive: true, force: true });

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

    await serviceWorker.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await chrome.storage.local.set({
        "KISS-Translator_setting_v2": JSON.stringify({
          transAllnow: true,
          langDetector: "-",
        }),
        "KISS-Translator_rules_v2": JSON.stringify([
          {
            pattern: "*",
            transOpen: "false",
            apiSlug: "Google",
            toLang: "zh-CN",
          },
          {
            pattern: "https://x.com",
            selector:
              "[data-testid='tweetText'], [data-testid='twitter-article-title'], [data-testid='UserDescription']",
            keepSelector: "img, svg, a, span:has(a), div:has(a)",
            transOpen: "true",
            apiSlug: "Google",
            autoScan: "false",
            splitParagraph: "split_textlength",
            splitLength: 10000,
            selectStyle:
              "-webkit-line-clamp: unset; max-height: none; height: auto; overflow: visible;",
            parentStyle:
              "-webkit-line-clamp: unset; max-height: none; height: auto; overflow: visible;",
            grandStyle:
              "-webkit-line-clamp: unset; max-height: none; height: auto; overflow: visible;",
          },
        ]),
      });
    });

    await context.route(
      "https://translate.googleapis.com/translate_a/single?**",
      async (route) => {
        const url = new URL(route.request().url());
        const text = url.searchParams.get("q") || "";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            sentences: [{ trans: `译文：${text.slice(0, 40)}` }],
            src: "en",
          }),
        });
      }
    );

    await context.route("https://x.com/home", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: fakeHomeArticleCardHtml,
      })
    );

    const page = await context.newPage();
    await page.goto("https://x.com/home");

    const homeCardTextBlocks = page.locator(
      '[data-testid="article-cover-image"] ~ div div[dir="auto"]'
    );
    await expect(homeCardTextBlocks).toHaveCount(2);
    await expect(
      homeCardTextBlocks.nth(0).locator("kiss-translator")
    ).toContainText("The 9 Claude Agents", { timeout: 15000 });
    await expect(
      homeCardTextBlocks.nth(1).locator("kiss-translator")
    ).toContainText("Every founder", { timeout: 15000 });
    expect(await getChildSequence(homeCardTextBlocks.nth(0))).toEqual([
      expect.objectContaining({
        nodeName: "SPAN",
        text: expect.stringContaining("The 9 Claude Agents"),
      }),
      expect.objectContaining({
        nodeName: "KISS-TRANSLATOR",
        text: expect.stringContaining("The 9 Claude Agents"),
      }),
    ]);
    expect(await getChildSequence(homeCardTextBlocks.nth(1))).toEqual([
      expect.objectContaining({
        nodeName: "SPAN",
        text: expect.stringContaining("Every founder"),
      }),
      expect.objectContaining({
        nodeName: "KISS-TRANSLATOR",
        text: expect.stringContaining("Every founder"),
      }),
    ]);
    expect(
      await getLeadingBreakCounts(homeCardTextBlocks.locator("kiss-translator"))
    ).toEqual([2, 2]);

    await expect(page.locator("[data-card-content]")).toHaveCSS(
      "overflow",
      "visible"
    );
    await expect(homeCardTextBlocks.nth(1)).toHaveCSS("overflow", "visible");
    await expect(homeCardTextBlocks.nth(1)).toHaveCSS(
      "-webkit-line-clamp",
      "none"
    );
  } finally {
    await context.close();
  }
});
