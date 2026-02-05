import type { NextConfig } from "next";

// Next.jsサーバーサイドでもyjs-lockerを適用
if (typeof require !== 'undefined') {
  try {
    require('./src/util/yjs-locker');
    console.log('[next.config] yjs-locker applied to Next.js');
  } catch (err: any) {
    console.warn('[next.config] Failed to apply yjs-locker:', err?.message || err);
  }
}

const nextConfig: NextConfig = {
  basePath: '/collarecox',

  // Disable React StrictMode in development to reduce duplicate component mounting
  reactStrictMode: false,

  // Custom WebSocket handling
  webpack: (config, { dev }) => {
    if (dev) {
      // Allow WebSocket upgrades in development
      config.watchOptions = {
        poll: 1000,
        aggregateTimeout: 300,
      };
    }

    // Fix YJS duplicate import issue
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...config.resolve.alias,
      'yjs/dist/yjs.mjs': 'yjs',
      'yjs/dist/yjs.cjs': 'yjs',
    };

    return config;
  },
};

export default nextConfig;
