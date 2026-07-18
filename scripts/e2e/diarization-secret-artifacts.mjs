import { createReadStream } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import JSZip from 'jszip';

const REDACTION = Buffer.from('[REDACTED]', 'utf8');
export const ARTIFACT_PATH_REDACTION = '[ARTIFACT_ROOT]';
export const CONTROLLED_FAILURE_MARKER = 'WAPTIONS_CONTROLLED_SECRET_STORED_FAILURE_V1';
const ARTIFACT_PATH_REDACTION_BYTES = Buffer.from(ARTIFACT_PATH_REDACTION, 'utf8');
const DEFAULT_SCAN_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_DEPTH = 3;

const PLATFORM_ENVIRONMENT_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'LD_LIBRARY_PATH',
  'DYLD_LIBRARY_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'CUDA_HOME',
  'CUDA_PATH',
  'CUDA_VISIBLE_DEVICES',
  'HIP_VISIBLE_DEVICES',
  'ROCR_VISIBLE_DEVICES',
  'OMP_NUM_THREADS',
  'MKL_NUM_THREADS',
  'PYTORCH_ENABLE_MPS_FALLBACK',
  'PYTORCH_MPS_HIGH_WATERMARK_RATIO',
]);

// Public templates are treated conservatively: compact aliases such as APIKEY or OAUTH_TOKEN are
// credentials too. False positives only remove an optional child variable; false negatives could
// copy a persistent credential into the fresh service process.
const CREDENTIAL_NAME_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|AUTH/iu;
const UNSUPPORTED_ARCHIVE_EXTENSIONS = new Set([
  '.7z',
  '.br',
  '.bz2',
  '.cab',
  '.gz',
  '.lz',
  '.lz4',
  '.rar',
  '.tar',
  '.tgz',
  '.xz',
  '.zst',
]);

/** Removes credentials from a public environment template without guessing whether values look secret. */
export function sanitizeTemplateEnvironment(templateEnvironment) {
  return Object.fromEntries(Object.entries(templateEnvironment).filter(([name]) => (
    !CREDENTIAL_NAME_PATTERN.test(name)
  )));
}

/**
 * Builds the reference API child environment from a narrow platform allowlist and a sanitized
 * tracked template. Final host, port, and key assignment happens after every merge so neither the
 * parent process nor a future public-template field can override the invocation credential.
 */
export function buildReferenceServiceEnvironment({
  parentEnvironment,
  templateEnvironment,
  apiKey,
  host,
  port,
}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('The reference service requires an invocation API key.');
  }
  const environment = Object.fromEntries(Object.entries(parentEnvironment).filter(([name, value]) => (
    PLATFORM_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase())
      && typeof value === 'string'
      && value.length > 0
  )));
  Object.assign(environment, sanitizeTemplateEnvironment(templateEnvironment));

  // These aliases are deleted explicitly even though the sanitizer currently catches them. The
  // defensive deletion keeps the final-wins rule obvious if credential matching changes later.
  [
    'ASR_API_KEY',
    'WHISPER_API_KEY',
    'WAPTIONS_E2E_DIARIZATION_API_KEY',
    'AUTHORIZATION',
    'HTTP_AUTHORIZATION',
    'HF_TOKEN',
    'HUGGING_FACE_HUB_TOKEN',
    'ASR_DIARIZATION_SETUP_HF_TOKEN',
  ].forEach((name) => delete environment[name]);

  return {
    ...environment,
    PYTHONUNBUFFERED: '1',
    ASR_API_HOST: host,
    ASR_API_PORT: String(port),
    ASR_API_KEY: apiKey,
  };
}

/**
 * Creates a byte-oriented exact-secret redactor. It retains secretLength - 1 bytes between writes,
 * which is the minimum overlap that can detect a credential split at any child-output boundary.
 */
export function createExactSecretRedactor(secret, writeRedacted) {
  return createExactByteRedactor(secret, REDACTION, writeRedacted);
}

/**
 * Redacts the ephemeral credential and every known artifact-root spelling as one streaming chain.
 * Longer path spellings run before shorter aliases so `/private/var/...` cannot be partially
 * transformed as `/private[ARTIFACT_ROOT]` by an embedded `/var/...` alias.
 */
