// Injected only into tabs under control, after early.js.
// Runs in Firefox's isolated content-script world: `window.wrappedJSObject` is
// the page's own view of itself, everything else here is invisible to the page.
(() => {
  "use strict";
  if (globalThis.__kamurafox) return;
  globalThis.__kamurafox = true;

  const page = window.wrappedJSObject;
  const early = globalThis.__kamurafoxEarly; // console recording, running since document start
  let active = true;
  let dialog = { accept: false, promptText: null };
  const notes = []; // side effects to report with the next action

  const squash = (text, max = 120) => {
    const flat = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  };

  // ------------------------------------------------------------------ dialogs

  function say(text) {
    early.record("dialog", text);
    notes.push(text);
  }

  const native = { alert: page.alert, confirm: page.confirm, prompt: page.prompt, open: page.open };

  // A native dialog would freeze the tab until a person answers it, so they are answered here and reported.
  page.alert = exportFunction(function (message) {
    if (!active) return Reflect.apply(native.alert, page, [message]);
    say(`The page showed alert(${JSON.stringify(squash(message, 300))}); it was suppressed.`);
    return undefined;
  }, window);
  page.confirm = exportFunction(function (message) {
    if (!active) return Reflect.apply(native.confirm, page, [message]);
    say(`The page asked confirm(${JSON.stringify(squash(message, 300))}); it was ${dialog.accept ? "accepted" : "dismissed (use handle_dialogs to accept)"}.`);
    return dialog.accept;
  }, window);
  page.prompt = exportFunction(function (message, preset) {
    if (!active) return Reflect.apply(native.prompt, page, [message, preset]);
    const answer = dialog.accept ? String(dialog.promptText ?? preset ?? "") : null;
    say(`The page asked prompt(${JSON.stringify(squash(message, 300))}); it was ${answer === null ? "dismissed (use handle_dialogs to answer)" : `answered ${JSON.stringify(answer)}`}.`);
    return answer;
  }, window);

  // Synthetic clicks cannot get past the pop-up blocker, so new windows become controlled tabs.
  page.open = exportFunction(function (url, target, features) {
    const name = target == null ? "_blank" : String(target).toLowerCase();
    if (active && url && !["_self", "_top", "_parent"].includes(name)) {
      let absolute = "";
      try {
        absolute = new URL(String(url), document.baseURI).href;
      } catch {}
      if (/^https?:/.test(absolute)) {
        browser.runtime.sendMessage({ kfx: "open", url: absolute }).catch(() => {});
        notes.push(`The page opened ${absolute} in a new tab under your control (see tabs_context).`);
        return null;
      }
    }
    return Reflect.apply(native.open, page, [url, target, features]);
  }, window);

  function restore() {
    for (const name of Object.keys(native)) page[name] = native[name];
  }

  // ---------------------------------------------------------------- indicator

  let frame = null;

  function css(el, text) {
    el.style.cssText = text;
    return el;
  }

  // Styled through the CSSOM only, so a strict page CSP cannot strip it.
  function ensureIndicator() {
    const html = document.documentElement;
    if (!active || !html || html.localName !== "html") return;
    if (frame && frame.host.isConnected) return;
    const host = css(document.createElement("kamurafox-frame"), "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;");
    host.setAttribute("aria-hidden", "true");
    const root = host.attachShadow({ mode: "closed" });
    root.appendChild(
      css(
        document.createElement("div"),
        "position:fixed;inset:0;border:2px solid #d97757;box-shadow:inset 0 0 0 1px rgba(251,243,233,.55),inset 0 0 22px rgba(217,119,87,.28);pointer-events:none;"
      )
    );
    const tag = css(
      document.createElement("div"),
      "position:fixed;left:50%;bottom:10px;transform:translateX(-50%);padding:5px 12px 5px 10px;border-radius:3px 12px 12px 12px;background:#221a16;color:#fbf3e9;font:500 12px/1.3 ui-monospace,Menlo,Consolas,monospace;white-space:nowrap;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.3);"
    );
    tag.append(css(document.createElement("span"), "display:inline-block;width:7px;height:7px;margin-right:7px;border-radius:50%;background:#d97757;vertical-align:1px;"), browser.i18n.getMessage("indicator"));
    root.appendChild(tag);
    html.appendChild(host);
    frame = { host, root };
  }

  function ripple(x, y) {
    ensureIndicator();
    if (!frame) return;
    const ring = css(
      document.createElement("div"),
      `position:fixed;left:${x - 11}px;top:${y - 11}px;width:22px;height:22px;border-radius:50%;border:2px solid #d97757;background:rgba(217,119,87,.25);pointer-events:none;`
    );
    frame.root.appendChild(ring);
    try {
      ring.animate([{ transform: "scale(.4)", opacity: 1 }, { transform: "scale(1.7)", opacity: 0 }], { duration: 420, easing: "ease-out" });
    } catch {}
    setTimeout(() => ring.remove(), 400);
  }

  // ------------------------------------------------- elements, roles and names

  const refs = new Map(); // ref -> element
  const refOf = new WeakMap();
  let refCount = 0;

  function refFor(el) {
    let ref = refOf.get(el);
    if (!ref || refs.get(ref) !== el) {
      ref = `ref_${++refCount}`;
      refOf.set(el, ref);
      refs.set(ref, el);
    }
    return ref;
  }

  function elFor(ref) {
    const el = refs.get(String(ref));
    if (!el || !el.isConnected) throw new Error(`${ref} is no longer on the page. Call read_page or find again to get fresh refs.`);
    return el;
  }

  function prune() {
    for (const [ref, el] of refs) if (!el.isConnected) refs.delete(ref);
  }

  const shadowOf = (el) => el.openOrClosedShadowRoot || null;
  const up = (node) => node.parentElement || (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);

  function within(node, ancestor) {
    for (let at = node; at; at = up(at)) if (at === ancestor) return true;
    return false;
  }

  function visible(el) {
    if (el.getAttribute("aria-hidden") === "true") return false;
    let shown = true;
    try {
      shown = el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
    } catch {}
    return shown || getComputedStyle(el).display === "contents";
  }

  const SKIP = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "title", "base", "br", "wbr", "source", "track", "param", "kamurafox-frame"]);
  const LEAF = new Set(["select", "textarea", "input", "img", "iframe", "svg", "canvas", "video", "audio", "option"]);
  const INPUT_ROLES = { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", image: "button", range: "slider", search: "searchbox", number: "spinbutton", file: "file chooser" };
  const TAG_ROLES = {
    button: "button", textarea: "textbox", option: "option", img: "image", nav: "navigation", main: "main", header: "header", footer: "footer",
    aside: "complementary", form: "form", ul: "list", ol: "list", li: "listitem", table: "table", tr: "row", td: "cell", th: "columnheader",
    summary: "button", dialog: "dialog", iframe: "iframe", article: "article", h1: "heading", h2: "heading", h3: "heading", h4: "heading",
    h5: "heading", h6: "heading", video: "video", audio: "audio", canvas: "canvas",
  };
  const CLICK_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "combobox", "textbox", "searchbox", "slider", "spinbutton", "treeitem", "gridcell"]);
  const CONTROLS = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [contenteditable=''], [contenteditable=true]";
  const FOCUSABLE = "input:not([type=hidden]), textarea, select, button, a[href], [tabindex], [contenteditable=''], [contenteditable=true], [contenteditable=plaintext-only], summary";

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit && explicit.trim()) return explicit.trim().split(/\s+/)[0];
    const tag = el.localName;
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return type === "hidden" ? null : INPUT_ROLES[type] || "textbox";
    }
    if (tag === "select") return el.multiple ? "listbox" : "combobox";
    if (tag === "svg") return el.getAttribute("aria-label") ? "image" : null;
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return "textbox";
    return TAG_ROLES[tag] || null;
  }

  function isInteractive(el) {
    const tag = el.localName;
    if (tag === "a") return el.hasAttribute("href");
    if (tag === "button" || tag === "select" || tag === "textarea" || tag === "summary") return true;
    if (tag === "input") return el.type !== "hidden";
    if (el.isContentEditable) return !el.parentElement || !el.parentElement.isContentEditable;
    const role = el.getAttribute("role");
    if (role && CLICK_ROLES.has(role)) return true;
    if (el.hasAttribute("onclick")) return true;
    if (el.hasAttribute("tabindex") && el.tabIndex >= 0) return true;
    // Click listeners are invisible to an extension; a pointer cursor is the next best sign.
    if (getComputedStyle(el).cursor !== "pointer") return false;
    const parent = up(el);
    return !parent || getComputedStyle(parent).cursor !== "pointer";
  }

  // Text of a label without the text of the controls nested inside it.
  function plainText(node) {
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 3) out += child.nodeValue;
      else if (child.nodeType === 1 && !["select", "textarea", "input", "button", "script", "style"].includes(child.localName)) out += ` ${plainText(child)}`;
    }
    return out;
  }

  function ariaName(el) {
    const ids = el.getAttribute("aria-labelledby");
    if (ids) {
      const text = ids.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || "").join(" ");
      if (text.trim()) return squash(text);
    }
    return squash(el.getAttribute("aria-label") || "");
  }

  function nameOf(el) {
    const aria = ariaName(el);
    if (aria) return aria;
    const tag = el.localName;
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (tag === "input" && ["button", "submit", "reset"].includes(el.type)) return squash(el.value || el.type);
      if (el.labels && el.labels.length) {
        const text = squash([...el.labels].map(plainText).join(" "));
        if (text) return text;
      }
      return squash(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("name") || "");
    }
    if (tag === "img") return squash(el.getAttribute("alt") || el.getAttribute("title") || "");
    if (tag === "iframe") return squash(el.getAttribute("title") || el.getAttribute("name") || el.getAttribute("src") || "");
    const text = squash(el.innerText || el.textContent);
    if (text) return text;
    const inner = el.querySelector("img[alt], [aria-label], svg title");
    return squash(el.getAttribute("title") || (inner && (inner.getAttribute("alt") || inner.getAttribute("aria-label") || inner.textContent)) || "");
  }

  function attrsOf(el) {
    const out = [];
    const tag = el.localName;
    if (tag === "a") {
      const href = el.getAttribute("href") || "";
      out.push(`href="${href.length > 90 ? `${href.slice(0, 89)}…` : href}"`);
    }
    if (tag === "input" || tag === "textarea") {
      const type = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : "text";
      if (!["text", "checkbox", "radio", "button", "submit", "reset"].includes(type)) out.push(`type="${type}"`);
      if (type === "checkbox" || type === "radio") out.push(el.checked ? "checked" : "unchecked");
      else if (!["button", "submit", "reset", "file", "image"].includes(type) && el.value) {
        out.push(`value="${type === "password" ? "•".repeat(Math.min(el.value.length, 8)) : squash(el.value, 60)}"`);
      }
    }
    if (tag === "select") {
      const options = [...el.options];
      out.push(`value="${squash(el.selectedOptions[0] ? el.selectedOptions[0].text : "", 40)}"`);
      out.push(`options=[${options.slice(0, 20).map((option) => squash(option.text, 30)).join(" | ")}${options.length > 20 ? " | …" : ""}]`);
    }
    const checked = el.getAttribute("aria-checked");
    if (checked) out.push(checked === "true" ? "checked" : "unchecked");
    const expanded = el.getAttribute("aria-expanded");
    if (expanded) out.push(expanded === "true" ? "expanded" : "collapsed");
    if (el.getAttribute("aria-selected") === "true") out.push("selected");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") out.push("disabled");
    return out.length ? ` ${out.join(" ")}` : "";
  }

  function label(el) {
    let owner = el;
    for (let at = el, hops = 0; at && hops < 6; at = up(at), hops++) {
      if (isInteractive(at)) {
        owner = at;
        break;
      }
    }
    const name = squash(nameOf(owner), 60);
    return `${roleOf(owner) || owner.localName}${name ? ` "${name}"` : ""}`;
  }

  function childrenOf(el) {
    const shadow = shadowOf(el);
    return shadow ? [...shadow.childNodes, ...el.childNodes] : el.childNodes;
  }

  function header() {
    const scroller = document.scrollingElement || document.documentElement;
    return `Page: ${document.title}\nURL: ${location.href}\nViewport: ${innerWidth}x${innerHeight}, scrolled to y=${Math.round(scrollY)} of ${Math.max(0, scroller.scrollHeight - innerHeight)}`;
  }

  function readPage({ filter, ref, maxChars }) {
    prune();
    const limit = Number(maxChars) > 0 ? Number(maxChars) : 30000;
    const flat = filter === "interactive";
    const lines = [];
    let size = 0;
    let cut = false;
    const emit = (depth, text) => {
      const line = (flat ? "" : "  ".repeat(Math.min(depth, 12))) + text;
      size += line.length + 1;
      if (size > limit) cut = true;
      else lines.push(line);
    };
    const visit = (node, depth) => {
      if (cut) return;
      if (node.nodeType === 3) {
        const text = flat ? "" : squash(node.nodeValue, 300);
        if (text) emit(depth, `text "${text}"`);
        return;
      }
      if (node.nodeType !== 1 || SKIP.has(node.localName) || !visible(node)) return;
      const role = roleOf(node);
      const interactive = isInteractive(node);
      let descend = !LEAF.has(node.localName);
      let next = depth;
      if (interactive || (role && !flat)) {
        const named = interactive || role === "heading";
        const holdsControls = descend && named && !!node.querySelector(CONTROLS);
        const name = LEAF.has(node.localName) || (named && !holdsControls) ? nameOf(node) : ariaName(node);
        if (named && !holdsControls) descend = false;
        emit(depth, `${role || "clickable"}${name ? ` "${name}"` : ""} [${refFor(node)}]${attrsOf(node)}`);
        next = depth + 1;
      }
      if (descend) for (const child of childrenOf(node)) visit(child, next);
    };
    const root = ref ? elFor(ref) : document.body || document.documentElement;
    if (root) visit(root, 0);
    let text = `${header()}\n\n${lines.join("\n") || (flat ? "No interactive elements found." : "The page is empty.")}`;
    if (cut) text += `\n… cut at ${limit} characters. Narrow it with filter: "interactive", pass a ref to read one subtree, or use find.`;
    return { text };
  }

  function pageText({ maxChars }) {
    const limit = Number(maxChars) > 0 ? Number(maxChars) : 50000;
    const mains = document.querySelectorAll("main, [role=main]");
    const articles = document.querySelectorAll("article");
    const clean = (el) => ((el && el.innerText) || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    let text = clean(mains.length === 1 ? mains[0] : articles.length === 1 ? articles[0] : document.body);
    if (text.length < 200) text = clean(document.body);
    const cut = text.length > limit;
    return { text: `Title: ${document.title}\nURL: ${location.href}\n\n${cut ? `${text.slice(0, limit)}\n… cut at ${limit} characters of ${text.length}.` : text}` };
  }

  const TEXT_ROLES = ["textbox", "searchbox", "combobox", "spinbutton"];
  const ROLE_WORDS = {
    button: ["button"], btn: ["button"], link: ["link"], field: TEXT_ROLES, input: TEXT_ROLES, textbox: TEXT_ROLES, box: TEXT_ROLES, bar: TEXT_ROLES,
    checkbox: ["checkbox", "switch"], radio: ["radio"], dropdown: ["combobox", "listbox"], select: ["combobox", "listbox"],
    image: ["image"], img: ["image"], picture: ["image"], icon: ["image"], heading: ["heading"], tab: ["tab"],
  };

  function find({ query }) {
    prune();
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) throw new Error("query is empty.");
    const wanted = new Set();
    const terms = [];
    for (const word of words) {
      if (ROLE_WORDS[word]) ROLE_WORDS[word].forEach((role) => wanted.add(role));
      else terms.push(word);
    }
    const phrase = terms.join(" ");
    const found = [];
    const stack = [document.body || document.documentElement];
    let seen = 0;
    while (stack.length && seen < 20000) {
      const el = stack.pop();
      if (!el || el.nodeType !== 1 || SKIP.has(el.localName) || !visible(el)) continue;
      seen++;
      if (!LEAF.has(el.localName)) for (const child of childrenOf(el)) if (child.nodeType === 1) stack.push(child);
      const role = roleOf(el);
      const interactive = isInteractive(el);
      let name = "";
      if (interactive || role === "heading" || role === "image") name = nameOf(el);
      else {
        for (const child of el.childNodes) if (child.nodeType === 3) name += child.nodeValue;
        name = squash(name);
        if (!name) continue;
      }
      const lower = name.toLowerCase();
      const hay = [lower, el.getAttribute("placeholder"), el.getAttribute("title"), el.getAttribute("alt"), el.id, el.getAttribute("name"), el.getAttribute("type"), typeof el.className === "string" ? el.className : ""]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      let score = 0;
      if (terms.length) {
        const hits = terms.filter((term) => hay.includes(term)).length;
        if (!hits) continue;
        score += 15 * hits + (hits === terms.length ? 20 : 0);
        if (lower === phrase) score += 100;
        else if (lower.startsWith(phrase)) score += 70;
        else if (lower.includes(phrase)) score += 50;
      }
      if (wanted.size) {
        if (wanted.has(role)) score += terms.length ? 30 : 60;
        else if (!terms.length) continue;
        else score -= 10;
      }
      if (interactive) score += 10;
      score -= Math.min(name.length, 200) / 40;
      found.push({ el, role, name, score });
    }
    found.sort((a, b) => b.score - a.score);
    const top = found.slice(0, 20);
    if (!top.length) return { text: `Nothing matches "${query}". Matching is by keyword, so try other words, or use read_page.` };
    const lines = top.map(({ el, role, name }) => {
      const box = el.getBoundingClientRect();
      const x = Math.round(box.left + box.width / 2);
      const y = Math.round(box.top + box.height / 2);
      const where = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight ? `at (${x}, ${y})` : "off screen";
      return `${refFor(el)} ${role || el.localName}${name ? ` "${squash(name, 80)}"` : ""}${attrsOf(el)} ${where}`;
    });
    return { text: `${found.length} match${found.length === 1 ? "" : "es"} for "${query}"${found.length > 20 ? ", best 20" : ""}:\n${lines.join("\n")}` };
  }

  // ------------------------------------------------------------------- pointer

  function hitTest(x, y) {
    let el = document.elementFromPoint(x, y);
    for (let shadow = el && shadowOf(el); shadow; shadow = shadowOf(el)) {
      const inner = shadow.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function deepActive() {
    let el = document.activeElement;
    for (let shadow = el && shadowOf(el); shadow && shadow.activeElement; shadow = shadowOf(el)) el = shadow.activeElement;
    return el;
  }

  function reveal(el) {
    const box = el.getBoundingClientRect();
    if (box.top < 0 || box.left < 0 || box.bottom > innerHeight || box.right > innerWidth) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    }
  }

  function locate(ref, coordinate) {
    if (ref) {
      const el = elFor(ref);
      reveal(el);
      const box = el.getBoundingClientRect();
      const x = Math.round(Math.min(Math.max(box.left + box.width / 2, 0), innerWidth - 1));
      const y = Math.round(Math.min(Math.max(box.top + box.height / 2, 0), innerHeight - 1));
      const hit = hitTest(x, y);
      if (hit && within(hit, el)) return { el: hit, x, y, note: "" };
      return { el, x, y, note: hit && !within(el, hit) ? `, which sits under ${label(hit)}` : "" };
    }
    if (Array.isArray(coordinate) && coordinate.length === 2) {
      const x = Math.round(Number(coordinate[0]));
      const y = Math.round(Number(coordinate[1]));
      const el = hitTest(x, y);
      if (!el) throw new Error(`Nothing at (${x}, ${y}). The viewport is ${innerWidth}x${innerHeight}.`);
      return { el, x, y, note: "" };
    }
    throw new Error("Pass a ref, or coordinate: [x, y].");
  }

  function parseMods(text) {
    const mods = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    for (const part of String(text || "").toLowerCase().split("+")) {
      if (part === "ctrl" || part === "control") mods.ctrlKey = true;
      else if (part === "shift") mods.shiftKey = true;
      else if (part === "alt" || part === "option" || part === "opt") mods.altKey = true;
      else if (["cmd", "command", "meta", "super", "win"].includes(part)) mods.metaKey = true;
    }
    return mods;
  }

  function fire(el, type, x, y, init) {
    const base = { bubbles: !/(enter|leave)$/.test(type), cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, ...init };
    const event = type.startsWith("pointer") ? new PointerEvent(type, { pointerId: 1, pointerType: "mouse", isPrimary: true, ...base }) : new MouseEvent(type, base);
    return el.dispatchEvent(event);
  }

  let hovered = null;

  function hoverOn(el, x, y, mods) {
    if (hovered !== el) {
      if (hovered && hovered.isConnected) {
        fire(hovered, "pointerout", x, y, mods);
        fire(hovered, "mouseout", x, y, mods);
        if (!within(el, hovered)) fire(hovered, "mouseleave", x, y, mods);
      }
      const entering = [];
      for (let at = el; at; at = up(at)) {
        if (hovered && hovered.isConnected && within(hovered, at)) break;
        entering.unshift(at);
      }
      fire(el, "pointerover", x, y, mods);
      fire(el, "mouseover", x, y, mods);
      for (const at of entering) {
        fire(at, "pointerenter", x, y, mods);
        fire(at, "mouseenter", x, y, mods);
      }
      hovered = el;
    }
    fire(el, "pointermove", x, y, mods);
    fire(el, "mousemove", x, y, mods);
  }

  function focusNear(el) {
    for (let at = el; at; at = up(at)) {
      if (at.localName === "label" && at.control) at = at.control;
      if (at.matches(FOCUSABLE) && !at.disabled) {
        at.focus({ preventScroll: true });
        return;
      }
    }
    const current = deepActive();
    if (current && current !== document.body && current.blur) current.blur();
  }

  function press(el, x, y, button, detail, mods) {
    const buttons = button === 2 ? 2 : 1;
    fire(el, "pointerdown", x, y, { button, buttons, ...mods });
    if (fire(el, "mousedown", x, y, { button, buttons, detail, ...mods })) focusNear(el);
    fire(el, "pointerup", x, y, { button, buttons: 0, ...mods });
    fire(el, "mouseup", x, y, { button, buttons: 0, detail, ...mods });
  }

  // Returns the URL of a link that wants a new tab; the background opens it as a controlled tab.
  function clickEvent(el, x, y, detail, mods) {
    let openUrl = null;
    const guard = (event) => {
      if (event.defaultPrevented) return;
      const link = event.composedPath().find((node) => node.localName === "a" && node.href);
      if (!link || !/^https?:/.test(link.href)) return;
      const target = (link.target || "").toLowerCase();
      if (mods.metaKey || mods.ctrlKey || (target && !["_self", "_top", "_parent"].includes(target))) {
        event.preventDefault();
        openUrl = link.href;
      }
    };
    window.addEventListener("click", guard);
    try {
      fire(el, "click", x, y, { button: 0, buttons: 0, detail, ...mods });
    } finally {
      window.removeEventListener("click", guard);
    }
    return openUrl;
  }

  function click({ kind, ref, coordinate, modifiers }) {
    const { el, x, y, note } = locate(ref, coordinate);
    const mods = parseMods(modifiers);
    ripple(x, y);
    hoverOn(el, x, y, mods);
    const what = `${label(el)} at (${x}, ${y})${note}`;
    if (kind === "hover") return { text: `Hovering ${what}.`, notes: notes.splice(0) };
    if (kind === "right") {
      press(el, x, y, 2, 1, mods);
      fire(el, "contextmenu", x, y, { button: 2, buttons: 0, ...mods });
      return { text: `Right-clicked ${what}. Firefox's own context menu cannot be opened this way; only the page's handlers ran.`, notes: notes.splice(0) };
    }
    const count = kind === "double" ? 2 : kind === "triple" ? 3 : 1;
    let openUrl = null;
    for (let detail = 1; detail <= count && el.isConnected; detail++) {
      press(el, x, y, 0, detail, mods);
      openUrl = clickEvent(el, x, y, detail, mods) || openUrl;
    }
    if (count === 2 && el.isConnected) fire(el, "dblclick", x, y, { button: 0, buttons: 0, detail: 2, ...mods });
    if (count === 3 && el.isConnected) {
      const field = deepActive();
      if (field && editable(field) && !field.isContentEditable) field.select();
      else getSelection().selectAllChildren(el);
    }
    return { text: `${count === 1 ? "Clicked" : count === 2 ? "Double-clicked" : "Triple-clicked"} ${what}.`, openUrl, notes: notes.splice(0) };
  }

  // ------------------------------------------------------------------ keyboard

  function editable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.localName === "textarea") return !el.readOnly && !el.disabled;
    if (el.localName !== "input" || el.readOnly || el.disabled) return false;
    return !["checkbox", "radio", "button", "submit", "reset", "file", "image", "range", "color", "hidden"].includes(el.type);
  }

  function insertText(el, text) {
    let done = false;
    try {
      done = document.execCommand("insertText", false, text);
    } catch {}
    if (done) return;
    if (el.isContentEditable) {
      const selection = getSelection();
      if (!selection.rangeCount || !within(selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement, el)) {
        selection.selectAllChildren(el);
        selection.collapseToEnd();
      }
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      selection.collapseToEnd();
    } else {
      let start = null;
      let end = null;
      try {
        start = el.selectionStart;
        end = el.selectionEnd;
      } catch {}
      if (start == null) el.value += text;
      else el.setRangeText(text, start, end, "end");
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
  }

  const NAMED_KEYS = {
    enter: ["Enter", "Enter", 13], return: ["Enter", "Enter", 13], tab: ["Tab", "Tab", 9], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
    backspace: ["Backspace", "Backspace", 8], delete: ["Delete", "Delete", 46], space: [" ", "Space", 32],
    arrowup: ["ArrowUp", "ArrowUp", 38], up: ["ArrowUp", "ArrowUp", 38], arrowdown: ["ArrowDown", "ArrowDown", 40], down: ["ArrowDown", "ArrowDown", 40],
    arrowleft: ["ArrowLeft", "ArrowLeft", 37], left: ["ArrowLeft", "ArrowLeft", 37], arrowright: ["ArrowRight", "ArrowRight", 39], right: ["ArrowRight", "ArrowRight", 39],
    home: ["Home", "Home", 36], end: ["End", "End", 35], pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34],
  };

  function parseKey(combo) {
    const parts = combo === "+" ? ["+"] : combo.split("+");
    const name = parts.pop() || "+";
    const mods = parseMods(parts.join("+"));
    const known = NAMED_KEYS[name.toLowerCase()];
    if (known) return { key: known[0], code: known[1], keyCode: known[2], ...mods };
    if (/^f\d{1,2}$/i.test(name)) return { key: name.toUpperCase(), code: name.toUpperCase(), keyCode: 111 + Number(name.slice(1)), ...mods };
    if ([...name].length === 1) {
      const upper = name.toUpperCase();
      const code = /[a-z]/i.test(name) ? `Key${upper}` : /\d/.test(name) ? `Digit${name}` : "";
      return { key: mods.shiftKey ? upper : name, code, keyCode: upper.charCodeAt(0), ...mods };
    }
    throw new Error(`Unknown key "${combo}". Examples: Enter, Tab, Escape, Backspace, ArrowDown, cmd+a.`);
  }

  function keyEvent(el, type, key) {
    const { keyCode, ...rest } = key;
    return el.dispatchEvent(
      new KeyboardEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, keyCode, which: keyCode, charCode: type === "keypress" ? key.key.charCodeAt(0) : 0, ...rest })
    );
  }

  function moveFocus(step) {
    const list = [...document.querySelectorAll(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && !el.disabled && visible(el));
    if (!list.length) return;
    const at = list.indexOf(deepActive());
    const next = at < 0 ? list[step > 0 ? 0 : list.length - 1] : list[(at + step + list.length) % list.length];
    next.focus();
    if (editable(next) && !next.isContentEditable) {
      try {
        next.select();
      } catch {}
    }
  }

  const stepChange = (el) => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  // Synthetic key events never trigger what the browser normally does, so the common cases are done by hand.
  function defaultAction(el, key, printable) {
    const tag = el.localName;
    const role = el.getAttribute("role") || "";
    const canEdit = editable(el);
    if (key.metaKey || key.ctrlKey) {
      if (key.key.toLowerCase() !== "a") return "";
      if (canEdit && !el.isContentEditable) el.select();
      else document.execCommand("selectAll");
      return "selected everything";
    }
    switch (key.key) {
      case "Enter": {
        if (tag === "textarea") return insertText(el, "\n"), "";
        if (el.isContentEditable) return document.execCommand("insertParagraph"), "";
        if (tag === "input") {
          if (!el.form) return "";
          const submitter = el.form.querySelector("button:not([type]), button[type=submit], input[type=submit], input[type=image]");
          if (!submitter) el.form.requestSubmit();
          else if (!submitter.disabled) submitter.click();
          return "submitted the form";
        }
        if ((tag === "a" && el.href) || tag === "button" || tag === "summary" || CLICK_ROLES.has(role)) return el.click(), "activated it";
        return "";
      }
      case " ": {
        if (canEdit) return insertText(el, " "), "";
        if (tag === "button" || tag === "summary" || tag === "input" || ["button", "checkbox", "switch", "radio", "tab"].includes(role)) return el.click(), "activated it";
        return window.scrollBy(0, innerHeight * 0.9), "scrolled the page";
      }
      case "Tab":
        return moveFocus(key.shiftKey ? -1 : 1), `focus is on ${label(deepActive())}`;
      case "Backspace":
        return canEdit && document.execCommand("delete"), "";
      case "Delete":
        return canEdit && document.execCommand("forwardDelete"), "";
      case "ArrowDown":
      case "ArrowUp": {
        const step = key.key === "ArrowDown" ? 1 : -1;
        if (tag === "select") {
          const index = Math.min(Math.max(el.selectedIndex + step, 0), el.options.length - 1);
          if (index !== el.selectedIndex) {
            el.selectedIndex = index;
            stepChange(el);
          }
          return `selected "${squash(el.options[index] ? el.options[index].text : "", 40)}"`;
        }
        return canEdit || window.scrollBy(0, 40 * step), "";
      }
      case "ArrowLeft":
      case "ArrowRight":
        return canEdit || window.scrollBy(key.key === "ArrowRight" ? 40 : -40, 0), "";
      case "PageDown":
      case "PageUp":
        return canEdit || window.scrollBy(0, innerHeight * (key.key === "PageDown" ? 0.9 : -0.9)), "";
      case "Home":
        return canEdit || window.scrollTo(scrollX, 0), "";
      case "End":
        return canEdit || window.scrollTo(scrollX, document.documentElement.scrollHeight), "";
      default:
        if (printable && canEdit) insertText(el, key.key);
        return "";
    }
  }

  function pressKey(combo) {
    const key = parseKey(combo);
    const el = deepActive() || document.body;
    const printable = key.key.length === 1 && !key.ctrlKey && !key.metaKey && !key.altKey;
    let outcome = "";
    if (keyEvent(el, "keydown", key) && (!(printable || key.key === "Enter") || keyEvent(el, "keypress", key))) {
      outcome = defaultAction(el, key, printable);
    }
    if (el.isConnected) keyEvent(el, "keyup", key);
    return outcome;
  }

  function key({ keys }) {
    const combos = keys.trim().split(/\s+/).filter(Boolean);
    if (!combos.length) throw new Error("text must hold the keys to press, such as \"Enter\" or \"cmd+a\".");
    const outcomes = combos.map(pressKey).filter(Boolean);
    return { text: `Pressed ${combos.join(" ")}${outcomes.length ? `: ${outcomes.join("; ")}` : ""}.`, notes: notes.splice(0) };
  }

  function type({ text, ref }) {
    if (ref) {
      const wanted = elFor(ref);
      reveal(wanted);
      focusNear(wanted);
    }
    const el = deepActive();
    if (!el || el === document.body || el === document.documentElement) throw new Error("Nothing is focused. Click a text field first, or pass its ref.");
    if (el.localName === "iframe") throw new Error("The focus is inside an iframe, which this version cannot reach.");
    ensureIndicator();
    if (!editable(el)) {
      for (const char of text) pressKey(char === " " ? "space" : char);
      return { text: `${label(el)} is not a text field, so ${[...text].length} key presses were sent to it instead.`, notes: notes.splice(0) };
    }
    const last = parseKey([...text].pop() === " " ? "space" : [...text].pop() || "a");
    keyEvent(el, "keydown", last);
    insertText(el, text);
    if (el.isConnected) keyEvent(el, "keyup", last);
    return { text: `Typed ${JSON.stringify(squash(text, 80))} into ${label(el)}.`, notes: notes.splice(0) };
  }

  // -------------------------------------------------------------------- forms

  function setValue({ ref, value }) {
    const el = elFor(ref);
    reveal(el);
    const tag = el.localName;
    if (tag === "select") {
      const wanted = (Array.isArray(value) ? value : [value]).map((item) => String(item).trim().toLowerCase());
      const chosen = [];
      for (const option of el.options) {
        const hit = wanted.includes(option.value.toLowerCase()) || wanted.includes(option.text.trim().toLowerCase());
        if (hit) chosen.push(option);
        if (el.multiple) option.selected = hit;
      }
      if (!chosen.length) throw new Error(`No option matches ${JSON.stringify(value)}. Options: ${[...el.options].slice(0, 30).map((option) => option.text.trim()).join(" | ")}`);
      if (!el.multiple) el.value = chosen[0].value;
      stepChange(el);
      return { text: `Selected "${chosen.map((option) => option.text.trim()).join('", "')}" in ${label(el)}.`, notes: notes.splice(0) };
    }
    if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) {
      const want = value === true || ["true", "on", "1", "yes", "checked"].includes(String(value).toLowerCase());
      if (el.type === "radio" && !want) throw new Error("A radio button can only be turned on. Set another one in the group instead.");
      if (el.checked !== want) el.click();
      return { text: `${label(el)} is now ${el.checked ? "checked" : "unchecked"}.`, notes: notes.splice(0) };
    }
    if (tag === "input" && el.type === "file") throw new Error("File inputs cannot be filled from an extension.");
    if (tag === "input" || tag === "textarea") {
      el.focus({ preventScroll: true });
      // Assigned through the extension's view of the element: the native setter runs, and frameworks notice on the input event.
      el.value = String(value);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: String(value) }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      const kept = el.value === String(value);
      return { text: kept ? `Set ${label(el)}.` : `${label(el)} did not keep that value (it now holds ${JSON.stringify(el.value)}). Check the format this field expects.`, notes: notes.splice(0) };
    }
    if (el.isContentEditable) {
      el.focus({ preventScroll: true });
      getSelection().selectAllChildren(el);
      insertText(el, String(value));
      return { text: `Replaced the text of ${label(el)}.`, notes: notes.splice(0) };
    }
    throw new Error(`${ref} is a <${tag}>, not a form field.`);
  }

  // ------------------------------------------------------------------- scroll

  function scrollerAt(el, dx, dy) {
    for (let at = el; at && at !== document.body && at !== document.documentElement; at = up(at)) {
      const style = getComputedStyle(at);
      const room = (overflow, size, client, pos, delta) =>
        delta && /(auto|scroll|overlay)/.test(overflow) && size > client + 1 && (delta > 0 ? pos + client < size - 1 : pos > 0);
      if (room(style.overflowY, at.scrollHeight, at.clientHeight, at.scrollTop, dy) || room(style.overflowX, at.scrollWidth, at.clientWidth, at.scrollLeft, dx)) return at;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scroll({ coordinate, direction, amount }) {
    const x = Array.isArray(coordinate) ? Math.round(Number(coordinate[0])) : Math.round(innerWidth / 2);
    const y = Array.isArray(coordinate) ? Math.round(Number(coordinate[1])) : Math.round(innerHeight / 2);
    const distance = (Number(amount) > 0 ? Number(amount) : 3) * 100;
    const vector = { up: [0, -distance], down: [0, distance], left: [-distance, 0], right: [distance, 0] }[direction];
    if (!vector) throw new Error("scroll_direction must be up, down, left or right.");
    const [dx, dy] = vector;
    const target = hitTest(x, y) || document.documentElement;
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, deltaX: dx, deltaY: dy, deltaMode: 0 });
    if (!target.dispatchEvent(wheel)) return { text: `The page handled the wheel itself (${direction}, ${distance} px).` };
    const box = scrollerAt(target, dx, dy);
    const before = [box.scrollLeft, box.scrollTop];
    box.scrollBy({ left: dx, top: dy, behavior: "instant" });
    const moved = Math.round(Math.abs(box.scrollLeft - before[0]) + Math.abs(box.scrollTop - before[1]));
    const root = document.scrollingElement || document.documentElement;
    const where = `The page is at y=${Math.round(scrollY)} of ${Math.max(0, root.scrollHeight - innerHeight)}.`;
    return { text: moved ? `Scrolled ${direction} ${moved} px. ${where}` : `Nothing moved: already at the ${direction === "down" ? "bottom" : direction === "up" ? "top" : "edge"}. ${where}` };
  }

  function scrollTo({ ref }) {
    const el = elFor(ref);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const box = el.getBoundingClientRect();
    return { text: `${label(el)} is now at (${Math.round(box.left + box.width / 2)}, ${Math.round(box.top + box.height / 2)}).` };
  }

  // --------------------------------------------------------------- javascript

  async function evaluate({ code, serialize }) {
    const source = `(async () => ${serialize}(await (0, eval)(${JSON.stringify(code)})))()`;
    let pending;
    try {
      pending = window.eval(source); // the page's own eval: runs with the page's globals, under the page's CSP
    } catch {
      return { blocked: true };
    }
    try {
      return { text: String(await pending) };
    } catch (error) {
      return { failed: true, text: early.show(error) };
    }
  }

  // ----------------------------------------------------------------- messages

  const handlers = {
    ping: () => ({}),
    config(message) {
      if (message.dialog) dialog = message.dialog;
      ensureIndicator();
      return {};
    },
    // Leaves the page as it was found; a later injection starts from scratch.
    release() {
      active = false;
      restore();
      early.stop();
      if (frame) frame.host.remove();
      browser.runtime.onMessage.removeListener(onMessage);
      globalThis.__kamurafox = false;
      return {};
    },
    drain: () => ({ entries: early.drain() }),
    async beforeShot() {
      if (frame) frame.host.style.display = "none";
      await new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
        setTimeout(resolve, 80);
      });
      return { width: innerWidth, height: innerHeight, scrollX, scrollY };
    },
    afterShot() {
      if (frame) frame.host.style.display = "";
      return {};
    },
    readPage,
    pageText,
    find,
    click,
    type,
    key,
    scroll,
    scrollTo,
    setValue,
    evaluate,
  };

  function onMessage(message) {
    if (!message || typeof message.kfx !== "string") return undefined;
    const handler = handlers[message.kfx];
    if (!handler) return Promise.resolve({ error: `Unknown command: ${message.kfx}` });
    return Promise.resolve()
      .then(() => handler(message))
      .then(
        (result) => ({ ok: true, ...result }),
        (error) => ({ error: String((error && error.message) || error) })
      );
  }
  browser.runtime.onMessage.addListener(onMessage);

  ensureIndicator();
  document.addEventListener("DOMContentLoaded", ensureIndicator, { once: true });
})();
