import process from 'node:process';

const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM'];
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

/**
 * Keeps the wrapper alive long enough to stop its child and remove invocation-owned compiler
 * output. Node's default signal handling exits immediately, which bypasses surrounding `finally`
 * blocks and leaves large ignored trees behind after UI/debug sessions.
 */
export function createTerminationController({ processGroup = false } = {}) {
  let requestedSignal;
  let child;
  let forceKillTimer;

  const signalChildTree = (signal) => {
    if (!child?.pid) return;
    if (processGroup && process.platform !== 'win32') {
      try {
        // Wrappers spawn PNPM as a detached process-group leader, so the signal also reaches
        // Playwright/Next descendants that could otherwise recreate files after cleanup.
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error?.code !== 'ESRCH' && error?.code !== 'EPERM') throw error;
      }
      return;
    }
    child.kill(signal);
  };
  const waitForProcessGroupExit = async (processGroupId) => {
    if (!processGroup || process.platform === 'win32') return;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        process.kill(-processGroupId, 0);
      } catch (error) {
        if (error?.code === 'ESRCH') return;
        // macOS can transiently report EPERM while a terminating group is being reaped. Treat it
        // as still alive and keep waiting; the next probe resolves to ESRCH once teardown finishes.
        if (error?.code !== 'EPERM') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    try {
      process.kill(-processGroupId, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH' && error?.code !== 'EPERM') throw error;
    }
  };

  const forwardSignal = () => {
    if (!requestedSignal || !child) return;
    signalChildTree(requestedSignal);
    forceKillTimer ??= setTimeout(() => {
      if (child) signalChildTree('SIGKILL');
    }, 5_000);
    forceKillTimer.unref();
  };
  const handlers = new Map(TERMINATION_SIGNALS.map((signal) => [signal, () => {
    requestedSignal ??= signal;
    forwardSignal();
  }]));
  handlers.forEach((handler, signal) => process.on(signal, handler));

  return {
    get requestedSignal() {
      return requestedSignal;
    },
    async waitForChild(nextChild) {
      child = nextChild;
      const processGroupId = nextChild.pid;
      forwardSignal();
      const result = await new Promise((resolve, reject) => {
        nextChild.once('error', reject);
        nextChild.once('close', (code, signal) => resolve({ code, signal }));
      });
      if (requestedSignal && processGroupId) await waitForProcessGroupExit(processGroupId);
      child = undefined;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      forceKillTimer = undefined;
      return result;
    },
    dispose() {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      handlers.forEach((handler, signal) => process.off(signal, handler));
    },
  };
}

/** Maps handled POSIX termination to the conventional shell exit status. */
export function getTerminationExitCode(signal) {
  return SIGNAL_EXIT_CODES[signal] ?? 1;
}

/**
 * Runs invocation-owned cleanup before releasing the signal handlers.
 *
 * A signal can arrive after the child process exits but while an async Next.js/socket/directory
 * teardown is still running. Re-reading the controller after cleanup prevents that cancellation
 * from being reported as a successful command. When cancellation and cleanup failure coincide,
 * the conventional signal status wins because the caller explicitly requested termination.
 */
export async function runTerminationAwareCleanup(controller, cleanup) {
  let cleanupError;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }

  const requestedSignal = controller.requestedSignal;
  try {
    if (requestedSignal) process.exitCode = getTerminationExitCode(requestedSignal);
  } finally {
    controller.dispose();
  }

  if (!requestedSignal && cleanupError) throw cleanupError;
}
