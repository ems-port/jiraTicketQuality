#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const BUILD_INFO_PATH = path.join(__dirname, "..", "build-info.json");

function computeGitCount() {
  try {
    const output = execSync("git rev-list --count HEAD").toString().trim();
    const value = Number(output);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function ensureFullHistory() {
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
      // ignore branch-specific fetch failures
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

function main() {
  ensureFullHistory();
  const gitCount = computeGitCount();
  if (gitCount === null) {
    throw new Error("Unable to compute git commit count for build number");
  }
  const buildNumber = gitCount;
  const payload = {
    buildNumber,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(BUILD_INFO_PATH, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Updated build-info.json -> buildNumber=${buildNumber}`);
}

main();
