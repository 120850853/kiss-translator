const { test, expect } = require("@playwright/test");
const { createDebouncedRerunner } = require("./dev-extension-runner-utils");

test("debounces rapid rebuild requests into one run", async () => {
  let runs = 0;
  const rerunner = createDebouncedRerunner({
    delayMs: 20,
    run: async () => {
      runs += 1;
    },
  });

  rerunner.requestRun();
  rerunner.requestRun();
  rerunner.requestRun();

  await new Promise((resolve) => setTimeout(resolve, 80));
  rerunner.dispose();

  expect(runs).toBe(1);
});

test("queues one follow-up run when a rebuild is requested during an active run", async () => {
  let resolveFirstRun;
  const runs = [];
  const rerunner = createDebouncedRerunner({
    delayMs: 10,
    run: async () => {
      runs.push(Date.now());
      if (runs.length === 1) {
        await new Promise((resolve) => {
          resolveFirstRun = resolve;
        });
      }
    },
  });

  rerunner.requestRun();
  await new Promise((resolve) => setTimeout(resolve, 30));
  rerunner.requestRun();

  expect(runs).toHaveLength(1);

  resolveFirstRun();
  await new Promise((resolve) => setTimeout(resolve, 50));
  rerunner.dispose();

  expect(runs).toHaveLength(2);
});

test("queues follow-up requests while an immediate run is active", async () => {
  let resolveFirstRun;
  const runs = [];
  const rerunner = createDebouncedRerunner({
    delayMs: 10,
    run: async () => {
      runs.push(Date.now());
      if (runs.length === 1) {
        await new Promise((resolve) => {
          resolveFirstRun = resolve;
        });
      }
    },
  });

  const initialRun = rerunner.runNow();
  await new Promise((resolve) => setTimeout(resolve, 10));
  rerunner.requestRun();

  expect(runs).toHaveLength(1);

  resolveFirstRun();
  await initialRun;
  await new Promise((resolve) => setTimeout(resolve, 50));
  rerunner.dispose();

  expect(runs).toHaveLength(2);
});
