#!/usr/bin/env node
// Native messaging host. Firefox starts this process when the extension connects
// and stops it when the extension goes away. It relays tool calls between local
// MCP servers (one Unix socket per Firefox) and the extension (stdin/stdout).
"use strict";

const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VERSION = "0.1.0";
const HOME = path.join(os.homedir(), ".kamurafox");
const SOCK_DIR = path.join(HOME, "sockets");
const SOCK = path.join(SOCK_DIR, `${process.pid}.sock`);
const LOG = path.join(HOME, "host.log");
const MAX_TO_BROWSER = 1024 * 1024; // Firefox drops anything bigger coming from the host
const LE = os.endianness() === "LE";

function log(text) {
  try {
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${process.pid} ${text}\n`);
  } catch {}
}

// stdout belongs to the native messaging protocol: nothing else may be written there.
function toBrowser(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_TO_BROWSER) return false;
  const head = Buffer.alloc(4);
  if (LE) head.writeUInt32LE(body.length, 0);
  else head.writeUInt32BE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
  return true;
}

const clients = new Map();
let nextClient = 1;

function toClient(sock, message) {
  if (!sock.destroyed) sock.write(JSON.stringify(message) + "\n");
}

function announce() {
  toBrowser({ type: "clients", count: clients.size });
}

function fromClient(cid, sock, message) {
  if (message.type !== "call") return;
  const sent = toBrowser({
    type: "call",
    id: `${cid}:${message.id}`,
    tool: message.tool,
    args: message.args || {},
  });
  if (!sent) {
    toClient(sock, { type: "result", id: String(message.id), ok: false, error: "Request is larger than 1 MB, the most Firefox accepts from a native host." });
  }
}

function fromBrowser(message) {
  if (!message || message.type !== "result" || typeof message.id !== "string") return;
  const cut = message.id.indexOf(":");
  const sock = clients.get(Number(message.id.slice(0, cut)));
  if (!sock) return;
  toClient(sock, { type: "result", id: message.id.slice(cut + 1), ok: message.ok, result: message.result, error: message.error });
}

const server = net.createServer((sock) => {
  const cid = nextClient++;
  clients.set(cid, sock);
  announce();
  let pending = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk) => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (!line.trim()) continue;
      try {
        fromClient(cid, sock, JSON.parse(line));
      } catch {}
    }
  });
  const drop = () => {
    if (clients.delete(cid)) announce();
  };
  sock.on("close", drop);
  sock.on("error", drop);
});

let closing = false;
function shutdown(reason) {
  if (closing) return;
  closing = true;
  log(`stop (${reason})`);
  for (const sock of clients.values()) sock.destroy();
  try {
    fs.unlinkSync(SOCK);
  } catch {}
  process.exit(0);
}

let inbox = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  inbox = Buffer.concat([inbox, chunk]);
  while (inbox.length >= 4) {
    const size = LE ? inbox.readUInt32LE(0) : inbox.readUInt32BE(0);
    if (inbox.length < 4 + size) break;
    const raw = inbox.subarray(4, 4 + size);
    inbox = inbox.subarray(4 + size);
    try {
      fromBrowser(JSON.parse(raw.toString("utf8")));
    } catch {}
  }
});
process.stdin.on("end", () => shutdown("firefox closed the pipe"));
process.stdout.on("error", () => shutdown("stdout closed"));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => shutdown(signal));
process.on("uncaughtException", (error) => {
  log(`crash: ${error.stack || error}`);
  shutdown("crash");
});

// Only this user may reach the socket: whoever connects can drive the browser.
process.umask(0o077);
fs.mkdirSync(SOCK_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(HOME, 0o700);
fs.chmodSync(SOCK_DIR, 0o700);
try {
  if (fs.statSync(LOG).size > 512 * 1024) fs.truncateSync(LOG, 0);
} catch {}
try {
  fs.unlinkSync(SOCK);
} catch {}

server.on("error", (error) => {
  log(`socket error: ${error.message}`);
  shutdown("socket error");
});
server.listen(SOCK, () => {
  log(`start ${SOCK}`);
  toBrowser({ type: "hello", version: VERSION, pid: process.pid });
});
