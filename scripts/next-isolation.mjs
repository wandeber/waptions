import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/**
 * Creates the per-process paths used by verification Next.js instances.
 *
 * Next.js requires its generated TypeScript glob to appear literally in the configured
 * tsconfig. A unique dist directory cannot therefore use the tracked tsconfig without Next.js
 * rewriting it for every invocation. Each isolated run receives a temporary root-level config
 * which extends the real project config and adds only that run's generated type path.
 */
export async function createIsolatedNextRun(scope) {
  if (!/^[a-z0-9-]+$/u.test(scope)) {
    throw new Error('The isolated Next.js scope may contain only lowercase letters, digits, and hyphens.');
  }

  const projectDir = process.cwd();
  const runId = `${Date.now()}-${process.pid}-${randomUUID()}`;
  const distDir = `.waptions-next/${scope}/${runId}`;
  const tsconfigPath = `.waptions-${scope}-${runId}.tsconfig.json`;
  const nextEnvPath = `.waptions-${scope}-${runId}.next-env.d.ts`;

  const generatedTypes = `${distDir}/types/**/*.ts`;
  const temporaryTsconfig = {
    extends: './tsconfig.json',
    // Next.js cannot safely inject its editor plugin into a config that extends another file.
    // Restating the same project plugin keeps the temporary config complete and warning-free.
    compilerOptions: {
      plugins: [{ name: 'next' }],
    },
    // The root config's broad globs also discover the shared `.next` tree and `next-env.d.ts`.
    // Isolated Next processes must never type-check either one because a developer server or a
    // concurrent verification run can rewrite them. Application source remains fully covered,
    // while the aggregate gate's standalone `tsc` command still checks the whole root config.
    files: [nextEnvPath],
    include: ['src/**/*.ts', 'src/**/*.tsx', generatedTypes],
  };

  const isolatedNextEnv = [
    '/// <reference types="next" />',
    '/// <reference types="next/image-types/global" />',
    '',
    '// NOTE: This file is generated for one isolated verification run.',
    '',
  ].join('\n');

  await Promise.all([
    writeFile(
      path.join(projectDir, tsconfigPath),
      `${JSON.stringify(temporaryTsconfig, null, 2)}\n`,
      'utf8',
    ),
    writeFile(path.join(projectDir, nextEnvPath), isolatedNextEnv, 'utf8'),
  ]);

  return {
    runId,
    projectDir,
    distDir,
    tsconfigPath,
    nextEnvPath,
    absoluteDistDir: path.join(projectDir, distDir),
    absoluteTsconfigPath: path.join(projectDir, tsconfigPath),
    absoluteNextEnvPath: path.join(projectDir, nextEnvPath),
  };
}

/** Removes only one invocation's generated files, never a shared parent used by another run. */
export async function removeIsolatedNextRun(run) {
  try {
    // Next.js always rewrites the root next-env file even when it uses a custom tsconfig. Restore
    // a stable reference before deleting this run's route types so no completed invocation leaves
    // the repository pointing at its now-removed unique directory. Atomic rename makes identical
    // concurrent restores safe.
    const canonicalNextEnv = [
      '/// <reference types="next" />',
      '/// <reference types="next/image-types/global" />',
      '/// <reference path="./.next/types/routes.d.ts" />',
      '',
      '// NOTE: This file should not be edited',
      '// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.',
      '',
    ].join('\n');
    const temporaryNextEnvPath = path.join(
      run.projectDir,
      '.waptions-next',
      `next-env-${run.runId}.tmp`,
    );
    await mkdir(path.dirname(temporaryNextEnvPath), { recursive: true });
    await writeFile(temporaryNextEnvPath, canonicalNextEnv, 'utf8');
    await rename(temporaryNextEnvPath, path.join(run.projectDir, 'next-env.d.ts'));
  } finally {
    await Promise.all([
      rm(run.absoluteDistDir, { recursive: true, force: true }),
      rm(run.absoluteTsconfigPath, { force: true }),
      rm(run.absoluteNextEnvPath, { force: true }),
    ]);
  }
}
