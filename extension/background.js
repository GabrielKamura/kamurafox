"use strict";

// Talks to the native host (which talks to Claude Code) and runs each tool call
// against the tabs under control. Other tabs only ever get early.js, which
// switches itself off as soon as it learns the tab is not controlled.

const HOST_NAME = "kamurafox";
const MAX_LOG = 1000;
const OUTPUT_LIMIT = 20000;

const state = { port: null, online: false, hostError: "", sessions: 0, paused: false, retryMs: 2000 };
const controlled = new Map(); // tabId -> { adopted, console, network, dialog, unwatch }
const groups = new Map(); // windowId -> tab group id
let early = null; // registration of early.js, kept only while a tab is controlled

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.timedOut = true;
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function pushCapped(list, item) {
  list.push(item);
  if (list.length > MAX_LOG) list.splice(0, list.length - MAX_LOG);
}

function clip(text, limit = OUTPUT_LIMIT) {
  return text.length > limit ? `${text.slice(0, limit)}\n… cut at ${limit} characters.` : text;
}

const describe = (tab) => `${tab.title || "(untitled)"} — ${tab.url}`;

// ---------------------------------------------------------------- native host

function connectHost() {
  let port;
  try {
    port = browser.runtime.connectNative(HOST_NAME);
  } catch (error) {
    hostDown(error.message);
    return;
  }
  state.port = port;
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener((gone) => {
    if (state.port === gone) hostDown(gone.error ? gone.error.message : "");
  });
}

function hostDown(message) {
  state.port = null;
  state.online = false;
  state.sessions = 0;
  state.hostError = message || "";
  refreshBadge();
  setTimeout(connectHost, state.retryMs);
  state.retryMs = Math.min(state.retryMs * 2, 30000);
}

function reply(message) {
  try {
    if (state.port) state.port.postMessage(message);
  } catch {}
}

function onHostMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "hello") {
    state.online = true;
    state.hostError = "";
    state.retryMs = 2000;
    refreshBadge();
  } else if (message.type === "clients") {
    state.sessions = message.count | 0;
  } else if (message.type === "call") {
    runTool(message.tool, message.args || {}).then(
      (result) => reply({ type: "result", id: message.id, ok: true, result }),
      (error) => reply({ type: "result", id: message.id, ok: false, error: String((error && error.message) || error) })
    );
  }
}

async function runTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (state.paused) throw new Error("Control is paused: the user paused it in the Kamurafox popup. Ask them to resume before trying again.");
  return tool(args);
}

function refreshBadge() {
  const text = state.paused ? "II" : controlled.size ? String(controlled.size) : "";
  browser.browserAction.setBadgeText({ text });
  browser.browserAction.setBadgeBackgroundColor({ color: state.paused ? "#6b5d55" : "#d97757" });
}

// ------------------------------------------------------------ controlled tabs

function control(tabId, adopted) {
  let entry = controlled.get(tabId);
  if (entry) return entry;
  entry = { adopted, console: [], network: [], dialog: { accept: false, promptText: null }, unwatch: null };
  controlled.set(tabId, entry);
  const filter = { urls: ["<all_urls>"], tabId };
  const done = (d) => pushCapped(entry.network, { method: d.method, url: d.url, status: d.statusCode, type: d.type });
  const failed = (d) => pushCapped(entry.network, { method: d.method, url: d.url, status: 0, type: d.type, error: d.error });
  browser.webRequest.onCompleted.addListener(done, filter);
  browser.webRequest.onErrorOccurred.addListener(failed, filter);
  entry.unwatch = () => {
    browser.webRequest.onCompleted.removeListener(done);
    browser.webRequest.onErrorOccurred.removeListener(failed);
  };
  refreshBadge();
  return entry;
}

function release(tabId, tabStillOpen = true) {
  const entry = controlled.get(tabId);
  if (!entry) return;
  entry.unwatch();
  controlled.delete(tabId);
  refreshBadge();
  if (tabStillOpen) browser.tabs.sendMessage(tabId, { kfx: "release" }, { frameId: 0 }).catch(() => {});
  if (!controlled.size && early) {
    early.then((registered) => registered.unregister()).catch(() => {});
    early = null;
  }
}

