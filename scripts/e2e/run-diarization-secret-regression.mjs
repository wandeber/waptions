import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import JSZip from 'jszip';
import {
  createTerminationController,
  getTerminationExitCode,
  runTerminationAwareCleanup,
} from '../process-lifecycle.mjs';
import {
  ARTIFACT_PATH_REDACTION,
  assertControlledFailureCompleted,
  buildArtifactPathRedactionVariants,
  guardArtifactRootFailClosed,
  pipeRedactedChildOutput,
  redactSensitiveText,
  scanArtifactTree,
} from './diarization-secret-artifacts.mjs';

const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const fixtureConfig = path.join(
  process.cwd(),
  'scripts/e2e/fixtures/diarization-secret-regression.config.mjs',
);

const termination = createTerminationController({ processGroup: true });
let sentinel;
let artifactRoot;
let artifactOutputPaths = [];
let injectedRoot;
let fixtureServer;
let child;
let outputCompletion;
let failureMessage;

try {
  throwIfTerminationRequested();
  sentinel = randomBytes(32).toString('base64url');
  artifactRoot = await mkdtemp(path.join(tmpdir(), 'waptions-diarization-security-'));
  // Keep the original path protected even if canonical/relative variant discovery itself fails.
  artifactOutputPaths = [artifactRoot];
  artifactOutputPaths = [...new Set([
    ...artifactOutputPaths,
    ...await buildArtifactPathRedactionVariants(artifactRoot),
  ])];
  const browserTemporaryRoot = path.join(artifactRoot, 'browser-temp');
  await mkdir(browserTemporaryRoot);
  throwIfTerminationRequested();
  fixtureServer = await startFixtureServer();
  throwIfTerminationRequested();
  child = spawn(
    pnpmExecutable,
    ['exec', 'playwright', 'test', '--config', fixtureConfig],
    {
      cwd: process.cwd(),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WAPTIONS_SECURITY_FIXTURE_SENTINEL: sentinel,
        WAPTIONS_SECURITY_FIXTURE_BASE_URL: `http://localhost:${fixtureServer.port}`,
        WAPTIONS_SECURITY_FIXTURE_OUTPUT_DIR: path.join(artifactRoot, 'test-results'),
        WAPTIONS_SECURITY_FIXTURE_REPORT_DIR: path.join(artifactRoot, 'playwright-report'),
        // Browser profiles can contain localStorage and form state. Redirect every conventional
        // temporary-directory variable so these residuals stay inside the scanned artifact root.
        TMPDIR: browserTemporaryRoot,
        TMP: browserTemporaryRoot,
        TEMP: browserTemporaryRoot,
        // Playwright 1.60 creates an AI-oriented accessibility snapshot on failure independently
        // from trace/screenshot/video. Disable that diagnostic because it can serialize form state.
        PLAYWRIGHT_NO_COPY_PROMPT: '1',
      },
    },
  );
  // Adopt immediately so a signal received during spawn is forwarded to the detached group as
  // soon as the child PID exists. A pending preparation-phase signal is forwarded here too.
  const childResult = termination.waitForChild(child);
  const capturedStdout = createCapturingDestination(process.stdout);
  const capturedStderr = createCapturingDestination(process.stderr);
  outputCompletion = Promise.all([
    pipeRedactedChildOutput(child.stdout, sentinel, capturedStdout, { artifactPaths: artifactOutputPaths }),
    pipeRedactedChildOutput(child.stderr, sentinel, capturedStderr, { artifactPaths: artifactOutputPaths }),
  ]);
  const result = await childResult;
  await outputCompletion;
  child = undefined;
  outputCompletion = undefined;
  throwIfTerminationRequested();
  const capturedOuterOutput = Buffer.concat([
    ...capturedStdout.chunks,
    ...capturedStderr.chunks,
  ]).toString('utf8');
  assertControlledFailureCompleted({ ...result, output: capturedOuterOutput });
  if (artifactOutputPaths.some((value) => capturedOuterOutput.includes(value))) {
    throw new Error('Controlled child output exposed its artifact root before inspection.');
  }
  if (!capturedOuterOutput.includes(ARTIFACT_PATH_REDACTION)) {
    throw new Error('The controlled failure did not exercise artifact-path output redaction.');
  }

  const guardedFailure = await guardArtifactRootFailClosed({
    root: artifactRoot,
    secret: sentinel,
    playwrightPassed: false,
  });
  if (!guardedFailure.retained || guardedFailure.cleanupIncomplete) {
    artifactRoot = undefined;
    throw new Error('Artifact containment rejected the controlled failure output.');
  }
  const independentInspection = await scanArtifactTree(artifactRoot, sentinel);
  if (!independentInspection.clean) {
    throw new Error('Independent artifact inspection rejected the controlled failure output.');
  }
  await rm(artifactRoot, { recursive: true, force: true });
  artifactRoot = undefined;

  injectedRoot = await mkdtemp(path.join(tmpdir(), 'waptions-diarization-injected-leak-'));
  const archive = new JSZip();
  archive.file('future-reporter-output.txt', sentinel);
  await writeFile(path.join(injectedRoot, 'report.zip'), await archive.generateAsync({ type: 'nodebuffer' }));
  const injectedGuard = await guardArtifactRootFailClosed({
    root: injectedRoot,
    secret: sentinel,
    playwrightPassed: true,
  });
  if (!injectedGuard.purged || injectedGuard.reason !== 'artifact-security-failure') {
    if (await purgeRootBestEffort(injectedRoot)) injectedRoot = undefined;
    throw new Error('The injected artifact leak did not trigger fail-closed purge.');
  }
  try {
    await stat(injectedRoot);
    throw new Error('The injected artifact root still exists after fail-closed purge.');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error('The injected artifact root could not be verified after purge.');
    }
  }
  injectedRoot = undefined;
} catch (error) {
  failureMessage = safeFailureMessage(error);
} finally {
  await runTerminationAwareCleanup(termination, async () => {
    let childStopped = true;
    if (child) {
      try {
        childStopped = await stopChild(child);
      } catch {
        childStopped = false;
        failureMessage ??= 'The controlled Playwright process did not stop cleanly.';
      }
    }
    if (outputCompletion) {
      const outputClosed = await Promise.race([
        outputCompletion.then(() => true, () => false),
        delay(5_000).then(() => false),
      ]);
      childStopped = childStopped && outputClosed;
    }
    try {
      await fixtureServer?.close();
    } catch {
      failureMessage ??= 'The controlled fixture server did not stop cleanly.';
    }

    if (artifactRoot) {
      if (childStopped && sentinel) {
        const guarded = await guardArtifactRootFailClosed({
          root: artifactRoot,
          secret: sentinel,
          playwrightPassed: false,
        });
        if (guarded.retained) {
          const purged = await purgeRootBestEffort(artifactRoot);
          if (!purged) failureMessage ??= 'Controlled artifact cleanup was incomplete.';
        } else if (guarded.cleanupIncomplete) {
          failureMessage ??= 'Controlled artifact cleanup was incomplete.';
        }
      } else {
        const purged = await purgeRootBestEffort(artifactRoot);
        if (!purged) failureMessage ??= 'Controlled artifact cleanup was incomplete.';
      }
      artifactRoot = undefined;
    }
    if (injectedRoot) {
      const purged = await purgeRootBestEffort(injectedRoot);
      if (!purged) failureMessage ??= 'Injected artifact cleanup was incomplete.';
      injectedRoot = undefined;
    }
  });
}

