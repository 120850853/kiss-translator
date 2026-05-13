function createDebouncedRerunner({ delayMs, run }) {
  let timer = null;
  let disposed = false;
  let running = false;
  let rerunAfterCurrent = false;

  const invoke = async () => {
    if (disposed) {
      return;
    }

    if (running) {
      rerunAfterCurrent = true;
      return;
    }

    running = true;
    try {
      await run();
    } finally {
      running = false;
      if (rerunAfterCurrent && !disposed) {
        rerunAfterCurrent = false;
        requestRun();
      }
    }
  };

  const requestRun = () => {
    if (disposed) {
      return;
    }

    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      timer = null;
      void invoke();
    }, delayMs);
  };

  const dispose = () => {
    disposed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    requestRun,
    runNow: invoke,
    dispose,
  };
}

module.exports = {
  createDebouncedRerunner,
};