// Console recording has to be in place before a page's first script runs, and only
// a registered content script is that early. Await this before navigating a tab.
function armEarly() {
  if (!early) {
    early = browser.contentScripts.register({ matches: ["http://*/*", "https://*/*"], js: [{ file: "/early.js" }], runAt: "document_start" });
  }
  return early.catch(() => {});
}

// Tabs Claude opens sit together in a "Claude" tab group. Adopted tabs stay where the user left them.
async function group(tab) {
  if (typeof browser.tabs.group !== "function") return;
  try {
    const known = groups.get(tab.windowId);
    if (known !== undefined) {
      try {
        await browser.tabs.group({ tabIds: [tab.id], groupId: known });
        return;
      } catch {
        groups.delete(tab.windowId);
      }
    }
    const groupId = await browser.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    groups.set(tab.windowId, groupId);
    if (browser.tabGroups && browser.tabGroups.update) await browser.tabGroups.update(groupId, { title: "Claude", color: "orange" });
  } catch {}
}

async function needTab(args) {
  const id = Number(args.tabId);
  if (!Number.isInteger(id)) throw new Error("tabId is required. Call tabs_context to see the tabs you control, or tabs_create to open one.");
  if (!controlled.has(id)) {
    throw new Error(`Tab ${id} is not under your control. Use tabs_create to open a tab, or tabs_adopt if the user asked you to use one they already have open.`);
  }
  try {
    return await browser.tabs.get(id);
  } catch {
    release(id, false);
    throw new Error(`Tab ${id} was closed.`);
  }
}

// ---------------------------------------------------------------- navigation

function normalizeUrl(input) {
  let url = String(input || "").trim();
  if (!url) throw new Error("url is empty.");
  if (url === "about:blank") return url;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = (/^(localhost|127\.|\[::1\])/i.test(url) ? "http://" : "https://") + url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${input}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http and https pages can be opened.");
  return parsed.href;
}

// Resolves when the tab's next load finishes: "complete", "timeout", or "idle" when nothing started.
function nextLoad(tabId, timeout = 25000) {
  return new Promise((resolve) => {
    let started = false;
    const finish = (outcome) => {
      browser.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(slow);
      clearTimeout(idle);
      resolve(outcome);
    };
    const onUpdated = (id, change) => {
      if (id !== tabId || !change.status) return;
      if (change.status === "loading") started = true;
      else if (started) finish("complete");
    };
    browser.tabs.onUpdated.addListener(onUpdated);
    const slow = setTimeout(() => finish("timeout"), timeout);
    const idle = setTimeout(() => {
      if (!started) finish("idle");
    }, 3000);
    browser.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === "loading") started = true;
      },
      () => finish("idle")
    );
  });
}

async function go(tabId, where) {
  const moves = { back: () => browser.tabs.goBack(tabId), forward: () => browser.tabs.goForward(tabId), reload: () => browser.tabs.reload(tabId) };
  const move = Object.hasOwn(moves, where) ? moves[where] : ((url) => () => browser.tabs.update(tabId, { url }))(normalizeUrl(where));
  await collectConsole(tabId);
  const loaded = nextLoad(tabId);
  await move();
  const outcome = await loaded;
  await inject(tabId).catch(() => {});
  return outcome;
}

// The tab starts blank and is navigated after it is registered, so the page's
// first scripts already run with the console and dialog hooks in place.
async function openTab(url, opener) {
  const props = { url: "about:blank", active: true };
  if (opener) Object.assign(props, { windowId: opener.windowId, openerTabId: opener.id, index: opener.index + 1 });
  const tab = await browser.tabs.create(props);
  control(tab.id, false);
  await armEarly();
  await group(tab);
  const outcome = url ? await go(tab.id, url) : "complete";
  return { tab: await browser.tabs.get(tab.id), outcome };
}

