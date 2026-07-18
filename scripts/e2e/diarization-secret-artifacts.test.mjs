import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import {
  ARTIFACT_PATH_REDACTION,
  CONTROLLED_FAILURE_MARKER,
  assertControlledFailureCompleted,
  buildArtifactPathRedactionVariants,
  buildReferenceServiceEnvironment,
  createExactSecretRedactor,
  createSensitiveOutputRedactor,
  guardArtifactRoot,
  guardArtifactRootFailClosed,
  redactSensitiveText,
  sanitizeTemplateEnvironment,
  scanArtifactTree,
} from './diarization-secret-artifacts.mjs';
import {
  createGenericNextRequestErrorReporter,
  defaultNextRequestErrorReporter,
} from './playwright-runtime.mjs';

const sentinel = () => randomBytes(32).toString('base64url');
const temporaryRoot = () => mkdtemp(path.join(tmpdir(), 'waptions-secret-guard-test-'));

test('rejects legacy caller credentials without echoing their value', () => {
  const secret = sentinel();
  const environment = { ...process.env };
  delete environment.WAPTIONS_E2E_DIARIZATION_API_KEY;
  environment.WAPTIONS_E2E_DIARIZATION_ENDPOINT = secret;
  const result = spawnSync(process.execPath, ['scripts/e2e/run-diarization-live.mjs'], {
    cwd: process.cwd(),
    env: environment,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /WAPTIONS_E2E_DIARIZATION_ENDPOINT/u);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(result.stdout.includes(secret), false);
});

test('installs termination handling before allocation and adopts secure Playwright children', async () => {
  const [liveRunner, securityRunner] = await Promise.all([
    readFile('scripts/e2e/run-diarization-live.mjs', 'utf8'),
    readFile('scripts/e2e/run-diarization-secret-regression.mjs', 'utf8'),
  ]);
  for (const source of [liveRunner, securityRunner]) {
    const controllerIndex = source.indexOf('const termination = createTerminationController');
    const allocationIndex = source.indexOf('await mkdtemp(');
    const seedIndex = source.indexOf('artifactOutputPaths = [artifactRoot]');
    const variantIndex = source.indexOf('await buildArtifactPathRedactionVariants(artifactRoot)');
    assert.ok(controllerIndex >= 0 && controllerIndex < allocationIndex);
    assert.ok(allocationIndex < seedIndex && seedIndex < variantIndex);
    assert.match(source, /termination(?:Controller)?\.waitForChild\(child\)/u);
  }
});

test('redacts the raw artifact root when canonical variant discovery fails', async () => {
  const secret = sentinel();
  const rawRoot = path.join(tmpdir(), `missing-artifact-root-${sentinel()}`);
  const artifactPaths = [rawRoot];
  let variantError;
  try {
    await buildArtifactPathRedactionVariants(rawRoot);
  } catch (error) {
    variantError = error;
  }
  assert.ok(variantError instanceof Error);
  const rendered = redactSensitiveText(variantError.message, { secret, artifactPaths });
  assert.equal(rendered.includes(rawRoot), false);
  assert.equal(rendered.includes(ARTIFACT_PATH_REDACTION), true);
});

test('keeps normal Next request diagnostics and makes secure diagnostics generic', () => {
  const secret = sentinel();
  const artifactRoot = '/private/tmp/waptions-sensitive-artifact-root';
  const error = new Error(`Request failed with ${secret} at ${artifactRoot}`);
  const normalCalls = [];
  defaultNextRequestErrorReporter(error, (...args) => normalCalls.push(args));
  assert.equal(normalCalls.length, 1);
  assert.equal(normalCalls[0][0], 'The isolated Next.js request handler failed.');
  assert.equal(normalCalls[0][1], error);

  let secureOutput = '';
  const secureReporter = createGenericNextRequestErrorReporter((message) => {
    secureOutput += message;
  });
  secureReporter(error);
  assert.equal(secureOutput, 'The isolated Next.js request handler failed.\n');
  assert.equal(secureOutput.includes(secret), false);
  assert.equal(secureOutput.includes(artifactRoot), false);
});

test('preserves a venv symlink launcher and reaches readiness without an initialization failure', {
  skip: process.platform === 'win32' ? 'The fixture executable uses a POSIX shebang.' : false,
}, async (context) => {
  const runnerSource = await readFile('scripts/e2e/run-diarization-live.mjs', 'utf8');
  assert.match(runnerSource, /function delay\(milliseconds\)/u);
  assert.doesNotMatch(runnerSource, /const delay\s*=/u);

  const root = await temporaryRoot();
  context.after(() => rm(root, { recursive: true, force: true }));
  const referenceRepository = path.join(root, 'reference-service');
  const mediaPath = path.join(root, 'two-speaker-fixture.wav');
  const invocationMarkerPath = path.join(root, 'invoked-python-path.txt');
  const pythonFixtureTarget = path.join(referenceRepository, 'fixture-python-target');
  const pythonFixture = path.join(referenceRepository, '.venv', 'bin', 'python');
  await mkdir(referenceRepository);
  await mkdir(path.dirname(pythonFixture), { recursive: true });
  await writeFile(path.join(referenceRepository, '.env.apple.example'), [
    'ASR_DEFAULT_MODEL=fixture-model',
    `WAPTIONS_E2E_PYTHON_PATH_MARKER=${invocationMarkerPath}`,
    '',
  ].join('\n'));
  await writeFile(mediaPath, 'controlled external media placeholder');
  await writeFile(
    pythonFixtureTarget,
    [
      '#!/bin/sh',
      'printf "%s" "$0" > "$WAPTIONS_E2E_PYTHON_PATH_MARKER"',
      'sleep 0.75',
      '',
    ].join('\n'),
  );
  await chmod(pythonFixtureTarget, 0o755);
  await symlink(path.relative(path.dirname(pythonFixture), pythonFixtureTarget), pythonFixture);
  initializeCleanGitFixture(referenceRepository);

  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !name.startsWith('WAPTIONS_E2E_DIARIZATION_')
  )));
  Object.assign(environment, {
    WAPTIONS_E2E_DIARIZATION_REFERENCE_REPO: referenceRepository,
    WAPTIONS_E2E_DIARIZATION_MODEL: 'fixture-model',
    WAPTIONS_E2E_DIARIZATION_MEDIA: mediaPath,
  });
  const result = spawnSync(process.execPath, ['scripts/e2e/run-diarization-live.mjs'], {
    cwd: process.cwd(),
    env: environment,
    encoding: 'utf8',
    timeout: 10_000,
  });
  const retainedRootMatch = result.stderr.match(/Clean failed-run artifacts retained at (.+)$/mu);
  if (retainedRootMatch) {
    // The runner intentionally retains a clean failed-run root; this preflight owns and removes it.
    await rm(retainedRootMatch[1], { recursive: true, force: true });
  }

  assert.equal(result.status, 1);
  assert.equal(result.error, undefined);
  assert.doesNotMatch(result.stderr, /Cannot access 'delay' before initialization/u);
  // Managed sandboxes can prohibit even localhost listeners. The source assertion above still
  // guards hoisting there; ordinary developer/CI hosts additionally exercise the real poll loop.
  if (/listen (?:EPERM|EACCES):/u.test(result.stderr)) return;
  const invokedPythonPath = await readFile(invocationMarkerPath, 'utf8');
  const expectedLauncherPath = path.join(
    await realpath(referenceRepository),
    '.venv',
    'bin',
    'python',
  );
  assert.equal(invokedPythonPath, expectedLauncherPath);
  assert.notEqual(invokedPythonPath, await realpath(pythonFixtureTarget));
  assert.match(result.stderr, /fresh reference service exited before readiness/iu);
});

