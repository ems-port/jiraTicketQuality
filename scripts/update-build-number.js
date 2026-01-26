#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const BUILD_INFO_PATH = path.join(__dirname, "..", "build-info.json");

function main() {
  const raw = fs.readFileSync(BUILD_INFO_PATH, "utf-8");
  const data = JSON.parse(raw);
  const current = Number(data?.buildNumber);
  if (!Number.isFinite(current)) {
    throw new Error("build-info.json is missing a numeric buildNumber.");
  }
  const buildNumber = current + 1;
  const payload = {
    buildNumber,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(BUILD_INFO_PATH, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Updated build-info.json -> buildNumber=${buildNumber}`);
}

main();
