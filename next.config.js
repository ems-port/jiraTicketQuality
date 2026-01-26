/** @type {import('next').NextConfig} */
const path = require("node:path");
const fs = require("node:fs");
const BUILD_INFO_PATH = path.join(__dirname, "build-info.json");

function readBuildNumberFromFile() {
  if (!fs.existsSync(BUILD_INFO_PATH)) {
    throw new Error("build-info.json not found. Run `npm run build` to generate it.");
  }
  const raw = fs.readFileSync(BUILD_INFO_PATH, "utf-8");
  const data = JSON.parse(raw);
  if (data && typeof data.buildNumber !== "undefined") {
    return String(data.buildNumber);
  }
  throw new Error("build-info.json is missing buildNumber.");
}

const buildNumber = readBuildNumberFromFile();

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