test('sanitizes inherited and template credentials and applies the generated key last', () => {
  const generatedKey = sentinel();
  const sanitized = sanitizeTemplateEnvironment({
    ASR_DEFAULT_MODEL: 'test-model',
    ASR_API_KEY: 'template-key',
    HF_TOKEN: 'template-token',
    DATABASE_PASSWORD: 'template-password',
    AUTHORIZATION: 'template-authorization',
    COMPACT_APIKEY: 'compact-template-key',
    OAUTH_CLIENT: 'template-auth-field',
  });
  assert.deepEqual(sanitized, { ASR_DEFAULT_MODEL: 'test-model' });

  const environment = buildReferenceServiceEnvironment({
    parentEnvironment: {
      PATH: '/safe/bin',
      Path: 'C:\\safe-bin',
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      ASR_API_KEY: 'parent-key',
      CLOUD_SECRET: 'parent-secret',
    },
    templateEnvironment: {
      ASR_DEFAULT_MODEL: 'test-model',
      ASR_API_HOST: 'template-host',
      ASR_API_PORT: '1111',
      ASR_API_KEY: 'template-key',
      WHISPER_API_KEY: 'legacy-key',
    },
    apiKey: generatedKey,
    host: 'localhost',
    port: 43210,
  });

  assert.equal(environment.ASR_API_KEY, generatedKey);
  assert.equal(environment.ASR_API_HOST, 'localhost');
  assert.equal(environment.ASR_API_PORT, '43210');
  assert.equal(environment.ASR_DEFAULT_MODEL, 'test-model');
  assert.equal(environment.Path, 'C:\\safe-bin');
  assert.equal(environment.SystemRoot, 'C:\\Windows');
  assert.equal(environment.ComSpec, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(environment.WHISPER_API_KEY, undefined);
  assert.equal(environment.CLOUD_SECRET, undefined);
});

test('redacts a sentinel split across arbitrary child-output chunks', () => {
  const secret = sentinel();
  const output = [];
  const redactor = createExactSecretRedactor(secret, (chunk) => output.push(chunk));
  redactor.write(Buffer.from(`before:${secret.slice(0, 7)}`));
  redactor.write(Buffer.from(secret.slice(7, 19)));
  redactor.write(Buffer.from(`${secret.slice(19)}:after`));
  redactor.end();
  const rendered = Buffer.concat(output).toString('utf8');
  assert.equal(rendered, 'before:[REDACTED]:after');
  assert.equal(rendered.includes(secret), false);
});

test('redacts an artifact-root path split across child-output chunks', () => {
  const secret = sentinel();
  const artifactRoot = '/private/var/tmp/waptions-diarization-live-controlled';
  const shorterAlias = artifactRoot.slice('/private'.length);
  const output = [];
  const redactor = createSensitiveOutputRedactor(
    { secret, artifactPaths: [shorterAlias, artifactRoot] },
    (chunk) => output.push(chunk),
  );
  redactor.write(Buffer.from(`Error Context: ${artifactRoot.slice(0, 13)}`));
  redactor.write(Buffer.from(artifactRoot.slice(13, 31)));
  redactor.write(Buffer.from(`${artifactRoot.slice(31)}/test-results/error-context.md`));
  redactor.end();

  const rendered = Buffer.concat(output).toString('utf8');
  assert.equal(rendered, `Error Context: ${ARTIFACT_PATH_REDACTION}/test-results/error-context.md`);
  assert.equal(rendered.includes(artifactRoot), false);
  assert.equal(rendered.includes(shorterAlias), false);
});

test('rejects a Playwright failure that happens before the controlled completion marker', () => {
  assert.throws(
    () => assertControlledFailureCompleted({
      code: 1,
      signal: null,
      output: 'Error: an earlier setup failure',
    }),
    /did not reach its completion marker/u,
  );
  assert.doesNotThrow(() => assertControlledFailureCompleted({
    code: 1,
    signal: null,
    output: `Error: ${CONTROLLED_FAILURE_MARKER}`,
  }));
});

test('fails closed on injected scan/removal errors without exposing the artifact root', async () => {
  const secret = sentinel();
  const scanFailureRoot = await temporaryRoot();
  const scanFailure = await guardArtifactRootFailClosed({
    root: scanFailureRoot,
    secret,
    playwrightPassed: false,
  }, {
    scan: async () => {
      throw new Error(`Injected scan failure at ${scanFailureRoot}`);
    },
    remove: (root) => rm(root, { recursive: true, force: true }),
  });
  assert.deepEqual(scanFailure, {
    ok: false,
    purged: true,
    retained: false,
    reason: 'artifact-security-failure',
    cleanupIncomplete: false,
  });
  assert.equal(JSON.stringify(scanFailure).includes(scanFailureRoot), false);
  await assert.rejects(stat(scanFailureRoot));

  const removalFailureRoot = await temporaryRoot();
  const removalFailure = await guardArtifactRootFailClosed({
    root: removalFailureRoot,
    secret,
    playwrightPassed: true,
  }, {
    scan: async () => ({ clean: true, found: false, complete: true }),
    remove: async () => {
      throw new Error(`Injected removal failure at ${removalFailureRoot}`);
    },
  });
  assert.equal(removalFailure.cleanupIncomplete, true);
  assert.equal(JSON.stringify(removalFailure).includes(removalFailureRoot), false);
  const redactedMessage = redactSensitiveText(
    `Failure at ${removalFailureRoot} with ${secret}`,
    { secret, artifactPaths: [removalFailureRoot] },
  );
  assert.equal(redactedMessage, `Failure at ${ARTIFACT_PATH_REDACTION} with [REDACTED]`);
  await rm(removalFailureRoot, { recursive: true, force: true });
});

test('detects exact sentinels in plain files, ZIP entries, and nested ZIP entries', async (context) => {
  const root = await temporaryRoot();
  context.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }));
  });
  const secret = sentinel();
  await writeFile(path.join(root, 'plain.txt'), `prefix-${secret}-suffix`);
  assert.deepEqual(await scanArtifactTree(root, secret), { clean: false, found: true, complete: true });

  await writeFile(path.join(root, 'plain.txt'), 'clean');
  const nested = new JSZip();
  nested.file('nested.txt', secret);
  const outer = new JSZip();
  outer.file('clean.txt', 'clean');
  outer.file('nested.data', await nested.generateAsync({ type: 'nodebuffer' }));
  await writeFile(path.join(root, 'report.bin'), await outer.generateAsync({ type: 'nodebuffer' }));
  assert.deepEqual(await scanArtifactTree(root, secret), { clean: false, found: true, complete: true });
});

