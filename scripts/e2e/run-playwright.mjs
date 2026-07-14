import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import process from 'node:process';
import { createIsolatedNextRun, removeIsolatedNextRun } from '../next-isolation.mjs';
import {
  createTerminationController,
  getTerminationExitCode,
  runTerminationAwareCleanup,
} from '../process-lifecycle.mjs';

const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/**
 * Binds the HTTP socket before preparing Next.js, so the operating system's free-port allocation
 * remains reserved for the full run. Keeping the custom dev server in this wrapper also gives
 * signal cleanup direct ownership instead of relying on Playwright to reap a nested server process.
 */
async function startIsolatedNextServer(run, outputDir, reportDir) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, 'localhost', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not resolve the isolated Playwright server port.');
  }

  const port = address.port;
  Object.assign(process.env, {
    AUTH_SECRET: process.env.AUTH_SECRET ?? 'playwright-local-auth-secret',
    WAPTIONS_E2E_PORT: String(port),
    WAPTIONS_E2E_RUN_ID: run.runId,
    WAPTIONS_E2E_OUTPUT_DIR: outputDir,
    WAPTIONS_E2E_REPORT_DIR: reportDir,
    WAPTIONS_NEXT_DIST_DIR: run.distDir,
    WAPTIONS_TSCONFIG_PATH: run.tsconfigPath,
  });

  let app;
  try {
    const next = (await import('next')).default;
    app = next({ dev: true, dir: process.cwd(), hostname: 'localhost', port });
    await app.prepare();
    const requestHandler = app.getRequestHandler();
    const upgradeHandler = app.getUpgradeHandler();
    server.on('request', (request, response) => {
      void requestHandler(request, response).catch((error) => {
        console.error('The isolated Next.js request handler failed.', error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    server.on('upgrade', (request, socket, head) => {
      void upgradeHandler(request, socket, head).catch(() => socket.destroy());
    });
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    await app?.close();
    throw error;
  }

  return {
    port,
    async close() {
      try {
        await app.close();
      } finally {
        // Closing the HTTP listener is independent from Next.js watcher teardown. If Next rejects
        // while disposing its internals, still release the reserved port before propagating that
        // error to the wrapper's outer cleanup.
        await new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    },
  };
}

const termination = createTerminationController({ processGroup: true });
let run;
let nextServer;

try {
  run = await createIsolatedNextRun('playwright');
  const outputDir = `test-results/${run.runId}`;
  const reportDir = `playwright-report/${run.runId}`;
  if (!termination.requestedSignal) {
    nextServer = await startIsolatedNextServer(run, outputDir, reportDir);
  }

  if (termination.requestedSignal) {
    process.exitCode = getTerminationExitCode(termination.requestedSignal);
  } else {
    const child = spawn(
      pnpmExecutable,
      ['exec', 'playwright', 'test', ...process.argv.slice(2)],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WAPTIONS_E2E_PORT: String(nextServer.port),
        },
        stdio: 'inherit',
        // A separate POSIX process group lets signal cleanup terminate PNPM, Playwright, and the
        // managed Next.js server before removing compiler output. Windows retains normal spawning.
        detached: process.platform !== 'win32',
      },
    );
    const result = await termination.waitForChild(child);
    if (termination.requestedSignal) {
      process.exitCode = getTerminationExitCode(termination.requestedSignal);
    } else if (result.signal) {
      throw new Error(`Playwright ended from signal ${result.signal}.`);
    } else if (result.code !== 0) {
      process.exitCode = result.code ?? 1;
    }
  }
} finally {
  await runTerminationAwareCleanup(termination, async () => {
    // Reports and failure artifacts intentionally remain available. Only the invocation-owned
    // Next.js compiler output and temporary tsconfig are disposable.
    try {
      await nextServer?.close();
    } finally {
      // A Next.js or socket shutdown failure must never strand generated compiler state. Keep the
      // run cleanup in a separate finally so its deletion guarantee does not depend on teardown.
      if (run) await removeIsolatedNextRun(run);
    }
  });
}

// Next.js development internals retain watcher handles after `app.close()`. All owned resources
// are already closed above, so terminate the short-lived wrapper explicitly instead of leaving a
// completed package script resident in the developer's process table.
process.exit(process.exitCode ?? 0);