// After an action: give a navigation it may have caused the time to finish.
async function settle(tabId) {
  await sleep(150);
  const start = Date.now();
  while (Date.now() - start < 10000) {
    let tab;
    try {
      tab = await browser.tabs.get(tabId);
    } catch {
      return;
    }
    if (tab.status !== "loading") return;
    await sleep(120);
  }
}

// ------------------------------------------------------------ content script

// Pulls what the page logged but has not sent yet. Called before leaving a page, so nothing is lost with it.
async function collectConsole(tabId) {
  const entry = controlled.get(tabId);
  if (!entry) return;
  try {
    const pending = await withTimeout(browser.tabs.sendMessage(tabId, { kfx: "drain" }, { frameId: 0 }), 1500, "drain");
    if (pending && pending.entries) for (const item of pending.entries) pushCapped(entry.console, item);
  } catch {}
}

async function inject(tabId) {
  await browser.tabs.executeScript(tabId, { file: "/early.js", runAt: "document_start", frameId: 0 });
  await browser.tabs.executeScript(tabId, { file: "/content.js", runAt: "document_start", frameId: 0 });
  const entry = controlled.get(tabId);
  if (entry) await browser.tabs.sendMessage(tabId, { kfx: "config", dialog: entry.dialog }, { frameId: 0 }).catch(() => {});
}

async function blockedPage(tabId) {
  let url = "";
  try {
    url = (await browser.tabs.get(tabId)).url;
  } catch {}
  return `Firefox does not let extensions act on this page${url ? ` (${url})` : ""}. That covers about: pages, addons.mozilla.org, the PDF viewer and reader view. Navigate the tab to a regular web page first.`;
}

async function ensureContent(tabId) {
  try {
    const pong = await withTimeout(browser.tabs.sendMessage(tabId, { kfx: "ping" }, { frameId: 0 }), 4000, "ping");
    if (pong && pong.ok) return;
  } catch (error) {
    if (error.timedOut) throw new Error("The page is not responding. It may be frozen or still busy loading.");
  }
  try {
    await inject(tabId);
  } catch {
    throw new Error(await blockedPage(tabId));
  }
}

// Commands are sent exactly once. An action whose page navigates away before
// answering counts as done; resending it could click twice.
async function callContent(tabId, command, payload = {}, { timeout = 15000, action = false } = {}) {
  await ensureContent(tabId);
  const gone = { text: "Done. The page navigated before it could confirm.", notes: [] };
  let result;
  try {
    result = await withTimeout(browser.tabs.sendMessage(tabId, { kfx: command, ...payload }, { frameId: 0 }), timeout, "The page did not answer in time.");
  } catch (error) {
    if (action && !error.timedOut) return gone;
    throw error;
  }
  if (result === undefined) {
    if (action) return gone;
    throw new Error("The page navigated while it was being read. Try again.");
  }
  if (result.error) throw new Error(result.error);
  return result;
}

// Runs an action in the page, then reports what it caused: new tab, navigation, blocked dialogs.
async function act(tab, command, payload) {
  const result = await callContent(tab.id, command, payload, { action: true });
  const lines = [result.text];
  if (result.openUrl) {
    const opened = await openTab(result.openUrl, tab);
    lines.push(`The link opens in a new tab, now under your control: tabId ${opened.tab.id} — ${opened.tab.url}`);
  }
  await settle(tab.id);
  for (const note of result.notes || []) lines.push(note);
  try {
    const now = await browser.tabs.get(tab.id);
    if (now.url !== tab.url) lines.push(`The tab is now at: ${describe(now)}`);
  } catch {
    lines.push("The tab closed.");
  }
  return { text: lines.join("\n") };
}