test('fails closed for malformed archives and purges an injected leak without exposing it', async () => {
  const malformedRoot = await temporaryRoot();
  const secret = sentinel();
  await writeFile(path.join(malformedRoot, 'broken.zip'), Buffer.from('PK\x03\x04not-a-valid-archive'));
  assert.deepEqual(await scanArtifactTree(malformedRoot, secret), { clean: false, found: false, complete: false });
  const malformedGuard = await guardArtifactRoot({
    root: malformedRoot,
    secret,
    playwrightPassed: false,
  });
  assert.deepEqual(malformedGuard, {
    ok: false,
    purged: true,
    retained: false,
    reason: 'artifact-security-failure',
  });
  await assert.rejects(stat(malformedRoot));
  assert.equal(JSON.stringify(malformedGuard).includes(secret), false);

  const unsupportedRoot = await temporaryRoot();
  await writeFile(path.join(unsupportedRoot, 'future-report.gz'), Buffer.from('clean'));
  assert.deepEqual(await scanArtifactTree(unsupportedRoot, secret), { clean: false, found: false, complete: false });
  await guardArtifactRoot({ root: unsupportedRoot, secret, playwrightPassed: false });

  const leakedRoot = await temporaryRoot();
  await mkdir(path.join(leakedRoot, 'nested'));
  await writeFile(path.join(leakedRoot, 'nested', 'artifact.txt'), secret);
  const leakGuard = await guardArtifactRoot({ root: leakedRoot, secret, playwrightPassed: true });
  assert.equal(leakGuard.reason, 'artifact-security-failure');
  assert.equal(leakGuard.purged, true);
  await assert.rejects(stat(leakedRoot));
  assert.equal(JSON.stringify(leakGuard).includes(secret), false);
});

