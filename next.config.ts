import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
    return config;
  },
};

export default nextConfig;
