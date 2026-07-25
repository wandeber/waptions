import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseEnv, promisify } from 'node:util';
import { createIsolatedNextRun, removeIsolatedNextRun } from '../next-isolation.mjs';
import {
  createTerminationController,
  getTerminationExitCode,
  runTerminationAwareCleanup,
} from '../process-lifecycle.mjs';
import {
  buildArtifactPathRedactionVariants,
  buildReferenceServiceEnvironment,
  guardArtifactRootFailClosed,
  pipeRedactedChildOutput,
  redactSensitiveText,
} from './diarization-secret-artifacts.mjs';
import {
  createGenericNextRequestErrorReporter,
  spawnPlaywright,
  startIsolatedNextServer,
} from './playwright-runtime.mjs';

const execFileAsync = promisify(execFile);
const TEXT_EDITOR_PROFILE = process.env.WAPTIONS_E2E_SECURE_PROFILE === 'text-editor';
const PUBLIC_CALLER_PREFIX = TEXT_EDITOR_PROFILE
  ? 'WAPTIONS_E2E_TEXT_EDITOR'
  : 'WAPTIONS_E2E_DIARIZATION';
const SECURE_RUN_MARKER = TEXT_EDITOR_PROFILE
  ? 'waptions-secure-text-editor-v1'
  : 'waptions-secure-diarization-v1';
const LIVE_SPEC = TEXT_EDITOR_PROFILE
  ? 'e2e/text-editor.live.spec.ts'
  : 'e2e/transcription-diarization.live.spec.ts';
const OLD_CALLER_VARIABLES = [
  'WAPTIONS_E2E_DIARIZATION_ENDPOINT',
  'WAPTIONS_E2E_DIARIZATION_API_KEY',
];
const REQUIRED_CALLER_VARIABLES = [
  'WAPTIONS_E2E_DIARIZATION_REFERENCE_REPO',
  'WAPTIONS_E2E_DIARIZATION_MODEL',
  'WAPTIONS_E2E_DIARIZATION_MEDIA',
];
const CHILD_CREDENTIAL_VARIABLES = [
  'ASR_API_KEY',
  'WHISPER_API_KEY',
  'WAPTIONS_E2E_DIARIZATION_API_KEY',
  'WAPTIONS_E2E_DIARIZATION_API_KEY_SHA256',
  'AUTHORIZATION',
  'HTTP_AUTHORIZATION',
  'HF_TOKEN',
  'HUGGING_FACE_HUB_TOKEN',
  'ASR_DIARIZATION_SETUP_HF_TOKEN',
];
const termination = createTerminationController({ processGroup: true });

let apiProcess;
let playwrightProcess;
let nextRun;
let nextServer;
let apiEndpoint;
let ephemeralKey;
let artifactRoot;
let artifactOutputPaths = [];
let browserTemporaryRoot;
let referenceRepository;
let initialReferenceStatus;
let waptionsRepository;
let initialWaptionsStatus;
let playwrightPassed = false;
let failureMessage;

