import { createHash } from 'node:crypto';
import { constants as fileSystemConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const fixtureDirectory = path.join(repositoryRoot, 'e2e/fixtures/media');
export const fixtureManifestPath = path.join(fixtureDirectory, 'manifest.json');

export const fixtureDefinitions = Object.freeze([
  Object.freeze({
    fileName: 'video-red-440hz.webm',
    mediaType: 'video/webm',
    content: Object.freeze({
      color: '#dc2626',
      sineFrequencyHz: 440,
      durationSeconds: 2,
    }),
  }),
  Object.freeze({
    fileName: 'video-blue-660hz.webm',
    mediaType: 'video/webm',
    content: Object.freeze({
      color: '#2563eb',
      sineFrequencyHz: 660,
      durationSeconds: 2,
    }),
  }),
  Object.freeze({
    fileName: 'standalone-880hz.wav',
    mediaType: 'audio/wav',
    content: Object.freeze({
      sineFrequencyHz: 880,
      durationSeconds: 2,
    }),
  }),
]);

export function resolveMediaVerifier() {
  const ffprobePackage = require('ffprobe-static');
  if (typeof ffprobePackage?.path !== 'string') {
    throw new Error('The repository-local ffprobe-static binary could not be resolved.');
  }
  return { ffprobePath: ffprobePackage.path };
}

export function describeFixtureProvenance() {
  const ffprobePackageJson = require('ffprobe-static/package.json');
  return {
    // FFmpeg remains historical provenance for the committed bytes, not an installed executable.
    ffmpeg: {
      package: 'ffmpeg-static',
      version: '5.3.0',
      license: 'GPL-3.0-or-later',
      source: 'https://github.com/eugeneware/ffmpeg-static',
    },
    ffprobe: {
      package: 'ffprobe-static',
      version: ffprobePackageJson.version,
      license: ffprobePackageJson.license,
      source: ffprobePackageJson.repository?.url,
    },
  };
}

export async function assertExecutable(binaryPath, packageName) {
  try {
    await access(binaryPath, process.platform === 'win32' ? fileSystemConstants.F_OK : fileSystemConstants.X_OK);
  } catch (error) {
    throw new Error(
      `${packageName} did not provide its packaged executable at ${binaryPath}. Run pnpm install --frozen-lockfile to restore the integrity-checked package contents.`,
      { cause: error },
    );
  }
}

export async function runBinary(binaryPath, argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, argumentsList, {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(new Error(`${path.basename(binaryPath)} exited with ${code}:\n${errorOutput}`));
        return;
      }
      resolve({ stdout: output, stderr: errorOutput });
    });
  });
}

function roundDuration(value) {
  return Math.round(Number.parseFloat(value) * 1_000) / 1_000;
}

export async function probeMediaFile(ffprobePath, filePath) {
  const { stdout } = await runBinary(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=format_name,duration:stream=index,codec_type,codec_name,width,height,sample_rate,channels',
    '-of', 'json',
    filePath,
  ]);
  const result = JSON.parse(stdout);
  return {
    formatName: result.format.format_name,
    durationSeconds: roundDuration(result.format.duration),
    streams: result.streams.map((stream) => ({
      index: stream.index,
      codecType: stream.codec_type,
      codecName: stream.codec_name,
      ...(stream.width === undefined ? {} : { width: stream.width }),
      ...(stream.height === undefined ? {} : { height: stream.height }),
      ...(stream.sample_rate === undefined ? {} : { sampleRate: Number.parseInt(stream.sample_rate, 10) }),
      ...(stream.channels === undefined ? {} : { channels: stream.channels }),
    })),
  };
}

export async function describeMediaFile(ffprobePath, definition, filePath) {
  const bytes = await readFile(filePath);
  return {
    fileName: definition.fileName,
    mediaType: definition.mediaType,
    license: 'CC0-1.0',
    content: definition.content,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    probe: await probeMediaFile(ffprobePath, filePath),
  };
}
