import type { NextConfig } from "next";

// Static export: the public sandbox is plain files (GitHub Pages under /projects/aether-airport-recovery/demo, or nginx in Docker).
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const config: NextConfig = {
  output: "export",
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@aether/domain", "@aether/agents", "@aether/motion", "@aether/telemetry", "@aether/sdk"],
  typescript: { ignoreBuildErrors: true }, // type-checked separately by `npm run typecheck`
  productionBrowserSourceMaps: false,
  webpack(config, { isServer }) {
    if (!isServer) config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, crypto: false };
    return config;
  },
};
export default config;
