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
    const attempts = [
      `git fetch origin ${branch} --deepen=2147483647`,
      `git fetch origin ${branch} --depth=2147483647`,
      "git fetch --unshallow"
    ];
    for (const cmd of attempts) {
      try {
        execSync(cmd, { stdio: "ignore" });
        break;
      } catch {
        // try next
      }
    }
  } catch {
    // ignore inability to detect shallow repo
  }
}

function main() {
  ensureFullHistory();
  const gitCount = computeGitCount();
  const existing = (() => {
    try {
      const raw = fs.readFileSync(BUILD_INFO_PATH, "utf-8");
      const data = JSON.parse(raw);
      return typeof data.buildNumber !== "undefined" ? data.buildNumber : null;
    } catch {
      return null;
    }
  })();
  const fallback =
    process.env.VERCEL_BUILD_ID ||
    (process.env.VERCEL_GIT_COMMIT_SHA ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : null);
  const buildNumber = gitCount ?? existing ?? fallback ?? "dev";
  const payload = {
    buildNumber,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(BUILD_INFO_PATH, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Updated build-info.json -> buildNumber=${buildNumber}`);
}

main();
