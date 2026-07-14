/** @type {import('next').NextConfig} */
const configuredE2ePort = process.env.WAPTIONS_E2E_PORT;

const nextConfig = {
  // Verification builds and Playwright servers use isolated output directories so they can run
  // safely while a developer-owned `pnpm run dev` process is serving the normal `.next` tree.
  distDir: process.env.WAPTIONS_NEXT_DIST_DIR || '.next',
  typescript: {
    // Isolated verification runs provide a temporary config containing their unique generated
    // types path. Normal development and production commands keep using the tracked config.
    tsconfigPath: process.env.WAPTIONS_TSCONFIG_PATH || 'tsconfig.json',
  },
  // The bottom-left Next.js developer badge can cover the editor's lowest track controls in the
  // fixed Playwright viewport. Browser tests already fail on page and console errors explicitly.
  devIndicators: configuredE2ePort ? false : undefined,
  webpack: (config) => {
    // Every browser run starts from a unique compiler tree, so a persistent webpack cache cannot
    // be reused. Disabling it also prevents late cache serialization from recreating a run after
    // the custom E2E server has closed and its directory has been removed.
    if (configuredE2ePort) config.cache = false;
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
      crypto: false,
    };
    return config;
  },
  // Keep the existing authenticated-avatar policy in the canonical config. Next.js loads config
  // files by a fixed precedence order, so retaining this only in a second TypeScript config made
  // the policy ineffective while `next.config.js` existed.
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.googleusercontent.com',
        port: '',
        pathname: '/**',
      },
    ],
  },
  reactStrictMode: false,
  experimental: {
    serverActions: {
      allowedOrigins: [
        'localhost:59940',
        ...(configuredE2ePort ? [`localhost:${configuredE2ePort}`] : []),
      ],
      bodySizeLimit: '2mb',
    },
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'require-corp',
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
