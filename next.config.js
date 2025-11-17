/** @type {import('next').NextConfig} */
const path = require("node:path");
const { execSync } = require("node:child_process");

function computeGitBuildNumber() {
  try {
    if (process.env.VERCEL === "1") {
      try {
        execSync("git fetch --unshallow", { stdio: "ignore" });
      } catch (error) {
        // Ignore fetch failures (already have full history or network blocked)
      }
    }
    return execSync("git rev-list --count HEAD").toString().trim();
  } catch {
    return null;
  }
}

function resolveBuildNumber() {
  if (process.env.NEXT_PUBLIC_BUILD_NUMBER) {
    return process.env.NEXT_PUBLIC_BUILD_NUMBER;
  }
  const gitCount = computeGitBuildNumber();
  if (gitCount) {
    return gitCount;
  }
  if (process.env.VERCEL_BUILD_ID) {
    return process.env.VERCEL_BUILD_ID;
  }
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7);
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
