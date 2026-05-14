const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("@playwright/test");

const repoRoot = path.resolve(__dirname, "..");
const extensionPath = path.join(repoRoot, "build/chrome");
const outputDir = path.join(repoRoot, ".tmp/real-x-check");
const userDataDir = path.join(repoRoot, ".tmp/real-x-snapshot-profile");
const defaultTargetUrls = [
  "https://x.com/home",
  "https://x.com/dotey/status/2054651679786914278",
];
const targetUrls = (process.env.REAL_X_URLS || process.env.REAL_X_URL || "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

function getTargetUrls() {
  return targetUrls.length > 0 ? targetUrls : defaultTargetUrls;
}

function slugForUrl(url) {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

function ensureBuildExists() {
  const manifestPath = path.join(extensionPath, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Built extension not found at ${manifestPath}. Run pnpm build:chrome first.`
    );
  }
}

function runOpenCli(args) {
  return execFileSync("opencli", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024,
  });
}

function parseOpenCliData(raw) {
  const parsed = JSON.parse(raw);
  return Object.prototype.hasOwnProperty.call(parsed, "data")
    ? parsed.data
    : parsed;
}

function captureXSnapshot(targetUrl) {
  fs.mkdirSync(outputDir, { recursive: true });
  const snapshotPath = path.join(
    outputDir,
    `${slugForUrl(targetUrl)}-opencli.html`
  );

  const openResult = parseOpenCliData(
    runOpenCli([
      "browser",
      "--session",
      "default",
      "--window",
      "foreground",
      "open",
      targetUrl,
    ])
  );
  const tab = openResult.page;
  if (!tab) {
    throw new Error(
      `OpenCLI did not return a page id: ${JSON.stringify(openResult)}`
    );
  }

  runOpenCli([
    "browser",
    "--session",
    "default",
    "--window",
    "foreground",
    "wait",
    "--tab",
    tab,
    "selector",
    '[data-testid="tweet"]',
  ]);
  runOpenCli([
    "browser",
    "--session",
    "default",
    "--window",
    "foreground",
    "wait",
    "--tab",
    tab,
    "time",
    "3",
  ]);

  const html = parseOpenCliData(
    runOpenCli([
      "browser",
      "--session",
      "default",
      "--window",
      "foreground",
      "eval",
      "--tab",
      tab,
      "document.documentElement.outerHTML",
    ])
  );

  if (!html.includes('data-testid="tweet"')) {
    throw new Error("Captured X snapshot does not contain tweet markup.");
  }

  const staticHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  fs.writeFileSync(snapshotPath, staticHtml);
  return { tab, snapshotPath };
}

async function waitForExtensionWorker(context) {
  let [serviceWorker] = context
    .serviceWorkers()
    .filter((worker) => worker.url().startsWith("chrome-extension://"));
  if (serviceWorker) return serviceWorker;

  serviceWorker = await context.waitForEvent("serviceworker", {
    predicate: (worker) => worker.url().startsWith("chrome-extension://"),
    timeout: 15000,
  });
  return serviceWorker;
}

async function configureExtension(context) {
  const serviceWorker = await waitForExtensionWorker(context);
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({
      "KISS-Translator_setting_v2": JSON.stringify({
        transAllnow: false,
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
}

async function analyzeTimeline(page, targetUrl) {
  return page.evaluate((url) => {
    const isStatusPage = /\/status\/\d+/.test(new URL(url).pathname);
    const paragraphCount = (text) =>
      text
        .split(/\n\s*\n/)
        .map((part) => part.trim())
        .filter(Boolean).length;

    const leadingBreakCount = (wrapper) => {
      let count = 0;
      for (const child of wrapper.childNodes) {
        if (child.nodeName !== "BR") break;
        count += 1;
      }
      return count;
    };

    const pairsForParent = (parent) => {
      const pairs = [];
      let origin = "";
      for (const child of parent.childNodes) {
        if (child.nodeName === "KISS-TRANSLATOR") {
          pairs.push({
            origin: origin.trim(),
            originParagraphs: paragraphCount(origin),
            translation: (child.textContent || "").trim(),
            leadingBreaks: leadingBreakCount(child),
          });
          origin = "";
          continue;
        }

        if (child.nodeName === "BR") {
          origin += "\n";
          continue;
        }

        origin += child.textContent || "";
      }
      return pairs;
    };

    return [...document.querySelectorAll('[data-testid="tweet"]')]
      .slice(0, 8)
      .map((tweet, index) => {
        const textBlock = tweet.querySelector('[data-testid="tweetText"]');
        if (!textBlock) {
          return { index, hasTextBlock: false };
        }

        const clone = textBlock.cloneNode(true);
        clone
          .querySelectorAll("kiss-translator")
          .forEach((node) => node.remove());
        const originText = clone.innerText || clone.textContent || "";
        const wrappers = [...textBlock.querySelectorAll("kiss-translator")];
        const wrapperParents = [
          ...new Set(wrappers.map((node) => node.parentNode)),
        ];
        const pairs = wrapperParents.flatMap((parent) =>
          pairsForParent(parent)
        );
        const hasShowMore = !!tweet.querySelector(
          '[data-testid="tweet-text-show-more-link"]'
        );
        const requiresFullTranslation = isStatusPage
          ? index === 0
          : !hasShowMore;
        const violations = [];

        pairs.forEach((pair, pairIndex) => {
          if (pair.originParagraphs > 1) {
            violations.push({
              type: "merged-paragraphs-before-one-translation",
              pairIndex,
              origin: pair.origin.slice(0, 240),
            });
          }
          if (pair.leadingBreaks < 2) {
            violations.push({
              type: "missing-blank-line-before-translation",
              pairIndex,
              leadingBreaks: pair.leadingBreaks,
            });
          }
        });

        const originParagraphs = paragraphCount(originText);
        if (
          requiresFullTranslation &&
          originParagraphs > 1 &&
          wrappers.length === 0
        ) {
          violations.push({
            type: "multi-paragraph-origin-not-translated",
            originParagraphs,
          });
        }

        if (
          requiresFullTranslation &&
          originParagraphs > 1 &&
          wrappers.length > 0 &&
          pairs.length < originParagraphs
        ) {
          violations.push({
            type: "fewer-translations-than-origin-paragraphs",
            originParagraphs,
            translationPairs: pairs.length,
          });
        }

        return {
          index,
          hasTextBlock: true,
          originPreview: originText.trim().slice(0, 360),
          originParagraphs,
          hasShowMore,
          requiresFullTranslation,
          wrapperCount: wrappers.length,
          pairs,
          violations,
        };
      });
  }, targetUrl);
}

async function checkTarget(targetUrl) {
  const snapshot = captureXSnapshot(targetUrl);
  fs.rmSync(userDataDir, { recursive: true, force: true });
  const snapshotSlug = slugForUrl(targetUrl);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  try {
    await configureExtension(context);
    await context.route(targetUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: fs.readFileSync(snapshot.snapshotPath, "utf8"),
      });
    });

    const page = context.pages()[0] || (await context.newPage());
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="tweet"]', { timeout: 30000 });

    await page.keyboard.press("Alt+Q");
    await page.waitForSelector("kiss-translator", { timeout: 60000 });
    await page.waitForTimeout(3000);

    const screenshotPath = path.join(
      outputDir,
      `${snapshotSlug}-after-altq.png`
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const analysis = await analyzeTimeline(page, targetUrl);
    const analysisPath = path.join(outputDir, `${snapshotSlug}-analysis.json`);
    fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));

    const violations = analysis.flatMap((tweet) =>
      (tweet.violations || []).map((violation) => ({
        tweetIndex: tweet.index,
        ...violation,
      }))
    );

    return {
      snapshotPath: snapshot.snapshotPath,
      targetUrl,
      opencliTab: snapshot.tab,
      userDataDir,
      screenshotPath,
      analysisPath,
      translatedTweets: analysis.filter((tweet) => tweet.wrapperCount > 0)
        .length,
      violations,
    };
  } finally {
    await context.close();
  }
}

async function main() {
  ensureBuildExists();

  const results = [];
  for (const targetUrl of getTargetUrls()) {
    results.push(await checkTarget(targetUrl));
  }

  console.log(JSON.stringify({ results }, null, 2));

  const violations = results.flatMap((result) =>
    result.violations.map((violation) => ({
      targetUrl: result.targetUrl,
      ...violation,
    }))
  );
  if (violations.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