async function capture(tabId, region, keepMark) {
  let view = null;
  try {
    view = await callContent(tabId, "beforeShot", { keep: !!keepMark }, { timeout: 4000 });
  } catch {}
  const options = { format: "jpeg", quality: 80, scale: 1 };
  let label = view ? `Screenshot of the viewport, ${view.width}x${view.height} CSS pixels. Click coordinates use this same scale.` : "Screenshot of the viewport.";
  if (region) {
    const [x0, y0, x1, y1] = region.map(Number);
    if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) throw new Error("region must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0.");
    options.rect = { x: x0 + (view ? view.scrollX : 0), y: y0 + (view ? view.scrollY : 0), width: x1 - x0, height: y1 - y0 };
    options.scale = Math.max(1, Math.min(3, 1200 / (x1 - x0)));
    label = `Zoom of the viewport region (${x0}, ${y0}) to (${x1}, ${y1}), enlarged ${options.scale.toFixed(1)}x.`;
  }
  let dataUrl;
  try {
    dataUrl = await browser.tabs.captureTab(tabId, options);
  } finally {
    if (view) browser.tabs.sendMessage(tabId, { kfx: "afterShot" }, { frameId: 0 }).catch(() => {});
  }
  return { image: { data: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: "image/jpeg" }, text: label };
}

// Serialises a value to text. Shipped as source so it runs in the page or in the isolated world.
const SERIALIZE = `(function (v) {
  if (v === undefined) return "undefined";
  if (typeof v === "string") return v;
  if (typeof v === "function") return String(v).slice(0, 2000);
  if (typeof v === "symbol" || typeof v === "bigint") return String(v);
  if (v instanceof Error) return v.name + ": " + v.message;
  if (typeof Node !== "undefined" && v instanceof Node) return v.nodeType === 1 ? v.outerHTML.slice(0, 4000) : String(v.textContent).slice(0, 4000);
  try {
    var seen = new WeakSet();
    var s = JSON.stringify(v, function (k, x) {
      if (typeof x === "bigint") return String(x);
      if (typeof x === "function") return "[function]";
      if (x && typeof x === "object") {
        if (seen.has(x)) return "[repeated]";
        seen.add(x);
        if (typeof Node !== "undefined" && x instanceof Node) return "<" + String(x.nodeName).toLowerCase() + ">";
        if (typeof Window !== "undefined" && x instanceof Window) return "[window]";
      }
      return x;
    }, 2);
    return s === undefined ? String(v) : s;
  } catch (e) {
    return String(v);
  }
})`;

function regex(source, name) {
  if (!source) return null;
  try {
    return new RegExp(source, "i");
  } catch {
    throw new Error(`${name} is not a valid regular expression.`);
  }
}

// --------------------------------------------------------------------- tools

const CLICKS = { left_click: "left", right_click: "right", double_click: "double", triple_click: "triple", hover: "hover" };

