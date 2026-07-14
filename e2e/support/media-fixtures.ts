import path from 'node:path';

const mediaFixtureDirectory = path.resolve(process.cwd(), 'e2e/fixtures/media');

/**
 * Stable paths for browser tests that need real decodable streams. Keeping this mapping in one
 * place prevents individual specs from silently falling back to developer-local environment
 * variables or regenerating media with browser-dependent encoders.
 */
export const mediaFixtures = Object.freeze({
    videoA: path.join(mediaFixtureDirectory, 'video-red-440hz.webm'),
    videoB: path.join(mediaFixtureDirectory, 'video-blue-660hz.webm'),
    audio: path.join(mediaFixtureDirectory, 'standalone-880hz.wav'),
});
