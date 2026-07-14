import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const nextConfig = require('../next.config.js');

test('the canonical Next config retains every runtime and deployment policy', async () => {
  assert.equal(nextConfig.distDir, '.next');
  assert.equal(nextConfig.typescript?.tsconfigPath, 'tsconfig.json');
  assert.equal(nextConfig.reactStrictMode, false);
  assert.deepEqual(nextConfig.images?.remotePatterns, [{
    protocol: 'https',
    hostname: '*.googleusercontent.com',
    port: '',
    pathname: '/**',
  }]);
  assert.deepEqual(nextConfig.experimental?.serverActions, {
    allowedOrigins: ['localhost:59940'],
    bodySizeLimit: '2mb',
  });
  assert.equal(typeof nextConfig.webpack, 'function');

  const headers = await nextConfig.headers();
  assert.deepEqual(headers, [{
    source: '/:path*',
    headers: [
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
    ],
  }]);
});

test('there is no shadow Next config with a different precedence', async () => {
  await assert.rejects(access(path.join(repositoryRoot, 'next.config.ts')), { code: 'ENOENT' });
});
