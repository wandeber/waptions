import { spawn } from 'node:child_process';
import process from 'node:process';
import { createIsolatedNextRun, removeIsolatedNextRun } from './next-isolation.mjs';
import {
  createTerminationController,
  getTerminationExitCode,
  runTerminationAwareCleanup,
} from './process-lifecycle.mjs';

const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const termination = createTerminationController({ processGroup: true });
let run;

async function runBuild() {
  if (!run) throw new Error('The isolated build was not initialized.');
  const child = spawn(pnpmExecutable, ['exec', 'next', 'build'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WAPTIONS_NEXT_DIST_DIR: run.distDir,
      WAPTIONS_TSCONFIG_PATH: run.tsconfigPath,
    },
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });
  const result = await termination.waitForChild(child);
  if (termination.requestedSignal) {
    process.exitCode = getTerminationExitCode(termination.requestedSignal);
  } else if (result.signal) {
    throw new Error(`The isolated Next.js build ended from signal ${result.signal}.`);
  } else if (result.code !== 0) {
    process.exitCode = result.code ?? 1;
  }
}

try {
  run = await createIsolatedNextRun('verify-build');
  if (termination.requestedSignal) {
    process.exitCode = getTerminationExitCode(termination.requestedSignal);
  } else {
    await runBuild();
  }
} finally {
  await runTerminationAwareCleanup(termination, async () => {
    // Verification only needs the build result. Removing it prevents repeated local gates from
    // accumulating another complete production tree beside the developer-owned `.next` output.
    if (run) await removeIsolatedNextRun(run);
  });
}
