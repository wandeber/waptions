import process from 'node:process';
import { createIsolatedNextRun, removeIsolatedNextRun } from '../next-isolation.mjs';
import { spawnPlaywright, startIsolatedNextServer } from './playwright-runtime.mjs';
import {
  createTerminationController,
  getTerminationExitCode,
  runTerminationAwareCleanup,
} from '../process-lifecycle.mjs';

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
    const child = spawnPlaywright({
      args: process.argv.slice(2),
      environment: {
        ...process.env,
        WAPTIONS_E2E_PORT: String(nextServer.port),
      },
    });
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