try {
  const caller = readCallerConfiguration(process.env);
  const validated = await validateCallerConfiguration(caller);
  throwIfTerminationRequested();
  waptionsRepository = await realpath(process.cwd());
  initialWaptionsStatus = await readGitStatus(waptionsRepository);
  referenceRepository = validated.referenceRepository;
  initialReferenceStatus = await readGitStatus(referenceRepository);
  if (initialReferenceStatus !== '') {
    throw new Error(`${publicCallerVariable('REFERENCE_REPO')} must be a clean checkout.`);
  }

  let templateEnvironment;
  try {
    templateEnvironment = parseEnv(await readFile(validated.templatePath, 'utf8'));
  } catch {
    throw new Error(`${publicCallerVariable('REFERENCE_TEMPLATE')} could not be parsed safely.`);
  }
  throwIfTerminationRequested();

  // Remove inherited credential aliases from this runner before Next.js is prepared. The fresh
  // credential remains a lexical value and is never installed in the runner/Next environment.
  CHILD_CREDENTIAL_VARIABLES.forEach((name) => delete process.env[name]);
  ephemeralKey = randomBytes(32).toString('base64url');
  const keyDigest = createHash('sha256').update(ephemeralKey, 'utf8').digest('hex');
  artifactRoot = await mkdtemp(path.join(
    tmpdir(),
    TEXT_EDITOR_PROFILE ? 'waptions-text-editor-live-' : 'waptions-diarization-live-',
  ));
  // Seed the raw path before canonical expansion: even a realpath failure must be safe to report.
  artifactOutputPaths = [artifactRoot];
  artifactOutputPaths = [...new Set([
    ...artifactOutputPaths,
    ...await buildArtifactPathRedactionVariants(artifactRoot),
  ])];
  browserTemporaryRoot = path.join(artifactRoot, 'browser-temp');
  await mkdir(browserTemporaryRoot);
  throwIfTerminationRequested();

  const reservedPort = await reserveLoopbackPort();
  apiEndpoint = `http://localhost:${reservedPort.port}/v1/audio/transcriptions`;
  const apiEnvironment = buildReferenceServiceEnvironment({
    parentEnvironment: process.env,
    templateEnvironment,
    apiKey: ephemeralKey,
    host: 'localhost',
    port: reservedPort.port,
  });
  await reservedPort.release();

  apiProcess = await spawnManagedProcess({
    executable: validated.pythonPath,
    args: [
      '-m',
      'uvicorn',
      'whisper_api:app',
      '--app-dir',
      referenceRepository,
      '--host',
      'localhost',
      '--port',
      String(reservedPort.port),
    ],
    cwd: referenceRepository,
    environment: apiEnvironment,
    secret: ephemeralKey,
    artifactPaths: artifactOutputPaths,
    label: 'reference service',
  });
  if (termination.requestedSignal) {
    signalManagedProcess(apiProcess, termination.requestedSignal);
    throwIfTerminationRequested();
  }
  await waitForReferenceReadiness({
    endpoint: apiEndpoint,
    apiKey: ephemeralKey,
    model: caller.model,
    processRecord: apiProcess,
    requireDiarization: !TEXT_EDITOR_PROFILE,
  });
  throwIfTerminationRequested();

  nextRun = await createIsolatedNextRun(
    TEXT_EDITOR_PROFILE ? 'playwright-text-editor-live' : 'playwright-diarization',
  );
  throwIfTerminationRequested();
  const outputDir = path.join(artifactRoot, 'test-results');
  const reportDir = path.join(artifactRoot, 'playwright-report');
  nextServer = await startIsolatedNextServer(nextRun, outputDir, reportDir, {
    requestErrorReporter: createGenericNextRequestErrorReporter(),
  });
  throwIfTerminationRequested();

  const playwrightEnvironment = { ...process.env };
  CHILD_CREDENTIAL_VARIABLES.forEach((name) => delete playwrightEnvironment[name]);
  const scenarioEnvironment = TEXT_EDITOR_PROFILE ? {
    WAPTIONS_E2E_TEXT_EDITOR_SECURE_RUN: SECURE_RUN_MARKER,
    WAPTIONS_E2E_TEXT_EDITOR_ENDPOINT: apiEndpoint,
    WAPTIONS_E2E_TEXT_EDITOR_API_KEY: ephemeralKey,
    WAPTIONS_E2E_TEXT_EDITOR_API_KEY_SHA256: keyDigest,
    WAPTIONS_E2E_TEXT_EDITOR_MEDIA: validated.mediaPath,
  } : {
    WAPTIONS_E2E_DIARIZATION_SECURE_RUN: SECURE_RUN_MARKER,
    WAPTIONS_E2E_DIARIZATION_ENDPOINT: apiEndpoint,
    WAPTIONS_E2E_DIARIZATION_API_KEY: ephemeralKey,
    WAPTIONS_E2E_DIARIZATION_API_KEY_SHA256: keyDigest,
    WAPTIONS_E2E_DIARIZATION_MODEL: caller.model,
    WAPTIONS_E2E_DIARIZATION_MEDIA: validated.mediaPath,
  };
  Object.assign(playwrightEnvironment, {
    WAPTIONS_E2E_PORT: String(nextServer.port),
    ...scenarioEnvironment,
    // Playwright browser profiles can serialize localStorage. Keep them under the invocation root
    // so the exact-secret scanner covers them before the root is retained or purged.
    TMPDIR: browserTemporaryRoot,
    TMP: browserTemporaryRoot,
    TEMP: browserTemporaryRoot,
    // Playwright 1.60 creates this accessibility snapshot independently of trace/screenshots.
    PLAYWRIGHT_NO_COPY_PROMPT: '1',
  });
  playwrightProcess = await spawnManagedPlaywright({
    args: [LIVE_SPEC, '--reporter=line'],
    environment: playwrightEnvironment,
    secret: ephemeralKey,
    artifactPaths: artifactOutputPaths,
    terminationController: termination,
  });
  const playwrightResult = await playwrightProcess.exit;
  await playwrightProcess.outputCompletion;
  playwrightProcess = undefined;
  throwIfTerminationRequested();
  if (playwrightResult.signal || playwrightResult.code !== 0) {
    throw new Error('The secure live Playwright scenario failed.');
  }
  playwrightPassed = true;
} catch (error) {
  failureMessage = safeFailureMessage(error, ephemeralKey, artifactOutputPaths);
} finally {
  await runTerminationAwareCleanup(termination, async () => {
    let ownedProcessesStopped = true;
    try {
      if (playwrightProcess) {
        const stopped = await stopManagedProcess(playwrightProcess);
        const outputClosed = await waitForCompletionBounded(playwrightProcess.outputCompletion);
        ownedProcessesStopped = stopped && outputClosed && ownedProcessesStopped;
      }
    } catch {
      ownedProcessesStopped = false;
      failureMessage ??= 'The secure live Playwright process did not stop cleanly.';
    }
    try {
      await nextServer?.close();
    } catch {
      failureMessage ??= 'The isolated Waptions server did not stop cleanly.';
    }
    try {
      if (nextRun) await removeIsolatedNextRun(nextRun);
    } catch {
      failureMessage ??= 'The isolated Waptions compiler state could not be removed.';
    }
    try {
      if (!TEXT_EDITOR_PROFILE && apiProcess && apiEndpoint && ephemeralKey) {
        await waitForNoActiveDiarization(apiEndpoint, ephemeralKey, apiProcess);
      }
    } catch {
      failureMessage ??= 'The fresh reference service did not become idle before shutdown.';
    }
    try {
      if (apiProcess) {
        const stopped = await stopManagedProcess(apiProcess);
        const outputClosed = await waitForCompletionBounded(apiProcess.outputCompletion);
        ownedProcessesStopped = stopped && outputClosed && ownedProcessesStopped;
      }
    } catch {
      ownedProcessesStopped = false;
      failureMessage ??= 'The fresh reference service did not stop cleanly.';
    }
    try {
      if (referenceRepository && initialReferenceStatus !== undefined) {
        const finalReferenceStatus = await readGitStatus(referenceRepository);
        if (finalReferenceStatus !== initialReferenceStatus) {
          failureMessage ??= 'The reference checkout gained tracked or untracked changes.';
        }
      }
    } catch {
      failureMessage ??= 'The reference checkout could not be revalidated after the run.';
    }
    try {
      if (waptionsRepository && initialWaptionsStatus !== undefined) {
        const finalWaptionsStatus = await readGitStatus(waptionsRepository);
        if (finalWaptionsStatus !== initialWaptionsStatus) {
          failureMessage ??= 'The Waptions checkout changed outside the invocation baseline.';
        }
      }
    } catch {
      failureMessage ??= 'The Waptions checkout could not be revalidated after the run.';
    }

    if (artifactRoot && ephemeralKey && !ownedProcessesStopped) {
      const purged = await purgeArtifactRootBestEffort(artifactRoot);
      failureMessage = purged
        ? 'An owned child did not stop within the deadline; artifacts were purged.'
        : 'An owned child did not stop within the deadline and artifact cleanup was incomplete.';
      artifactRoot = undefined;
    } else if (artifactRoot && ephemeralKey) {
      const guarded = await guardArtifactRootFailClosed({
        root: artifactRoot,
        secret: ephemeralKey,
        playwrightPassed: playwrightPassed && !failureMessage && !termination.requestedSignal,
      });
      if (guarded.reason === 'artifact-security-failure') {
        failureMessage = guarded.cleanupIncomplete
          ? 'Live E2E artifact inspection failed and best-effort cleanup was incomplete.'
          : 'Live E2E artifacts failed credential containment and were purged.';
        artifactRoot = undefined;
      } else if (guarded.retained) {
        try {
          // The browser profile was scanned, but it is never useful as a retained diagnostic.
          if (browserTemporaryRoot) {
            await rm(browserTemporaryRoot, { recursive: true, force: true });
          }
        } catch {
          let purged = false;
          try {
            await rm(artifactRoot, { recursive: true, force: true });
            purged = true;
          } catch {
            // Never expose the root or OS error when even best-effort purge cannot complete.
          }
          failureMessage = purged
            ? 'The transient browser profile could not be removed; artifacts were purged.'
            : 'The transient browser profile could not be removed and cleanup was incomplete.';
          artifactRoot = undefined;
        }
        if (artifactRoot) {
          // Print only after a complete clean inspection and browser-profile removal.
          process.stderr.write(`Clean failed-run artifacts retained at ${artifactRoot}\n`);
        }
      } else {
        artifactRoot = undefined;
      }
    }
  });
}

