#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const BUILD_INFO_PATH = path.join(__dirname, "..", "build-info.json");

function readExistingBuildNumber() {
  try {
    const raw = fs.readFileSync(BUILD_INFO_PATH, "utf-8");
    const data = JSON.parse(raw);
    if (data && typeof data.buildNumber === "number" && Number.isFinite(data.buildNumber)) {
      return data.buildNumber;
    }
    if (data && typeof data.buildNumber === "string" && /^\d+$/.test(data.buildNumber)) {
      return Number(data.buildNumber);
    }
  } catch {
    // ignore
  }
  return 0;
}

function computeGitCount() {
  try {
    const output = execSync("git rev-list --count HEAD").toString().trim();
    const value = Number(output);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function main() {
  const gitCount = computeGitCount();
  const buildNumber = gitCount ?? readExistingBuildNumber() + 1;
  const payload = {
    buildNumber,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(BUILD_INFO_PATH, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Updated build-info.json -> buildNumber=${buildNumber}`);
}

main();