test('purges clean success and retains only a clean failed invocation', async () => {
  const secret = sentinel();
  const successRoot = await temporaryRoot();
  await writeFile(path.join(successRoot, 'result.txt'), 'clean');
  const success = await guardArtifactRoot({ root: successRoot, secret, playwrightPassed: true });
  assert.deepEqual(success, { ok: true, purged: true, retained: false, reason: 'clean-success' });
  await assert.rejects(stat(successRoot));

  const failureRoot = await temporaryRoot();
  await writeFile(path.join(failureRoot, 'result.txt'), 'clean');
  const failure = await guardArtifactRoot({ root: failureRoot, secret, playwrightPassed: false });
  assert.deepEqual(failure, { ok: false, purged: false, retained: true, reason: 'playwright-failed' });
  assert.equal((await readFile(path.join(failureRoot, 'result.txt'), 'utf8')), 'clean');
  await import('node:fs/promises').then(({ rm }) => rm(failureRoot, { recursive: true, force: true }));
});

function initializeCleanGitFixture(repository) {
  const commands = [
    ['init', '--quiet'],
    ['config', 'user.email', 'e2e-fixture@example.invalid'],
    ['config', 'user.name', 'Waptions E2E fixture'],
    ['add', '.'],
    ['commit', '--quiet', '-m', 'Create controlled reference fixture'],
  ];
  for (const args of commands) {
    const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
}
