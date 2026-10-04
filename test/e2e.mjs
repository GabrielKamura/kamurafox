// End-to-end check against a real Firefox, playing the part of Claude Code:
// this script -> MCP server -> native host -> extension -> a local fixture site.
// Firefox runs headless on a throwaway profile. HEADED=1 shows the window.
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIREFOX = process.env.FIREFOX_BIN || "/Applications/Firefox.app/Contents/MacOS/firefox";
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), "kamurafox-e2e");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FIXTURE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Kamurafox fixture</title></head>
<body>
<h1>Fixture</h1>
<nav><a href="/second">Second page</a> <a href="/second" target="_blank">New tab link</a></nav>
<form id="f">
  <label>Name <input id="name" name="name" placeholder="Your name"></label>
  <label><input type="checkbox" id="agree"> I agree</label>
  <label>Fruit <select id="fruit"><option value="">Pick</option><option value="a">Apple</option><option value="b">Banana</option></select></label>
  <button type="submit">Send</button>
</form>
<div id="out"></div>
<div id="editor" contenteditable="true" aria-label="Notes" style="border:1px solid #999;min-height:2em"></div>
<button id="ask" type="button">Delete</button>
<div id="card" style="cursor:pointer;width:120px">Plain card</div>
<div style="height:2000px"></div>
<p id="bottom">Bottom marker</p>
<script>
  const out = document.getElementById("out");
  console.log("fixture ready", { n: 1 });
  window.appState = { answer: 42 };
  document.getElementById("f").addEventListener("submit", (event) => {
    event.preventDefault();
    out.textContent = "Hello " + document.getElementById("name").value + " | agree=" + document.getElementById("agree").checked + " | fruit=" + document.getElementById("fruit").value;
    console.warn("submitted");
    fetch("/api/ping?x=1");
  });
  document.getElementById("ask").addEventListener("click", () => { out.textContent = confirm("Really delete?") ? "deleted" : "kept"; });
  document.getElementById("card").addEventListener("click", () => { out.textContent = "card clicked"; });