const TOOLS = {
  async tabs_context({ all }) {
    const open = await browser.tabs.query({});
    const line = (tab) => `- tabId ${tab.id}${tab.active ? " (active)" : ""}: ${describe(tab)}`;
    const mine = open.filter((tab) => controlled.has(tab.id));
    let text = mine.length ? `Tabs under your control:\n${mine.map(line).join("\n")}` : "You control no tabs yet. Call tabs_create to open one.";
    if (all) {
      const rest = open.filter((tab) => !controlled.has(tab.id));
      text += `\n\nThe user's other tabs (adopt one only if they asked for it):\n${rest.map(line).join("\n") || "(none)"}`;
    }
    return { text };
  },

  async tabs_create({ url }) {
    if (url) normalizeUrl(url);
    const { tab, outcome } = await openTab(url || "");
    return { text: `Opened tabId ${tab.id}${outcome === "timeout" ? " (still loading after 25 s)" : ""}: ${describe(tab)}` };
  },

  async tabs_adopt({ tabId }) {
    const id = Number(tabId);
    let tab;
    try {
      tab = await browser.tabs.get(id);
    } catch {
      throw new Error(`There is no tab ${tabId}. Call tabs_context with all: true to list the open tabs.`);
    }
    control(id, true);
    await armEarly();
    await inject(id).catch(() => {});
    return { text: `Now controlling the user's tab ${id}: ${describe(tab)}` };
  },

  async tabs_close(args) {
    const tab = await needTab(args);
    if (controlled.get(tab.id).adopted) {
      release(tab.id);
      return { text: `Released tab ${tab.id}. It belongs to the user, so it stays open.` };
    }
    release(tab.id, false);
    await browser.tabs.remove(tab.id);
    return { text: `Closed tab ${tab.id}.` };
  },

  async navigate(args) {
    const tab = await needTab(args);
    const outcome = await go(tab.id, String(args.url || "").trim());
    const now = await browser.tabs.get(tab.id);
    const prefix = outcome === "timeout" ? "Still loading after 25 s: " : outcome === "idle" ? "No page load happened: " : "";
    return { text: prefix + describe(now) };
  },

  async read_page(args) {
    const tab = await needTab(args);
    const result = await callContent(tab.id, "readPage", { filter: args.filter, ref: args.ref, maxChars: args.maxChars });
    return { text: result.text };
  },

  async get_page_text(args) {
    const tab = await needTab(args);
    const result = await callContent(tab.id, "pageText", { maxChars: args.maxChars });
    return { text: result.text };
  },

  async find(args) {
    const tab = await needTab(args);
    const result = await callContent(tab.id, "find", { query: String(args.query || "") });
    return { text: result.text };
  },

  async computer(args) {
    const tab = await needTab(args);
    const action = String(args.action || "");
    if (action === "screenshot") return capture(tab.id, null, args.show_mark);
    if (action === "zoom") {
      if (!Array.isArray(args.region) || args.region.length !== 4) throw new Error("zoom needs region: [x0, y0, x1, y1].");
      return capture(tab.id, args.region);
    }
    if (action === "wait") {
      const seconds = Math.min(Math.max(Number(args.duration) || 1, 0), 30);
      await sleep(seconds * 1000);
      return { text: `Waited ${seconds} s.` };
    }
    if (CLICKS[action]) return act(tab, "click", { kind: CLICKS[action], ref: args.ref, coordinate: args.coordinate, modifiers: args.modifiers });
    if (action === "type") return act(tab, "type", { text: String(args.text ?? ""), ref: args.ref });
    if (action === "key") return act(tab, "key", { keys: String(args.text ?? "") });
    if (action === "scroll") {
      const result = await callContent(tab.id, "scroll", { coordinate: args.coordinate, direction: args.scroll_direction, amount: args.scroll_amount });
      return { text: result.text };
    }
    if (action === "scroll_to") {
      const result = await callContent(tab.id, "scrollTo", { ref: args.ref });
      return { text: result.text };
    }
    throw new Error(`Unknown action: ${action}`);
  },

  async form_input(args) {
    const tab = await needTab(args);
    return act(tab, "setValue", { ref: args.ref, value: args.value });
  },

  async javascript_tool(args) {
    const tab = await needTab(args);
    const code = String(args.code || "");
    if (!code.trim()) throw new Error("code is empty.");
    let result = await callContent(tab.id, "evaluate", { code, serialize: SERIALIZE }, { timeout: 30000 });
    let where = "";
    if (result.blocked) {
      // The page's own policy forbids eval, so the code runs beside the page instead of inside it.
      const wrapped = `(async () => { try { return { text: ${SERIALIZE}(await (0, eval)(${JSON.stringify(code)})) }; } catch (e) { return { failed: true, text: String(e) }; } })()`;
      const [value] = await withTimeout(browser.tabs.executeScript(tab.id, { code: wrapped, frameId: 0 }), 30000, "The script did not finish in 30 s.");
      result = value || { text: "undefined" };
      where = "\n(This page forbids eval, so the code ran in the extension's isolated world: the DOM is the same, the page's own globals are under window.wrappedJSObject.)";
    }
    await settle(tab.id);
    return { text: clip((result.failed ? "Error: " : "") + result.text) + where };
  },

  async read_console_messages(args) {
    const tab = await needTab(args);
    const entry = controlled.get(tab.id);
    await collectConsole(tab.id);
    const pattern = regex(args.pattern, "pattern");
    let list = entry.console;
    if (args.onlyErrors) list = list.filter((item) => item.level === "error");
    if (pattern) list = list.filter((item) => pattern.test(item.text));
    const shown = list.slice(-(Number(args.limit) > 0 ? Number(args.limit) : 100));
    const text = shown.length ? `${shown.length} of ${list.length} entries:\n${shown.map((item) => `[${item.level}] ${item.text}`).join("\n")}` : "No console messages match.";
    if (args.clear) entry.console.length = 0;
    return { text: clip(text) };
  },

  async read_network_requests(args) {
    const tab = await needTab(args);
    const entry = controlled.get(tab.id);
    const pattern = regex(args.urlPattern, "urlPattern");
    const list = pattern ? entry.network.filter((item) => pattern.test(item.url)) : entry.network;
    const shown = list.slice(-(Number(args.limit) > 0 ? Number(args.limit) : 100));
    const line = (item) => `${item.method} ${item.error ? `failed (${item.error})` : item.status} ${item.type} ${item.url}`;
    const text = shown.length ? `${shown.length} of ${list.length} requests:\n${shown.map(line).join("\n")}` : "No requests match.";
    if (args.clear) entry.network.length = 0;
    return { text: clip(text) };
  },

  async handle_dialogs(args) {
    const tab = await needTab(args);
    const entry = controlled.get(tab.id);
    entry.dialog = { accept: !!args.accept, promptText: args.promptText == null ? null : String(args.promptText) };
    await callContent(tab.id, "config", { dialog: entry.dialog });
    return { text: `confirm() and prompt() in this tab will now be ${entry.dialog.accept ? "accepted" : "dismissed"}.` };
  },

  async resize_window(args) {
    const tab = await needTab(args);
    const width = Math.round(Number(args.width));
    const height = Math.round(Number(args.height));
    if (!(width >= 200 && height >= 200)) throw new Error("width and height must be at least 200.");
    await browser.windows.update(tab.windowId, { width, height });
    return { text: `Window resized to ${width}x${height}.` };
  },
};

