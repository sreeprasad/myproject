import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Hide the Next.js dev badge so it never shows up in recordings.
  devIndicators: false,
  reactStrictMode: true,
  // The shared recorder lives in ../recorder as TypeScript source.
  transpilePackages: ["showme-recorder"],
  turbopack: { root: path.resolve(here, "..") },
  outputFileTracingRoot: path.resolve(here, ".."),
};

export default nextConfig;
