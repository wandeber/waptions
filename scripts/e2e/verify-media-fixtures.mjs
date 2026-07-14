import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  assertExecutable,
  describeFixtureProvenance,
  describeMediaFile,
  fixtureDefinitions,
  fixtureDirectory,
  fixtureManifestPath,
  resolveMediaVerifier,
} from './media-fixture-tools.mjs';

async function main() {
  // CI verifies committed bytes and metadata with the executable packaged inside ffprobe-static.
  // It never downloads or invokes a fixture generator during install or verification.
  const { ffprobePath } = resolveMediaVerifier();
  await assertExecutable(ffprobePath, 'ffprobe-static');
  const manifest = JSON.parse(await readFile(fixtureManifestPath, 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.generator, describeFixtureProvenance());
  assert.equal(manifest.files.length, fixtureDefinitions.length);

  const expectedNames = fixtureDefinitions.map((definition) => definition.fileName).sort();
  const committedNames = (await readdir(fixtureDirectory))
    .filter((fileName) => /\.(?:webm|wav)$/u.test(fileName))
    .sort();
  assert.deepEqual(committedNames, expectedNames, 'The committed media set must match the declared fixtures.');

  for (const definition of fixtureDefinitions) {
    const expected = manifest.files.find((file) => file.fileName === definition.fileName);
    assert.ok(expected, `${definition.fileName} is missing from the fixture manifest.`);
    assert.equal(expected.mediaType, definition.mediaType);
    assert.deepEqual(expected.content, definition.content);
    const actual = await describeMediaFile(
      ffprobePath,
      definition,
      path.join(fixtureDirectory, definition.fileName),
    );
    assert.deepEqual(actual, expected, `${definition.fileName} does not match its checksum or probed metadata.`);
  }
  console.log('Committed media fixture checksums and metadata are valid.');
}

await main();