if (termination.requestedSignal) {
  process.exitCode = getTerminationExitCode(termination.requestedSignal);
} else if (failureMessage) {
  process.stderr.write(`${failureMessage}\n`);
  process.exitCode = 1;
}

process.exit(process.exitCode ?? 0);

async function startFixtureServer() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><label>Ephemeral API key<input type="password"></label>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, 'localhost', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not allocate the controlled fixture port.');
  }
  return {
    port: address.port,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function stopChild(activeChild) {
  if (!activeChild.pid || activeChild.exitCode !== null || activeChild.signalCode !== null) return true;
  const exit = new Promise((resolve) => activeChild.once('close', () => resolve(true)));
  signalChildTree(activeChild, 'SIGTERM');
  const graceful = await Promise.race([exit, delay(5_000).then(() => false)]);
  if (graceful) return true;
  signalChildTree(activeChild, 'SIGKILL');
  return Promise.race([exit, delay(5_000).then(() => false)]);
}

function signalChildTree(activeChild, signal) {
  try {
    if (process.platform === 'win32') activeChild.kill(signal);
    else process.kill(-activeChild.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH' && error?.code !== 'EPERM') throw error;
  }
}

function createCapturingDestination(destination) {
  const chunks = [];
  return {
    chunks,
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return destination.write(chunk);
    },
  };
}

function throwIfTerminationRequested() {
  if (termination.requestedSignal) {
    throw new Error('The controlled artifact-security regression was cancelled.');
  }
}

function safeFailureMessage(error) {
  const fallback = 'The controlled artifact-security regression failed.';
  if (!(error instanceof Error)) return fallback;
  if (!sentinel) return error.message || fallback;
  return redactSensitiveText(error.message || fallback, {
    secret: sentinel,
    artifactPaths: artifactOutputPaths,
  });
}

async function purgeRootBestEffort(root) {
  try {
    await rm(root, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
