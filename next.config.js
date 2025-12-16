/** @type {import('next').NextConfig} */
const path = require("node:path");
const fs = require("node:fs");
const { execSync } = require("node:child_process");
const BUILD_INFO_PATH = path.join(__dirname, "build-info.json");

function isGitAvailable() {
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ensureFullHistory() {
  if (process.env.VERCEL !== "1") {
    return;
  }
  try {
    const isShallow = execSync("git rev-parse --is-shallow-repository").toString().trim() === "true";
    if (!isShallow) {
      return;
    }
    const branch =
      process.env.VERCEL_GIT_COMMIT_REF ||
      execSync("git rev-parse --abbrev-ref HEAD").toString().trim() ||
      "main";
    try {
      execSync(`git fetch origin ${branch} --depth=2147483647`, { stdio: "ignore" });
    } catch {
      // ignore fetch failures for branch-specific fetch
    }
    try {
      execSync("git fetch --unshallow", { stdio: "ignore" });
    } catch {
      // ignore if repository is already fully cloned or fetch not allowed
    }
  } catch {
    // ignore inability to detect shallow repo
  }
}

function computeGitBuildNumber() {
  if (!isGitAvailable()) {
    return null;
  }
  try {
    ensureFullHistory();
    return execSync("git rev-list --count HEAD").toString().trim();
  } catch {
    return null;
  }
}

function readBuildNumberFromFile() {
  try {
    if (!fs.existsSync(BUILD_INFO_PATH)) {
      return null;
    }
    const raw = fs.readFileSync(BUILD_INFO_PATH, "utf-8");
    const data = JSON.parse(raw);
    if (data && typeof data.buildNumber === "number") {
      return String(data.buildNumber);
    }
    if (data && typeof data.buildNumber === "string") {
      return data.buildNumber;
    }
    return null;
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
  const stored = readBuildNumberFromFile();
  if (stored) {
    return stored;
  }
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7);
  }
  if (process.env.VERCEL_BUILD_ID) {
    return process.env.VERCEL_BUILD_ID;
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