export function createSensitiveOutputRedactor({ secret, artifactPaths = [] }, writeRedacted) {
  const uniqueArtifactPaths = [...new Set(artifactPaths.filter((value) => (
    typeof value === 'string' && value.length > 0
  )))].sort((left, right) => right.length - left.length);
  const patterns = [
    { value: secret, replacement: REDACTION },
    ...uniqueArtifactPaths.map((value) => ({
      value,
      replacement: ARTIFACT_PATH_REDACTION_BYTES,
    })),
  ];
  const stages = new Array(patterns.length);
  let downstream = writeRedacted;
  for (let index = patterns.length - 1; index >= 0; index -= 1) {
    const pattern = patterns[index];
    const stage = createExactByteRedactor(pattern.value, pattern.replacement, downstream);
    stages[index] = stage;
    downstream = (chunk) => stage.write(chunk);
  }
  return {
    write(chunk) {
      stages[0].write(chunk);
    },
    end() {
      // Flush upstream first because each stage can still write its retained tail downstream.
      stages.forEach((stage) => stage.end());
    },
  };
}

/** Applies the same exact-value policy to a runner-originated error before it reaches stderr. */
export function redactSensitiveText(text, { secret, artifactPaths = [] }) {
  const output = [];
  const redactor = createSensitiveOutputRedactor(
    { secret, artifactPaths },
    (chunk) => output.push(chunk),
  );
  redactor.write(Buffer.from(String(text), 'utf8'));
  redactor.end();
  return Buffer.concat(output).toString('utf8');
}

/** Returns absolute, canonical, relative, and separator-normalized spellings child tools may log. */
export async function buildArtifactPathRedactionVariants(root, cwd = process.cwd()) {
  const canonicalRoot = await realpath(root);
  const baseVariants = [
    root,
    canonicalRoot,
    path.relative(cwd, root),
    path.relative(cwd, canonicalRoot),
  ].filter((value) => value && value !== '.');
  return [...new Set(baseVariants.flatMap((value) => [
    value,
    value.replaceAll('\\', '/'),
    value.replaceAll('/', '\\'),
  ]))].filter((value) => value.length > 0);
}

/** Accepts only the intentional post-storage Playwright failure, never an arbitrary nonzero exit. */
export function assertControlledFailureCompleted({ code, signal, output }) {
  if (code === 0 || signal || !output.includes(CONTROLLED_FAILURE_MARKER)) {
    throw new Error('The controlled Playwright fixture did not reach its completion marker.');
  }
}

function createExactByteRedactor(exactValue, replacement, writeRedacted) {
  const exactBytes = Buffer.isBuffer(exactValue) ? exactValue : Buffer.from(exactValue, 'utf8');
  if (exactBytes.length === 0) throw new Error('Output redaction requires a non-empty exact value.');
  let pending = Buffer.alloc(0);
  let ended = false;

  const emit = (value) => {
    if (value.length > 0) writeRedacted(value);
  };
  const process = (flush) => {
    const safeStartLimit = flush
      ? pending.length
      : Math.max(0, pending.length - exactBytes.length + 1);
    let cursor = 0;
    let searchFrom = 0;
    while (searchFrom < safeStartLimit) {
      const match = pending.indexOf(exactBytes, searchFrom);
      if (match < 0 || match >= safeStartLimit) break;
      emit(pending.subarray(cursor, match));
      emit(replacement);
      cursor = match + exactBytes.length;
      searchFrom = cursor;
    }
    const emitUntil = flush ? pending.length : Math.max(cursor, safeStartLimit);
    emit(pending.subarray(cursor, emitUntil));
    pending = pending.subarray(emitUntil);
  };

  return {
    write(chunk) {
      if (ended) throw new Error('Cannot write child output after redaction ended.');
      pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      process(false);
    },
    end() {
      if (ended) return;
      ended = true;
      process(true);
    },
  };
}

/** Pipes child output through exact secret/path redaction without creating an unguarded file. */
export function pipeRedactedChildOutput(stream, secret, destination, { artifactPaths = [] } = {}) {
  const redactor = createSensitiveOutputRedactor(
    { secret, artifactPaths },
    (chunk) => destination.write(chunk),
  );
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => redactor.write(chunk));
    stream.once('error', reject);
    stream.once('end', () => {
      redactor.end();
      resolve();
    });
  });
}

