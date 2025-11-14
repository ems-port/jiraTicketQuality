/** @type {import('next').NextConfig} */
const path = require("node:path");
const { execSync } = require("node:child_process");

let buildNumber = process.env.NEXT_PUBLIC_BUILD_NUMBER;
if (!buildNumber) {
  try {
    buildNumber = execSync("git rev-list --count HEAD").toString().trim();
  } catch (error) {
    buildNumber = "dev";
  }
}

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
