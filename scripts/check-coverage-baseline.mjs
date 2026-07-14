import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  createCoverageProfile,
  findCoverageRegressions,
  normalizeCoverageSummary,
} from './coverage-baseline-core.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(repositoryRoot, 'coverage-baseline.json');
const profileDirectories = Object.freeze({
  wider: 'wider',
  'critical-runtime': 'critical-runtime',
});

function parseArguments(argv) {
  const profileFlag = argv.indexOf('--profile');
  const profile = profileFlag >= 0 ? argv[profileFlag + 1] : undefined;
  if (!profile || !Object.hasOwn(profileDirectories, profile)) {
    throw new Error(`Use --profile with one of: ${Object.keys(profileDirectories).join(', ')}.`);
  }
  return { profile, update: argv.includes('--update') };
}

async function readBaseline() {
  try {
    return JSON.parse(await readFile(baselinePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { schemaVersion: 2, profiles: {} };
    }
    throw error;
  }
}

async function main() {
  const { profile, update } = parseArguments(process.argv.slice(2));
  const summaryPath = path.join(
    repositoryRoot,
    'coverage',
    profileDirectories[profile],
    'coverage-summary.json',
  );
  const coverageSummary = JSON.parse(await readFile(summaryPath, 'utf8'));
  const observed = normalizeCoverageSummary(coverageSummary.total);
  const baseline = await readBaseline();

  if (update) {
    baseline.schemaVersion = 2;
    baseline.profiles[profile] = createCoverageProfile(
      profile,
      path.relative(repositoryRoot, summaryPath),
      observed,
    );
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`Updated the ${profile} coverage baseline at ${path.relative(repositoryRoot, baselinePath)}.`);
    return;
  }

  const expected = baseline.profiles[profile];
  if (!expected) {
    throw new Error(`Coverage profile ${profile} has no baseline. Run its :update script intentionally.`);
  }
  const failures = findCoverageRegressions(profile, observed, expected);
  if (failures.length > 0) {
    throw new Error(`Coverage regressed below the ${profile} baseline:\n${failures.join('\n')}`);
  }
  console.log(`Coverage satisfies the ${profile} baseline.`);
}

await main();
