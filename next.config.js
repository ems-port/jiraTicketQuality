/** @type {import('next').NextConfig} */
const path = require("node:path");
const fs = require("node:fs");

function resolveBuildNumber() {
  if (process.env.NEXT_PUBLIC_BUILD_NUMBER) {
    return process.env.NEXT_PUBLIC_BUILD_NUMBER;
  }
  try {
    const buildInfoPath = path.join(__dirname, "build-info.json");
    const raw = fs.readFileSync(buildInfoPath, "utf-8");
    const data = JSON.parse(raw);
    if (data && typeof data.buildNumber !== "undefined") {
      return String(data.buildNumber);
    }
  } catch {
    // fall through to dev default
  }
  return "dev";
}

const buildNumber = resolveBuildNumber();

const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_BUILD_NUMBER: buildNumber
  },
  webpack: (config) => {
    config.resolve.alias["@"] = path.resolve(__dirname);
    return config;
  }
};

module.exports = nextConfig;