/** Scans every raw file and every decompressed ZIP entry under an invocation-owned artifact root. */
export async function scanArtifactTree(root, secret, options = {}) {
  const secretBytes = normalizeSecret(secret);
  const limits = {
    scanChunkBytes: options.scanChunkBytes ?? DEFAULT_SCAN_CHUNK_BYTES,
    maxArchiveBytes: options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES,
    maxEntryBytes: options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
    maxExpandedBytes: options.maxExpandedBytes ?? DEFAULT_MAX_EXPANDED_BYTES,
    maxArchiveDepth: options.maxArchiveDepth ?? DEFAULT_MAX_ARCHIVE_DEPTH,
  };
  const state = { expandedBytes: 0 };

  try {
    const rootStats = await lstat(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return inspectionFailure();
    const outcome = await scanDirectory(root, secretBytes, limits, state);
    return outcome ?? cleanInspection();
  } catch {
    return inspectionFailure();
  }
}

/**
 * Applies the production retention policy. A leak or incomplete inspection always purges and
 * fails. Clean success purges; only a clean Playwright failure may retain the temporary root.
 */
export async function guardArtifactRoot(args) {
  return applyArtifactRootPolicy(args, {
    scan: scanArtifactTree,
    remove: removeArtifactRoot,
  });
}

/**
 * Protects runner cleanup from inspection/removal exceptions. It retries one best-effort purge and
 * returns only a generic disposition, so callers never need to serialize a filesystem exception.
 */
export async function guardArtifactRootFailClosed(args, operations = {}) {
  const selectedOperations = {
    scan: operations.scan ?? scanArtifactTree,
    remove: operations.remove ?? removeArtifactRoot,
  };
  try {
    return await applyArtifactRootPolicy(args, selectedOperations);
  } catch {
    let purged = false;
    try {
      await selectedOperations.remove(args.root);
      purged = true;
    } catch {
      // The generic result records incomplete cleanup without exposing the path or OS error.
    }
    return {
      ok: false,
      purged,
      retained: false,
      reason: 'artifact-security-failure',
      cleanupIncomplete: !purged,
    };
  }
}

async function applyArtifactRootPolicy(
  { root, secret, playwrightPassed, scanOptions },
  operations,
) {
  const inspection = await operations.scan(root, secret, scanOptions);
  if (!inspection.clean) {
    await operations.remove(root);
    return {
      ok: false,
      purged: true,
      retained: false,
      reason: 'artifact-security-failure',
    };
  }
  if (playwrightPassed) {
    await operations.remove(root);
    return { ok: true, purged: true, retained: false, reason: 'clean-success' };
  }
  return { ok: false, purged: false, retained: true, reason: 'playwright-failed' };
}

const removeArtifactRoot = (root) => rm(root, { recursive: true, force: true });

async function scanDirectory(directory, secretBytes, limits, state) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (Buffer.from(entry.name, 'utf8').indexOf(secretBytes) >= 0) return leakInspection();
    const entryPath = path.join(directory, entry.name);
    const stats = await lstat(entryPath);
    if (stats.isSymbolicLink()) return inspectionFailure();
    if (stats.isDirectory()) {
      const nested = await scanDirectory(entryPath, secretBytes, limits, state);
      if (nested) return nested;
      continue;
    }
    if (!stats.isFile()) return inspectionFailure();
    if (await fileContainsBytes(entryPath, secretBytes, limits.scanChunkBytes)) return leakInspection();

    const archiveKind = await identifyArchiveFile(entryPath, entry.name);
    if (archiveKind === 'unsupported') return inspectionFailure();
    if (archiveKind === 'zip') {
      if (stats.size > limits.maxArchiveBytes) return inspectionFailure();
      const archiveBytes = await readFile(entryPath);
      const archiveOutcome = await scanZipBuffer(archiveBytes, secretBytes, limits, state, 0);
      if (archiveOutcome) return archiveOutcome;
    }
  }
  return null;
}