// -------------------------------------------------------------------- events

browser.tabs.onRemoved.addListener((tabId) => release(tabId, false));

browser.webNavigation.onCommitted.addListener((details) => {
  const entry = controlled.get(details.tabId);
  if (!entry || details.frameId !== 0) return;
  pushCapped(entry.console, { level: "nav", text: `Navigated to ${details.url}` });
  inject(details.tabId).catch(() => {});
});

async function snapshot() {
  const tabs = [];
  for (const [id, entry] of controlled) {
    try {
      const tab = await browser.tabs.get(id);
      tabs.push({ id, title: tab.title || tab.url, url: tab.url, adopted: entry.adopted });
    } catch {}
  }
  return { online: state.online, hostError: state.hostError, sessions: state.sessions, paused: state.paused, tabs };
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.kfx !== "string") return undefined;
  if (sender.tab) {
    const entry = controlled.get(sender.tab.id);
    if (message.kfx === "hello") return Promise.resolve({ controlled: !!entry });
    if (!entry) return undefined;
    if (message.kfx === "console" && Array.isArray(message.entries)) for (const item of message.entries) pushCapped(entry.console, item);
    if (message.kfx === "open") openTab(message.url, sender.tab).catch(() => {});
    return undefined;
  }
  if (message.kfx === "popup:pause") {
    state.paused = !!message.paused;
    browser.storage.local.set({ paused: state.paused });
    refreshBadge();
  } else if (message.kfx === "popup:release") {
    release(Number(message.tabId));
  } else if (message.kfx !== "popup:state") {
    return undefined;
  }
  return snapshot();
});

browser.storage.local.get("paused").then((saved) => {
  state.paused = !!saved.paused;
  refreshBadge();
});
connectHost();
