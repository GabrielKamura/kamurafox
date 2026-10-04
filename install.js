#!/usr/bin/env node
// Installs the bridge for the current user:
//   1. copies it to ~/.kamurafox (Firefox may not read macOS-protected folders such as Desktop),
//   2. registers the native messaging host with Firefox,
//   3. registers the MCP server with Claude Code.
// Flags: --uninstall removes all three; --bridge-only skips step 3.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const NAME = "kamurafox";
const EXTENSION_ID = "kamurafox@gabrielkamura";
const HOME = path.join(os.homedir(), ".kamurafox");
const BRIDGE = path.join(HOME, "bridge");
const LAUNCHER = path.join(HOME, "native-host");
const MANIFEST_DIR = {
  darwin: path.join(os.homedir(), "Library", "Application Support", "Mozilla", "NativeMessagingHosts"),
  linux: path.join(os.homedir(), ".mozilla", "native-messaging-hosts"),
}[process.platform];
const flags = new Set(process.argv.slice(2));

if (!MANIFEST_DIR) {
  console.error("Only macOS and Linux are supported for now.");
  process.exit(1);
}
const MANIFEST = path.join(MANIFEST_DIR, `${NAME}.json`);

function claude(...args) {
  return spawnSync("claude", ["mcp", ...args], { encoding: "utf8" });
}

if (flags.has("--uninstall")) {
  fs.rmSync(MANIFEST, { force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  claude("remove", "-s", "user", NAME);
  console.log("Kamurafox bridge removed. Remove the extension itself in Firefox, under about:addons.");
  process.exit(0);
}

fs.mkdirSync(BRIDGE, { recursive: true, mode: 0o700 });
fs.chmodSync(HOME, 0o700);
for (const file of ["native-host.js", "mcp-server.js"]) {
  fs.copyFileSync(path.join(__dirname, "bridge", file), path.join(BRIDGE, file));
}

// Firefox starts the host with a bare PATH, so the launcher names node by its full path.
fs.writeFileSync(LAUNCHER, `#!/bin/sh\nexec "${process.execPath}" "${path.join(BRIDGE, "native-host.js")}" "$@"\n`, { mode: 0o755 });
fs.chmodSync(LAUNCHER, 0o755);

fs.mkdirSync(MANIFEST_DIR, { recursive: true });
fs.writeFileSync(
  MANIFEST,
  JSON.stringify(
    {
      name: NAME,
      description: "Kamurafox bridge between Firefox and Claude Code",
      path: LAUNCHER,
      type: "stdio",
      allowed_extensions: [EXTENSION_ID],
    },
    null,
    2
  ) + "\n"
);
console.log(`Bridge copied to ${BRIDGE}`);
console.log(`Firefox native host registered at ${MANIFEST}`);

if (!flags.has("--bridge-only")) {
  const server = path.join(BRIDGE, "mcp-server.js");
  claude("remove", "-s", "user", NAME);
  const added = claude("add", "-s", "user", NAME, "--", process.execPath, server);
  if (added.status === 0) {
    console.log(`Claude Code now has the "${NAME}" MCP server (user scope). New sessions will see its tools.`);
  } else {
    console.log("Could not register with Claude Code automatically. Run this yourself:");
    console.log(`  claude mcp add -s user ${NAME} -- "${process.execPath}" "${server}"`);
  }
}