async function fileContainsBytes(filename, secretBytes, chunkSize) {
  const handle = await open(filename, 'r');
  let overlap = Buffer.alloc(0);
  let position = 0;
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) return false;
      position += bytesRead;
      const combined = Buffer.concat([overlap, chunk.subarray(0, bytesRead)]);
      if (combined.indexOf(secretBytes) >= 0) return true;
      overlap = combined.subarray(Math.max(0, combined.length - secretBytes.length + 1));
    }
  } finally {
    await handle.close();
  }
}

async function identifyArchiveFile(filename, entryName) {
  const extension = path.extname(entryName).toLowerCase();
  if (extension === '.zip') return 'zip';
  if (UNSUPPORTED_ARCHIVE_EXTENSIONS.has(extension)) return 'unsupported';
  const stream = createReadStream(filename, { start: 0, end: 7 });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const header = Buffer.concat(chunks);
  if (hasZipSignature(header)) return 'zip';
  if (hasUnsupportedArchiveSignature(header)) return 'unsupported';
  return null;
}

async function scanZipBuffer(buffer, secretBytes, limits, state, depth) {
  if (depth > limits.maxArchiveDepth || buffer.length > limits.maxArchiveBytes) {
    return inspectionFailure();
  }
  let archive;
  try {
    archive = await JSZip.loadAsync(buffer, { checkCRC32: true });
  } catch {
    return inspectionFailure();
  }
  for (const entry of Object.values(archive.files)) {
    if (entry.dir) continue;
    if (Buffer.from(entry.name, 'utf8').indexOf(secretBytes) >= 0) return leakInspection();
    // JSZip has already parsed the central directory, so reject declared expansion before asking
    // it to allocate the decompressed entry. Missing or inconsistent size metadata is not clean.
    const declaredSize = entry._data?.uncompressedSize;
    if (!Number.isSafeInteger(declaredSize)
      || declaredSize < 0
      || declaredSize > limits.maxEntryBytes
      || state.expandedBytes + declaredSize > limits.maxExpandedBytes) {
      return inspectionFailure();
    }
    let bytes;
    try {
      bytes = await entry.async('nodebuffer');
    } catch {
      return inspectionFailure();
    }
    if (bytes.length !== declaredSize) {
      return inspectionFailure();
    }
    state.expandedBytes += bytes.length;
    if (bytes.indexOf(secretBytes) >= 0) return leakInspection();
    const nestedExtension = path.extname(entry.name).toLowerCase();
    if (UNSUPPORTED_ARCHIVE_EXTENSIONS.has(nestedExtension) || hasUnsupportedArchiveSignature(bytes)) {
      return inspectionFailure();
    }
    const nestedZip = nestedExtension === '.zip' || hasZipSignature(bytes);
    if (nestedZip) {
      if (depth >= limits.maxArchiveDepth) return inspectionFailure();
      const nested = await scanZipBuffer(bytes, secretBytes, limits, state, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function hasUnsupportedArchiveSignature(bytes) {
  const gzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const sevenZip = bytes.length >= 6
    && bytes.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]));
  const rar = bytes.length >= 7
    && bytes.subarray(0, 7).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]));
  const bzip = bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from('BZh'));
  const xz = bytes.length >= 6
    && bytes.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]));
  const zstd = bytes.length >= 4
    && bytes.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
  const lz4 = bytes.length >= 4
    && bytes.subarray(0, 4).equals(Buffer.from([0x04, 0x22, 0x4d, 0x18]));
  const cabinet = bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from('MSCF'));
  return gzip || sevenZip || rar || bzip || xz || zstd || lz4 || cabinet;
}

function hasZipSignature(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  return (bytes[2] === 0x03 && bytes[3] === 0x04)
    || (bytes[2] === 0x05 && bytes[3] === 0x06)
    || (bytes[2] === 0x07 && bytes[3] === 0x08);
}

function normalizeSecret(secret) {
  const bytes = Buffer.isBuffer(secret) ? secret : Buffer.from(secret, 'utf8');
  if (bytes.length === 0) throw new Error('Secret scanning requires a non-empty value.');
  return bytes;
}

const cleanInspection = () => ({ clean: true, found: false, complete: true });
const leakInspection = () => ({ clean: false, found: true, complete: true });
const inspectionFailure = () => ({ clean: false, found: false, complete: false });
