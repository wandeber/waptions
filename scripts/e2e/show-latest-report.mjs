import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const reportRoot = path.join(process.cwd(), 'playwright-report');
const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

async function findLatestReport() {
  const candidates = [reportRoot];
  try {
    const entries = await readdir(reportRoot, { withFileTypes: true });
    candidates.push(
      ...entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(reportRoot, entry.name)),
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }

  const reports = [];
  for (const candidate of candidates) {
    try {
      const reportStat = await stat(path.join(candidate, 'index.html'));
      reports.push({ directory: candidate, modifiedAt: reportStat.mtimeMs });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return reports.sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.directory;
}

const latestReport = await findLatestReport();
if (!latestReport) {
  throw new Error('No Playwright HTML report was found. Run `pnpm run test:e2e` first.');
}

const child = spawn(pnpmExecutable, ['exec', 'playwright', 'show-report', latestReport], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code, signal) => {
    if (signal) reject(new Error(`The Playwright report server ended from signal ${signal}.`));
    else resolve(code ?? 1);
  });
});
if (exitCode !== 0) process.exitCode = exitCode;