</script>
</body></html>`;

const server = http.createServer((request, response) => {
  const url = request.url.split("?")[0];
  if (url === "/") return response.writeHead(200, { "content-type": "text/html" }).end(FIXTURE);
  if (url === "/second") return response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Second</title><h1>Second page</h1>");
  if (url === "/csp") {
    return response
      .writeHead(200, { "content-type": "text/html", "content-security-policy": "script-src 'none'" })
      .end('<!doctype html><title>Strict</title><p id="p">CSP page</p>');
  }
  if (url === "/api/ping") return response.writeHead(200, { "content-type": "application/json" }).end('{"pong":true}');
  response.writeHead(404).end("not found");
});

class Client {
  constructor() {
    this.child = spawn(process.execPath, [path.join(ROOT, "bridge", "mcp-server.js")], { stdio: ["pipe", "pipe", "inherit"] });
    this.waiting = new Map();
    this.seq = 0;
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      const done = this.waiting.get(message.id);
      if (!done) return;
      this.waiting.delete(message.id);
      done(message);
    });
  }
  request(method, params) {
    const id = ++this.seq;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
    });
  }
  async call(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (result.isError) throw new Error(text);
    return { text, image: result.content.find((part) => part.type === "image") };
  }
}

let passed = 0;
function check(name, condition, detail = "") {
  assert.ok(condition, `${name}${detail ? `\n--- got ---\n${detail}` : ""}`);
  passed++;
  console.log(`  ok  ${name}`);
}
const refIn = (text, pattern) => {
  const line = text.split("\n").find((entry) => pattern.test(entry));
  assert.ok(line, `no line matches ${pattern}\n--- got ---\n${text}`);
  return line.match(/ref_\d+/)[0];
};

let firefox;
let client;
async function main() {
  const setup = spawnSync(process.execPath, [path.join(ROOT, "install.js"), "--bridge-only"], { encoding: "utf8" });
  assert.equal(setup.status, 0, setup.stderr);
  fs.mkdirSync(SHOTS, { recursive: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const webExt = path.join(ROOT, "node_modules", ".bin", "web-ext");
  const args = ["run", "--source-dir", path.join(ROOT, "extension"), "--firefox", FIREFOX, "--no-input", "--no-reload", "--pref", "media.volume_scale=0.0", "--pref", "media.autoplay.default=5"];
  // Low priority on macOS: the machine stays usable while the test browser runs.
  const command = process.platform === "darwin" ? ["nice", "-n", "20", "taskpolicy", "-b", webExt, ...args] : [webExt, ...args];
  const env = { ...process.env };
  if (!process.env.HEADED) env.MOZ_HEADLESS = "1";
  let firefoxLog = "";
  const launch = () => {
    firefox = spawn(command[0], command.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
    firefox.stdout.on("data", (chunk) => (firefoxLog += chunk));
    firefox.stderr.on("data", (chunk) => (firefoxLog += chunk));
  };
  launch();

  client = new Client();
  const hello = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  check("MCP handshake", hello.serverInfo.name === "kamurafox" && hello.capabilities.tools);
  const listed = await client.request("tools/list", {});
  check("15 tools listed", listed.tools.length === 15, String(listed.tools.length));

  // On a busy machine the low-priority Firefox can start too slowly for web-ext, which then gives up: launch again.
  let ready = false;
  let launches = 1;
  for (let attempt = 0; attempt < 180 && !ready; attempt++) {
    if (firefox.exitCode !== null) {
      if (launches >= 3) throw new Error(`Firefox exited early ${launches} times:\n${firefoxLog}`);
      launches++;
      launch();
    }
    try {
      await client.call("tabs_context");
      ready = true;
    } catch {
      await sleep(1000);
    }
  }
  check("Firefox, extension and native host connected", ready, firefoxLog);

  let out = await client.call("tabs_create", { url: base });
  const tabId = Number(out.text.match(/tabId (\d+)/)[1]);
  check("tabs_create opens the page", /Kamurafox fixture/.test(out.text), out.text);

  await assert.rejects(client.call("navigate", { tabId: 999999, url: base }), /not under your control/);
  check("a tab that is not controlled is refused", true);

  out = await client.call("read_page", { tabId, filter: "interactive" });
  const page = out.text;
  check("read_page lists the controls", /textbox "Name"/.test(page) && /checkbox "I agree".*unchecked/.test(page) && /combobox "Fruit".*options=\[Pick \| Apple \| Banana\]/.test(page) && /button "Send"/.test(page), page);
  check("read_page finds the pointer-cursor card and the editor", /clickable "Plain card"/.test(page) && /textbox "Notes"/.test(page), page);
  const name = refIn(page, /textbox "Name"/);

  out = await client.call("read_page", { tabId });
  check("read_page (all) has the heading and text", /heading "Fixture"/.test(out.text) && /Bottom marker/.test(out.text), out.text);

  out = await client.call("computer", { tabId, action: "left_click", ref: name });
  check("click by ref", /Clicked textbox "Name"/.test(out.text), out.text);
  out = await client.call("computer", { tabId, action: "type", text: "Gabriel" });
  check("type into the focused field", /Typed "Gabriel"/.test(out.text), out.text);
  out = await client.call("form_input", { tabId, ref: refIn(page, /checkbox "I agree"/), value: true });
  check("form_input checks a box", /now checked/.test(out.text), out.text);
  out = await client.call("form_input", { tabId, ref: refIn(page, /combobox "Fruit"/), value: "Banana" });
  check("form_input picks a select option", /Selected "Banana"/.test(out.text), out.text);
  await client.call("computer", { tabId, action: "left_click", ref: name });
  out = await client.call("computer", { tabId, action: "key", text: "Enter" });
  check("Enter submits the form", /submitted the form/.test(out.text), out.text);

  out = await client.call("get_page_text", { tabId });
  check("the page saw every input", out.text.includes("Hello Gabriel | agree=true | fruit=b"), out.text);

  out = await client.call("read_console_messages", { tabId });
  check("console log and warning captured", /\[log\] fixture ready \{"n":1\}/.test(out.text) && /\[warn\] submitted/.test(out.text), out.text);
  out = await client.call("read_network_requests", { tabId, urlPattern: "api" });
  check("network request captured", /GET 200 \S+ \S+\/api\/ping\?x=1/.test(out.text), out.text);

  out = await client.call("javascript_tool", { tabId, code: "window.appState.answer" });
  check("javascript sees the page's globals", out.text.trim() === "42", out.text);
  out = await client.call("javascript_tool", { tabId, code: "(async () => { await new Promise((r) => setTimeout(r, 30)); return { seven: 7 }; })()" });
  check("javascript awaits promises", /"seven": 7/.test(out.text), out.text);
  out = await client.call("javascript_tool", { tabId, code: "nope.nope" });
  check("javascript reports errors", /Error: ReferenceError/.test(out.text), out.text);

  out = await client.call("javascript_tool", { tabId, code: 'document.querySelectorAll("kamurafox-frame").length' });
  check("the controlled tab wears the frame", out.text.trim() === "1", out.text);

  out = await client.call("find", { tabId, query: "delete button" });
  check("find by keywords", /button "Delete"/.test(out.text.split("\n")[1]), out.text);
  const del = refIn(out.text, /button "Delete"/);
  out = await client.call("computer", { tabId, action: "left_click", ref: del });
  check("confirm() is dismissed by default and reported", /confirm\("Really delete\?"\); it was dismissed/.test(out.text), out.text);
  await client.call("handle_dialogs", { tabId, accept: true });
  out = await client.call("computer", { tabId, action: "left_click", ref: del });
  check("confirm() accepted after handle_dialogs", /it was accepted/.test(out.text), out.text);
  out = await client.call("javascript_tool", { tabId, code: 'document.getElementById("out").textContent' });
  check("the page got the accepted answer", /deleted/.test(out.text), out.text);

  out = await client.call("computer", { tabId, action: "left_click", ref: refIn(page, /clickable "Plain card"/) });
  out = await client.call("javascript_tool", { tabId, code: 'document.getElementById("out").textContent' });
  check("click reaches a plain listener", /card clicked/.test(out.text), out.text);

  await client.call("computer", { tabId, action: "left_click", ref: refIn(page, /textbox "Notes"/) });
  await client.call("computer", { tabId, action: "type", text: "note from claude" });
  out = await client.call("javascript_tool", { tabId, code: 'document.getElementById("editor").textContent' });
  check("type into a contenteditable", /note from claude/.test(out.text), out.text);

  out = await client.call("computer", { tabId, action: "screenshot" });
  fs.writeFileSync(path.join(SHOTS, "viewport.jpg"), Buffer.from(out.image.data, "base64"));
  check("screenshot returns an image", out.image.mimeType === "image/jpeg" && out.image.data.length > 2000, out.text);
  out = await client.call("computer", { tabId, action: "zoom", region: [0, 0, 400, 200] });
  fs.writeFileSync(path.join(SHOTS, "zoom.jpg"), Buffer.from(out.image.data, "base64"));
  check("zoom returns an image", out.image.data.length > 2000, out.text);

  out = await client.call("computer", { tabId, action: "scroll", scroll_direction: "down", scroll_amount: 10 });
  check("scroll moves the page", /Scrolled down 1000 px/.test(out.text), out.text);
  out = await client.call("find", { tabId, query: "bottom marker" });
  out = await client.call("computer", { tabId, action: "scroll_to", ref: refIn(out.text, /Bottom marker/) });
  check("scroll_to brings an element into view", /is now at \(\d+, \d+\)/.test(out.text), out.text);

  out = await client.call("computer", { tabId, action: "left_click", ref: refIn(page, /link "New tab link"/) });
  check("a target=_blank link opens a controlled tab", /new tab, now under your control: tabId \d+ — \S+\/second/.test(out.text), out.text);
  const second = Number(out.text.match(/control: tabId (\d+)/)[1]);
  out = await client.call("tabs_context");
  check("tabs_context lists both tabs", out.text.includes(`tabId ${tabId}`) && out.text.includes(`tabId ${second}`), out.text);

  out = await client.call("navigate", { tabId, url: `${base}/csp` });
  check("navigate", /Strict — /.test(out.text), out.text);
  out = await client.call("javascript_tool", { tabId, code: 'document.getElementById("p").textContent' });
  check("javascript still works where the page forbids eval", /^CSP page/.test(out.text) && /isolated world/.test(out.text), out.text);
  out = await client.call("navigate", { tabId, url: "back" });
  check("navigate back", /Kamurafox fixture/.test(out.text), out.text);

  out = await client.call("tabs_close", { tabId: second });
  await client.call("tabs_close", { tabId });
  out = await client.call("tabs_context");
  check("tabs_close", /You control no tabs/.test(out.text), out.text);

  // A tab that was already open: adopt it, let go of it, adopt it again.
  out = await client.call("tabs_context", { all: true });
  const own = Number(out.text.split("other tabs")[1].match(/tabId (\d+)/)[1]);
  out = await client.call("tabs_adopt", { tabId: own });
  check("tabs_adopt takes a tab the user had open", /Now controlling the user's tab/.test(out.text), out.text);
  await client.call("navigate", { tabId: own, url: base });
  out = await client.call("tabs_close", { tabId: own });
  check("closing an adopted tab only releases it", /stays open/.test(out.text), out.text);
  await assert.rejects(client.call("get_page_text", { tabId: own }), /not under your control/);
  out = await client.call("tabs_context", { all: true });
  check("the released tab is still open", out.text.split("other tabs")[1].includes(`tabId ${own}`), out.text);
  await client.call("tabs_adopt", { tabId: own });
  out = await client.call("javascript_tool", { tabId: own, code: "console.log('after re-adopt'); confirm('again?')" });
  check("a re-adopted tab is hooked again", out.text.trim() === "false", out.text);
  await client.call("navigate", { tabId: own, url: "reload" });
  out = await client.call("read_console_messages", { tabId: own });
  check("console is recorded after re-adopting and reloading", /after re-adopt/.test(out.text) && /fixture ready/.test(out.text), out.text);
  await client.call("tabs_close", { tabId: own });

  console.log(`\n${passed} checks passed. Screenshots in ${SHOTS}`);
}

async function cleanup() {
  if (client) client.child.kill();
  server.close();
  if (firefox && firefox.exitCode === null) {
    firefox.kill("SIGINT");
    for (let waited = 0; waited < 100 && firefox.exitCode === null; waited++) await sleep(100);
    if (firefox.exitCode === null) firefox.kill("SIGKILL");
  }
}

main()
  .then(cleanup, async (error) => {
    console.error(`\nFAILED after ${passed} checks: ${error.message}`);
    await cleanup();
    process.exit(1);
  })
  .then(() => process.exit(0));
