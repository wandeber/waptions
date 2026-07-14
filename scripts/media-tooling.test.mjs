import assert from 'node:assert/strict';
import { constants as fileSystemConstants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('media verification uses only an integrity-covered package without install lifecycle', async () => {
  const packageDocument = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const workspaceDocument = await readFile(path.join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8');
  const lockDocument = await readFile(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8');
  const ffprobePackagePath = require.resolve('ffprobe-static/package.json');
  const ffprobePackage = JSON.parse(await readFile(ffprobePackagePath, 'utf8'));
  const ffprobeBinaryPath = require('ffprobe-static').path;
  const ffprobePackageDirectory = path.dirname(ffprobePackagePath);

  assert.equal(packageDocument.devDependencies['ffprobe-static'], ffprobePackage.version);
  assert.equal(packageDocument.devDependencies['ffmpeg-static'], undefined);
  assert.doesNotMatch(workspaceDocument, /ffmpeg-static/u);
  assert.doesNotMatch(lockDocument, /ffmpeg-static/u);

  for (const lifecycleName of ['preinstall', 'install', 'postinstall']) {
    assert.equal(
      ffprobePackage.scripts?.[lifecycleName],
      undefined,
      `ffprobe-static must not define a ${lifecycleName} lifecycle.`,
    );
  }

  assert.equal(typeof ffprobeBinaryPath, 'string');
  const relativeBinaryPath = path.relative(ffprobePackageDirectory, ffprobeBinaryPath);
  assert.equal(relativeBinaryPath.startsWith(`bin${path.sep}`), true);
  await access(
    ffprobeBinaryPath,
    process.platform === 'win32' ? fileSystemConstants.F_OK : fileSystemConstants.X_OK,
  );
  assert.equal((await stat(ffprobeBinaryPath)).isFile(), true);

  // The lockfile's SHA-512 covers the package tarball, including the in-package platform binary.
  const escapedVersion = ffprobePackage.version.replaceAll('.', '\\.');
  assert.match(
    lockDocument,
    new RegExp(`ffprobe-static@${escapedVersion}:\\n\\s+resolution: \\{integrity: sha512-`, 'u'),
  );
});