if (termination.requestedSignal) {
  process.exitCode = getTerminationExitCode(termination.requestedSignal);
} else if (failureMessage) {
  process.stderr.write(`${failureMessage}\n`);
  process.exitCode = 1;
}

// Next.js can retain development watcher handles after app.close(); every owned resource is now
// stopped and scanned, so terminate this short-lived runner explicitly like the generic wrapper.
process.exit(process.exitCode ?? 0);

function readCallerConfiguration(environment) {
  const forbidden = OLD_CALLER_VARIABLES.filter((name) => Object.prototype.hasOwnProperty.call(environment, name));
  if (forbidden.length > 0) {
    throw new Error(`Remove unsupported caller variable(s): ${forbidden.join(', ')}.`);
  }
  const missing = REQUIRED_CALLER_VARIABLES.filter((name) => !environment[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required live E2E variable(s): ${missing.join(', ')}.`);
  }
  return {
    referenceRepository: environment.WAPTIONS_E2E_DIARIZATION_REFERENCE_REPO,
    template: environment.WAPTIONS_E2E_DIARIZATION_REFERENCE_TEMPLATE,
    python: environment.WAPTIONS_E2E_DIARIZATION_REFERENCE_PYTHON,
    model: environment.WAPTIONS_E2E_DIARIZATION_MODEL,
    media: environment.WAPTIONS_E2E_DIARIZATION_MEDIA,
  };
}

async function validateCallerConfiguration(caller) {
  if (!path.isAbsolute(caller.referenceRepository)) {
    throw new Error(`${publicCallerVariable('REFERENCE_REPO')} must be an absolute path.`);
  }
  const referenceRepository = await realpath(caller.referenceRepository).catch(() => {
    throw new Error(`${publicCallerVariable('REFERENCE_REPO')} is unavailable.`);
  });
  const referenceStats = await lstat(referenceRepository);
  if (!referenceStats.isDirectory()) {
    throw new Error(`${publicCallerVariable('REFERENCE_REPO')} must identify a checkout directory.`);
  }
  const gitTopLevel = await runGit(referenceRepository, ['rev-parse', '--show-toplevel'], 'reference checkout');
  if (await realpath(gitTopLevel.trim()) !== referenceRepository) {
    throw new Error(`${publicCallerVariable('REFERENCE_REPO')} must identify the checkout root.`);
  }

  const requestedTemplate = caller.template ?? path.join(referenceRepository, '.env.apple.example');
  if (caller.template && !path.isAbsolute(caller.template)) {
    throw new Error(`${publicCallerVariable('REFERENCE_TEMPLATE')} must be an absolute path.`);
  }
  if (path.basename(requestedTemplate) === '.env') {
    throw new Error(`${publicCallerVariable('REFERENCE_TEMPLATE')} cannot select .env.`);
  }
  const templatePath = await realpath(requestedTemplate).catch(() => {
    throw new Error(`${publicCallerVariable('REFERENCE_TEMPLATE')} is unavailable.`);
  });
  if (path.basename(templatePath) === '.env') {
    throw new Error(`${publicCallerVariable('REFERENCE_TEMPLATE')} cannot resolve to .env.`);
  }
  if (!isInside(referenceRepository, templatePath)) {
    throw new Error(`${publicCallerVariable('REFERENCE_TEMPLATE')} must stay inside the reference checkout.`);
  }
  const templateRelativePath = path.relative(referenceRepository, templatePath);
  await runGit(referenceRepository, ['ls-files', '--error-unmatch', '--', templateRelativePath], 'tracked template');

  const defaultPython = process.platform === 'win32'
    ? path.join(referenceRepository, '.venv', 'Scripts', 'python.exe')
    : path.join(referenceRepository, '.venv', 'bin', 'python');
  const requestedPython = caller.python ?? defaultPython;
  if (!path.isAbsolute(requestedPython)) {
    throw new Error(`${publicCallerVariable('REFERENCE_PYTHON')} must be an absolute path.`);
  }
  // Keep the validated launcher path for spawn. Canonicalizing `.venv/bin/python` to its Homebrew
  // target discards Python's symlink-based virtualenv prefix detection and loses venv packages.
  const pythonPath = path.resolve(requestedPython);
  const resolvedPythonTarget = await realpath(pythonPath).catch(() => {
    throw new Error(`${publicCallerVariable('REFERENCE_PYTHON')} is unavailable.`);
  });
  const resolvedPythonStats = await lstat(resolvedPythonTarget);
  if (!resolvedPythonStats.isFile()) {
    throw new Error(`${publicCallerVariable('REFERENCE_PYTHON')} must resolve to a file.`);
  }
  await access(pythonPath, process.platform === 'win32' ? fsConstants.R_OK : fsConstants.X_OK).catch(() => {
    throw new Error(`${publicCallerVariable('REFERENCE_PYTHON')} is not executable.`);
  });

  if (!path.isAbsolute(caller.media)) {
    throw new Error(`${publicCallerVariable('MEDIA')} must be an absolute path.`);
  }
  const mediaPath = await realpath(caller.media).catch(() => {
    throw new Error(`${publicCallerVariable('MEDIA')} is unavailable.`);
  });
  const mediaStats = await lstat(mediaPath);
  if (!mediaStats.isFile()) {
    throw new Error(`${publicCallerVariable('MEDIA')} must identify a regular file.`);
  }
  await access(mediaPath, fsConstants.R_OK).catch(() => {
    throw new Error(`${publicCallerVariable('MEDIA')} is not readable.`);
  });
  const waptionsRepository = await realpath(process.cwd());
  if (isInside(referenceRepository, mediaPath) || isInside(waptionsRepository, mediaPath)) {
    throw new Error(`${publicCallerVariable('MEDIA')} must resolve outside both repositories.`);
  }

  return { referenceRepository, templatePath, pythonPath, mediaPath };
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, 'localhost', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not reserve a reference-service port.');
  }
  return {
    port: address.port,
    release: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function spawnManagedProcess({
  executable,
  args,
  cwd,
  environment,
  secret,
  artifactPaths,
  label,
}) {
  const child = spawn(executable, args, {
    cwd,
    env: environment,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = createManagedProcessRecord(child, secret, artifactPaths);
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => reject(new Error(`The ${label} could not start.`)));
  });
  return record;
}

async function spawnManagedPlaywright({
  args,
  environment,
  secret,
  artifactPaths,
  terminationController,
}) {
  const child = spawnPlaywright({ args, environment, stdio: ['ignore', 'pipe', 'pipe'] });
  // Adopt immediately: a signal received during spawn is remembered and forwarded as soon as the
  // detached Playwright process group has a PID.
  const terminationExit = terminationController.waitForChild(child);
  void terminationExit.catch(() => undefined);
  const record = createManagedProcessRecord(child, secret, artifactPaths, terminationExit);
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => reject(new Error('The secure Playwright process could not start.')));
  });
  return record;
}

function createManagedProcessRecord(child, secret, artifactPaths, selectedExit) {
  const record = {
    child,
    exited: false,
    exit: undefined,
    outputCompletion: Promise.all([
      pipeRedactedChildOutput(child.stdout, secret, process.stdout, { artifactPaths }),
      pipeRedactedChildOutput(child.stderr, secret, process.stderr, { artifactPaths }),
    ]),
  };
  const rawExit = selectedExit ?? new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  record.exit = rawExit.then((result) => {
    record.exited = true;
    return result;
  });
  return record;
}

async function waitForReferenceReadiness({
  endpoint,
  apiKey,
  model,
  processRecord,
  requireDiarization,
}) {
  const baseUrl = new URL(endpoint);
  baseUrl.pathname = '/healthz';
  baseUrl.search = '';
  const modelsUrl = new URL('/v1/models', baseUrl);
  const deadline = Date.now() + 120_000;
  let lastFailedField = 'reachability';
  while (Date.now() < deadline) {
    throwIfTerminationRequested();
    if (processRecord.exited) throw new Error('The fresh reference service exited before readiness.');
    const health = await fetchAuthenticatedJson(baseUrl, apiKey);
    if (health) {
      lastFailedField = requireDiarization ? readFailedHealthField(health) ?? '' : readFailedServiceField(health) ?? '';
      if (!lastFailedField) {
        const models = await fetchAuthenticatedJson(modelsUrl, apiKey);
        if (models && Array.isArray(models.data)
          && models.data.some((entry) => entry && typeof entry === 'object' && entry.id === model)) {
          return;
        }
        lastFailedField = 'requested_model';
      }
    }
    await delay(250);
  }
  throw new Error(`Reference readiness failed at ${lastFailedField}.`);
}

function readFailedServiceField(health) {
  return health && typeof health === 'object' && health.status === 'ok' ? null : 'status';
}

function readFailedHealthField(health) {
  if (!health || typeof health !== 'object' || health.status !== 'ok') {
    return 'status';
  }
  const diarization = health.diarization;
  if (!diarization || typeof diarization !== 'object') {
    return 'diarization';
  }
  const checks = [
    ['enabled', diarization.enabled === true],
    ['runtime_available', diarization.runtime_available === true],
    ['model_available', diarization.model_available === true],
    ['ready', diarization.ready === true],
    ['state', diarization.state === 'ready' || diarization.state === 'loaded'],
  ];
  const failed = checks.find(([, passed]) => !passed);
  return failed?.[0] ?? null;
}

async function waitForNoActiveDiarization(endpoint, apiKey, processRecord) {
  if (processRecord.exited) return;
  const healthUrl = new URL(endpoint);
  healthUrl.pathname = '/healthz';
  healthUrl.search = '';
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !processRecord.exited) {
    const health = await fetchAuthenticatedJson(healthUrl, apiKey);
    if (health?.diarization?.active_runs === 0) return;
    await delay(250);
  }
  if (!processRecord.exited) throw new Error('The owned diarization job remained active past cleanup deadline.');
}

async function fetchAuthenticatedJson(url, apiKey) {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function stopManagedProcess(record) {
  if (record.exited) {
    await record.exit;
    return true;
  }
  signalManagedProcess(record, 'SIGTERM');
  const graceful = await Promise.race([
    record.exit.then(() => true),
    delay(5_000).then(() => false),
  ]);
  if (!graceful && !record.exited) {
    signalManagedProcess(record, 'SIGKILL');
    return Promise.race([
      record.exit.then(() => true),
      delay(5_000).then(() => false),
    ]);
  }
  return true;
}

function signalManagedProcess(record, signal) {
  if (!record?.child?.pid || record.exited) return;
  try {
    if (process.platform === 'win32') record.child.kill(signal);
    else process.kill(-record.child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH' && error?.code !== 'EPERM') throw error;
  }
}

async function readGitStatus(repository) {
  return runGit(repository, ['status', '--porcelain', '--untracked-files=all'], 'reference status');
}

async function runGit(repository, args, condition) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repository, ...args], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    throw new Error(`Could not validate ${condition}.`);
  }
}

function isInside(root, candidate) {
  const relativePath = path.relative(root, candidate);
  return relativePath === ''
    || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath));
}

function publicCallerVariable(suffix) {
  return `${PUBLIC_CALLER_PREFIX}_${suffix}`;
}

function safeFailureMessage(error, secret, artifactPaths) {
  const fallback = 'The secure live E2E runner failed.';
  if (!(error instanceof Error)) return fallback;
  const message = error.message || fallback;
  if (!secret) return message;
  return redactSensitiveText(message, { secret, artifactPaths });
}

function throwIfTerminationRequested() {
  if (termination.requestedSignal) throw new Error('The secure live E2E was cancelled.');
}

async function purgeArtifactRootBestEffort(root) {
  try {
    await rm(root, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function waitForCompletionBounded(completion) {
  return Promise.race([
    completion.then(() => true, () => false),
    delay(5_000).then(() => false),
  ]);
}

// The runner executes through top-level await before reaching this source position. A declaration
// is deliberately hoisted so startup/readiness and cleanup can both sleep during that execution.
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
