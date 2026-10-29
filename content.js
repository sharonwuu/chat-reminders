// Adds a hover "Remind me" button to Google Chat messages.
// Chat's DOM is obfuscated and changes; every selector lives here so fixes are one-line.
const SELECTORS = {
  // One single message (verified against Chat's markup: role=group, data-id = message id, data-user-id = author).
  messageRow: "[data-message-multiplat-item-id]",
  // Used only when the above isn't present: older / other views. Note data-topic-id is a whole thread.
  fallbackRow: "[data-message-id], [data-topic-id]",
  // Never offer the button inside the side panel / navigation (space list, etc.).
  excluded: "nav, [role='navigation'], [role='tree'], [role='banner']",
};
const SNIPPET_LEN = 400;

// Quick options for the menu (user-editable on the options page), kept in sync with storage.
let presetData = RTime.sanitizePresets();
let presets = RTime.buildPresets(presetData);
let menu, activeRow, launcherEl, panelEl, placeTimer, labelObserver, labelTick;

// After the extension is reloaded/updated, the old content script keeps running in open tabs and every
// chrome.* call throws "Extension context invalidated". Detect that and tear the old instance down quietly.
const alive = () => {
  try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
};
function shutdown() {
  clearInterval(placeTimer);
  [menu, launcherEl, panelEl].forEach((el) => el && el.remove());
  document.querySelectorAll(".gcr-inline, .gcr-label").forEach((el) => el.remove());
  document.querySelectorAll(".gcr-has-reminder").forEach((el) => el.classList.remove("gcr-has-reminder", "gcr-reminder-due", "gcr-reminder-dark"));
  labelObserver && labelObserver.disconnect();
  clearInterval(labelTick);
  document.removeEventListener("mouseover", onMouseOver);
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("scroll", onScroll, true);
}

// Chat's theme can differ from the OS theme, so judge by the page's actual background.
function isDarkPage() {
  for (const el of [document.body, document.documentElement]) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(getComputedStyle(el).backgroundColor);
    if (m && (m[4] === undefined || +m[4] > 0.5)) return (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) < 128;
  }
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

function themed(el) {
  el.classList.toggle("gcr-dark", isDarkPage());
  return el;
}

// Make a floating surface follow the user's Chat theme (not just light/dark): take the surface and text colours
// from the page (sidebar area; body inside iframes) and New chat's fill for hover, via the --gcr-* variables.
function chatTheme(el) {
  const solid = (n) => {
    for (; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (!/^rgba\(.*,\s*0\)$|^transparent$/.test(c)) return c;
    }
    return "";
  };
  themed(el);
  const under = (window.top === window && document.elementFromPoint(24, Math.min(300, innerHeight - 2))) || document.body;
  const bg = solid(under) || solid(document.body);
  const fg = getComputedStyle(under).color;
  const fill = launcherEl && launcherEl.style.getPropertyValue("--gcr-pill-bg");
  if (bg) el.style.setProperty("--gcr-bg", bg);
  if (fg) {
    el.style.setProperty("--gcr-fg", fg);
    el.style.setProperty("--gcr-muted", `color-mix(in srgb, ${fg} 62%, transparent)`);
    el.style.setProperty("--gcr-border", `color-mix(in srgb, ${fg} 16%, transparent)`);
    el.style.setProperty("--gcr-hover", fill || `color-mix(in srgb, ${fg} 10%, transparent)`);
  }
  return el;
}

// Chat's own hover toolbar / menus / tooltips and visually-hidden metadata live inside the message row.
// Their labels must not end up in the reminder text. Selectors are best effort (Chat's markup is obfuscated).
const UI_NODES = "button, [role='button'], [role='toolbar'], [role='menu'], [role='menuitem'], [role='tooltip'], [aria-hidden='true'], [data-tooltip], [data-emoji-picker-button-id], [data-menu-action], .gcr-label, style, script";
const SENDER_SEL = "[data-name], [data-member-id]";

// Metadata phrases Chat injects as hidden text (English + Traditional Chinese).
const NOISE = [
  /Reminder (?:set for|due) [^·]*· View reminders/g,
  /Open in chat/gi, /Open in space/gi, /Copy link/gi, /Reply in thread/gi, /Add reaction/gi, /More actions/gi,
  /\bis the owner\b/gi, /\bis a manager\b/gi, /\bExternal\b(?=\s|,|$)/g,
  /Edited on [A-Za-z]{3,9}\.? \d{1,2}, \d{4}/gi, /\bEdited\b/gi,
  /\d+ repl(?:y|ies)\s*,?\s*(?:Last Reply:?\s*[\d:]+\s*(?:[AP]M)?)?/gi,
  /Last Reply:?\s*[\d:]+\s*(?:[AP]M)?/gi,
  /複製連結/g, /在即時通訊中開啟/g, /在聊天室中開啟/g, /在聊天室開啟/g, /在對話中開啟/g,
  /已於[^,，\s]*編輯/g, /已編輯/g, /\d+\s*則回覆\s*[,，]?\s*(?:最近回覆[:：]?\s*[^,，\s]*)?/g,
  /(?:^|\s):[a-z0-9_+-]{2,30}:(?=\s|$)/gi, /[,，]\s*(?:(?:Yesterday|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+)?(?:(?:上午|下午)\s*)?\d{1,2}:\d{2}\s*(?:[AP]M)?\s*(?=[,，]|$)/gi,
];

// Screen-reader prefixes/suffixes such as "1 unread," at the start or ", min" at the end.
const EDGE_NOISE = [
  /[,，]\s*(?:Yesterday|Today)\s*$/i,
  /^[\s,，]*(?:Yesterday|Today)\s*[,，]\s*/i,
  /^[\s,，]*\d+\s*(?:min|mins|minutes?|hrs?|hours?|secs?|seconds?)\s*[,，]\s*/i,
  /^\s*(?:\d+\s+unread|unread)\s*[,，]?\s*/i,
  /^\s*\d+\s*則未讀\s*[,，]?\s*/,
  /[,，]\s*(?:\d+\s*)?(?:min|mins|minutes?|hrs?|hours?|secs?|seconds?)\.?(?:\s+ago)?\s*$/i,
  /\s\d+\s*(?:min|mins|minutes?|hrs?|hours?|secs?|seconds?)\s+ago\s*$/i,
  /[,，]?\s*\d+\s*(?:分鐘|小時|秒)前\s*$/,
];

// Normalise separators/whitespace and trim stray punctuation from both ends.
function tidy(t) {
  return t
    .replace(/\s+([,，.。])/g, "$1")
    .replace(/(?:\s*[,，]){2,}/g, ",")
    .replace(/^[\s,，.。:：-]+|[\s,，:：-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(raw, sender) {
  let t = raw;
  if (sender) {
    // Your own messages show "You" in place of your name.
    t = t.includes(sender) ? t.split(sender).join(" ") : t.replace(/^\s*You\b/, " ");
  }
  for (const re of NOISE) t = t.replace(re, " ");
  // Tidy first: edge patterns like ", 11 min" only match once trailing separators (", 11 min ,") are gone.
  t = tidy(t);
  for (let i = 0; i < 3; i++) for (const re of EDGE_NOISE) t = tidy(t.replace(re, ""));
  return t;
}

function senderOf(row) {
  const uid = row.getAttribute && row.getAttribute("data-user-id");
  const author = uid && row.querySelector(`[data-member-id="${CSS.escape(uid)}"]`);
  if (author) return (author.getAttribute("data-name") || author.textContent || "").replace(/\s+/g, " ").trim();
  // Grouped messages omit the name, so also look at the preceding siblings.
  let el = row;
  for (let i = 0; el && i < 12; i++, el = el.previousElementSibling) {
    const s = el.querySelector(SENDER_SEL) || (el.matches(SENDER_SEL) ? el : null);
    if (s) return (s.getAttribute("data-name") || s.textContent || "").replace(/\s+/g, " ").trim();
  }
  return "";
}

function extract(row) {
  const sender = senderOf(row);
  const parts = [];
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.nodeType === Node.ELEMENT_NODE && n.matches(UI_NODES) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) parts.push(n.nodeValue);
    else if (/^(DIV|P|BR|LI)$/.test(n.tagName)) parts.push(" ");
  }
  let text = cleanText(parts.join(""), sender);
  // The filters above can swallow everything (e.g. when a thread reply sits inside a button-like wrapper).
  // Fall back to the row's plain visible text rather than saving an empty placeholder.
  if (!text) text = cleanText((row.innerText || row.textContent || "").replace(/\s+/g, " "), sender);
  text = text.slice(0, SNIPPET_LEN);
  return { text: text || RTime.t("msg_fallback"), sender };
}

// Chat's message links look like  https://chat.google.com/room/<space>/<topic>/<message>?cls=10
// (a top-level message has topic == message; a thread reply keeps the topic and has its own message id).
const ID_RE = /^[A-Za-z0-9_-]{8,16}$/;
const lastToken = (v) => String(v || "").split(/[\/:]/).filter(Boolean).pop() || "";

function spaceId() {
  const s = location.pathname + location.hash;
  for (const m of s.matchAll(/(?:chat|room|dm|space)\/([A-Za-z0-9_-]{8,})/g)) return m[1];
  return "";
}

function permalink(row) {
  // Message id: the single-message element's data-id ("MSG_LIST/yt/<id>"); topic id: the enclosing thread.
  const msgEl = row.closest("[data-message-multiplat-item-id]");
  const topicEl = row.closest("[data-topic-id]") || row.querySelector("[data-topic-id]");
  const topic = lastToken(topicEl && topicEl.getAttribute("data-topic-id"));
  const msg =
    lastToken(msgEl && (msgEl.getAttribute("data-id") || msgEl.getAttribute("data-message-multiplat-item-id"))) ||
    lastToken((row.closest("[data-message-id]") || row).getAttribute("data-message-id")) ||
    topic;
  const space = spaceId();
  if (space && ID_RE.test(topic || msg) && ID_RE.test(msg)) {
    return `https://chat.google.com/room/${space}/${topic || msg}/${msg}?cls=10`;
  }
  return location.href; // couldn't identify the message: open the space/DM instead
}

// Links Chat itself copied via its "Copy link" action (reported by hook.js running in the page world).
const copiedLinks = [];
window.addEventListener("message", (e) => {
  if (e.source === window && e.data && e.data.gcr === "copied-link") {
    copiedLinks.push({ at: new Date().toISOString(), link: String(e.data.text).slice(0, 500) });
    if (copiedLinks.length > 5) copiedLinks.shift();
  }
});

// Shift+click on the clock button copies what the extension sees (row HTML + extracted result) to the clipboard,
// for debugging selectors against Chat's real markup.
async function copyDebug(row) {
  // Ancestry of the point the mouse was on (up to 30 levels) with per-level stats, to find where one message ends.
  const hoverChain = [];
  for (let el = lastTarget, i = 0; el && el !== document.body && i < 30; el = el.parentElement, i++) {
    hoverChain.push({
      tag: el.tagName.toLowerCase(),
      attrs: Object.fromEntries([...el.attributes].filter((a) => /^(role|data-|aria-label|jsname|id)/.test(a.name)).map((a) => [a.name, a.value.slice(0, 80)])),
      toolbars: el.querySelectorAll(TOOLBAR).length,
      senders: el.querySelectorAll(SENDER_SEL).length,
      textLen: (el.innerText || "").length,
      text: (el.innerText || "").replace(/\s+/g, " ").slice(0, 60),
    });
  }
  // Every labelled button in the row (hidden ones too: Chat hides the toolbar once the pointer leaves the
  // message), to see why findToolbarAnchor() missed it.
  const toolbarButtons = [...row.querySelectorAll("button, [role='button']")]
    .slice(0, 30)
    .map((b) => ({
      label: labelOf(b).slice(0, 60),
      matchesLabels: TOOLBAR_LABELS.test(labelOf(b)),
      visible: !!b.offsetParent,
      inToolbar: !!b.closest(TOOLBAR),
    }));
  // Every "More actions" slot on the page and how far it is from the row (findNearbyToolbarAnchor() needs it
  // visible and within NEARBY_TOOLBAR_PX).
  const rr = row.getBoundingClientRect();
  const moreSlots = [...document.querySelectorAll("[data-more-actions-menu-button-id]")].slice(0, 20).map((m) => {
    const more = m.nextElementSibling;
    const b = more && more.getBoundingClientRect();
    return {
      hasNext: !!more,
      visible: !!(more && more.offsetParent),
      inRow: row.contains(m),
      dist: b ? Math.round(b.bottom < rr.top ? rr.top - b.bottom : b.top > rr.bottom ? b.top - rr.bottom : 0) : null,
    };
  });
  const info = { extracted: extract(row), copiedLinks, hoverChain, toolbarButtons, moreSlots, anchorFound: !!findToolbarAnchor(row), rowIsToolbar: row.matches(TOOLBAR), permalink: permalink(row), url: location.href };
  try {
    await navigator.clipboard.writeText(JSON.stringify(info, null, 2));
    toast("Debug info copied to clipboard");
  } catch (_) {
    toast("Couldn't copy debug info");
  }
}

function toast(text) {
  const el = document.createElement("div");
  el.className = "gcr-toast";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

function send(msg) {
  if (!alive()) { shutdown(); return Promise.reject(new Error("extension reloaded")); }
  return chrome.runtime.sendMessage(msg).then((r) => {
    if (!r || !r.ok) throw new Error((r && r.error) || "no response");
    return r.data;
  });
}

async function remindAt(row, when) {
  try {
    const { text, sender } = extract(row);
    await send({ type: "add", text, sender, when, url: permalink(row), source: "message" });
    toast(RTime.t("toast_set", { when: RTime.formatWhen(when) }));
  } catch (e) {
    toast(RTime.t("toast_fail"));
  }
}

function closeMenu() {
  menu && menu.remove();
  menu = null;
}

function savePresets(list) {
  presetData = RTime.sanitizePresets(list);
  presets = RTime.buildPresets(presetData);
  if (alive()) chrome.storage.local.set({ presets: presetData }).catch(() => {});
}

function openMenu(row, anchor) {
  closeMenu();
  menu = document.createElement("div");
  menu.className = "gcr-menu";
  chatTheme(menu);
  // Typing in the menu's fields must not trigger Chat's keyboard shortcuts.
  menu.addEventListener("keydown", (e) => e.stopPropagation());
  menu.addEventListener("keyup", (e) => e.stopPropagation());
  const mk = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    if (tag === "button") n.type = "button";
    return n;
  };

  const head = mk("div", "gcr-menu-head");
  const title = mk("span", null, RTime.t("remind_me"));
  const toggle = mk("button", "gcr-menu-edit", RTime.t("edit"));
  head.append(title, toggle);
  const body = mk("div", "gcr-menu-body");
  menu.append(head, body);
  let editing = false;

  const unitFor = (min) => (min % 1440 === 0 ? 1440 : min % 60 === 0 ? 60 : 1);

  // Normal mode: the quick options, then a custom date/time.
  const renderList = () => {
    presets.forEach((p) => {
      const at = p.at(Date.now());
      const b = mk("button", "gcr-menu-item", p.label);
      if (!/\d:\d/.test(p.label)) b.appendChild(mk("span", "gcr-menu-hint", RTime.formatTime(at)));
      b.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); remindAt(row, at); });
      body.appendChild(b);
    });
    body.append(mk("div", "gcr-menu-sep"), mk("div", "gcr-menu-sub", RTime.t("custom_time")));
    const picker = RTime.createPicker(Date.now() + 3600e3);
    const go = mk("button", "gcr-menu-primary", RTime.t("set_reminder"));
    go.addEventListener("click", (e) => {
      e.stopPropagation();
      const when = picker.get();
      if (!Number.isFinite(when)) return;
      closeMenu();
      remindAt(row, when);
    });
    body.append(picker.el, go);
  };

  // Edit mode: the same list, editable in place. Every change is saved straight away.
  const renderEdit = () => {
    presetData.forEach((o, i) => {
      const li = mk("div", "gcr-menu-row");
      if (o.kind === "tomorrow") {
        const time = mk("input");
        time.type = "time";
        time.value = o.time;
        time.addEventListener("change", () => { if (time.value) { const l = presetData.slice(); l[i] = { kind: "tomorrow", time: time.value }; savePresets(l); render(); } });
        li.append(mk("span", "gcr-menu-rowlabel", RTime.t("opt_tomorrow")), time);
      } else {
        const unit = unitFor(o.minutes);
        const num = mk("input");
        num.type = "number";
        num.min = "1";
        num.step = "1";
        num.value = String(o.minutes / unit);
        const sel = mk("select");
        for (const [key, mult] of [["unit_min", 1], ["unit_hr", 60], ["unit_day", 1440]]) {
          const opt = mk("option", null, RTime.t(key));
          opt.value = String(mult);
          opt.selected = mult === unit;
          sel.appendChild(opt);
        }
        const commit = () => {
          const n = parseFloat(num.value);
          if (n > 0) { const l = presetData.slice(); l[i] = { kind: "in", minutes: Math.round(n * +sel.value) }; savePresets(l); }
          render();
        };
        num.addEventListener("change", commit);
        sel.addEventListener("change", commit);
        li.append(num, sel);
      }
      const x = mk("button", "gcr-menu-x");
      x.title = RTime.t("remove");
      x.setAttribute("aria-label", RTime.t("remove"));
      x.appendChild(RTime.icon("close", 14));
      x.addEventListener("click", (e) => { e.stopPropagation(); savePresets(presetData.filter((_, j) => j !== i)); render(); });
      li.appendChild(x);
      body.appendChild(li);
    });
    const full = presetData.length >= RTime.MAX_PRESETS;
    const addIn = mk("button", "gcr-menu-link", "+ " + RTime.t("opt_add_in"));
    const addTmr = mk("button", "gcr-menu-link", "+ " + RTime.t("opt_add_tmr"));
    addIn.disabled = addTmr.disabled = full;
    addIn.addEventListener("click", (e) => { e.stopPropagation(); savePresets([...presetData, { kind: "in", minutes: 30 }]); render(); });
    addTmr.addEventListener("click", (e) => { e.stopPropagation(); savePresets([...presetData, { kind: "tomorrow", time: "09:00" }]); render(); });
    const reset = mk("button", "gcr-menu-link", RTime.t("opt_reset"));
    reset.addEventListener("click", (e) => { e.stopPropagation(); savePresets(RTime.DEFAULT_PRESETS); render(); });
    body.append(mk("div", "gcr-menu-sep"), addIn, addTmr, mk("div", "gcr-menu-sep"), reset);
    if (full) body.appendChild(mk("div", "gcr-menu-sub", RTime.t("opt_max", { n: RTime.MAX_PRESETS })));
  };

  const r = anchor.getBoundingClientRect();
  const M = 8; // margin kept to the viewport edges
  // Fit the whole menu on screen: open below the button if it fits, else above, else take the larger side and
  // scroll inside the menu. Re-measured whenever the content changes (mode switch, added/removed option).
  const fit = (first) => {
    menu.style.maxHeight = "";
    const full = menu.scrollHeight + 2;
    const below = window.innerHeight - r.bottom - M - 4;
    const above = r.top - M - 4;
    let top, maxH;
    if (full <= below) { top = r.bottom + 4; maxH = below; }
    else if (full <= above) { top = r.top - 4 - full; maxH = above; }
    else if (below >= above) { top = r.bottom + 4; maxH = below; }
    else { maxH = above; top = Math.max(M, r.top - 4 - Math.min(full, maxH)); }
    menu.style.maxHeight = `${Math.max(120, maxH)}px`;
    menu.style.overflowY = "auto";
    menu.style.top = `${Math.max(M, top)}px`;
    if (first) {
      menu.style.left = `${Math.max(M, Math.min(r.right - 264, window.innerWidth - 264 - 2 * M))}px`;
      menu.style.transformOrigin = `${Math.max(0, Math.round(r.left + r.width / 2 - parseFloat(menu.style.left)))}px ${top >= r.bottom ? "top" : "bottom"}`;
    }
  };

  const render = () => {
    body.replaceChildren();
    toggle.textContent = RTime.t(editing ? "done" : "edit");
    (editing ? renderEdit : renderList)();
    if (menu.isConnected) fit(false);
  };
  toggle.addEventListener("click", (e) => { e.stopPropagation(); editing = !editing; render(); });

  menu.style.visibility = "hidden";
  render();
  document.body.appendChild(menu);
  fit(true);
  menu.style.visibility = "";
  requestAnimationFrame(() => menu && menu.classList.add("gcr-open"));
}

// Chat's own hover toolbar (reactions, reply, more...). We put our clock button inside it, next to its
// "More" button, so it looks native. Found by the buttons' aria-labels since the markup is obfuscated.
// Only the hover toolbar has a "More actions" button; "Reply" / "Add reaction" also exist elsewhere on a message
// (under it, next to reaction chips), which put the clock in the wrong place.
const TOOLBAR_LABELS = /^(more actions|more|更多)/i;
const labelOf = (el) => (el.getAttribute("aria-label") || el.getAttribute("data-tooltip") || "").trim();
const buttonCount = (el) => el.querySelectorAll("button, [role='button']").length;

function findToolbarAnchor(row) {
  const roots = row.matches(SELECTORS.messageRow) ? [row] : [row, row.parentElement];
  for (const root of roots) {
    if (!root) continue;
    let cands = [...root.querySelectorAll("button[aria-label], [role='button'][aria-label]")].filter((b) =>
      TOOLBAR_LABELS.test(labelOf(b))
    );
    if (!cands.length) continue;
    // A thread holds several messages (and toolbars): use the toolbar belonging to the message under the pointer.
    for (let el = lastTarget; el && el !== root.parentElement; el = el.parentElement) {
      const inside = cands.filter((b) => el.contains(b));
      if (inside.length) { cands = inside; break; }
    }
    let child = cands.find((b) => /^(more|更多)/i.test(labelOf(b))) || cands[cands.length - 1];
    // Climb to the direct child of the container that holds the toolbar's buttons.
    while (child.parentElement && child.parentElement !== root && buttonCount(child.parentElement) < 3) {
      child = child.parentElement;
    }
    return child;
  }
  return findNearbyToolbarAnchor(row);
}

// In compact mode the hover toolbar isn't inside the message's subtree. Fall back to the visible toolbar that
// sits on (or just above/below) the hovered message. `data-more-actions-menu-button-id` marks the slot right
// before the toolbar's "More actions" button and isn't obfuscated.
const NEARBY_TOOLBAR_PX = 48;
function findNearbyToolbarAnchor(row) {
  const r = row.getBoundingClientRect();
  let best = null;
  let bestDist = Infinity;
  for (const marker of document.querySelectorAll("[data-more-actions-menu-button-id]")) {
    const more = marker.nextElementSibling;
    if (!more || !more.offsetParent) continue;
    const b = more.getBoundingClientRect();
    const dist = b.bottom < r.top ? r.top - b.bottom : b.top > r.bottom ? b.top - r.bottom : 0;
    if (dist < bestDist) { best = more; bestDist = dist; }
  }
  return bestDist <= NEARBY_TOOLBAR_PX ? best : null;
}

// The toolbar sits inside the message bubble, so `color: inherit` picks up the bubble's text color (white on
// your own messages in light + compact mode). Copy the color Chat paints its own toolbar icons with instead.
function toolbarIconColor(anchor) {
  const svg = anchor.querySelector("svg");
  return svg ? getComputedStyle(svg).fill : getComputedStyle(anchor).color;
}

function injectInline(row) {
  const anchor = findToolbarAnchor(row);
  if (!anchor || !anchor.parentElement) return false;
  const parent = anchor.parentElement;
  // Only one toolbar is visible at a time: drop stray copies left in other containers (e.g. from nested
  // thread rows or earlier hovers) so the toolbar never shows two clocks.
  document.querySelectorAll(".gcr-inline").forEach((el) => el.parentElement !== parent && el.remove());
  const existing = [...parent.children].filter((el) => el.classList.contains("gcr-inline"));
  existing.slice(1).forEach((el) => el.remove());
  if (existing.length) {
    // Keep the click handler bound to the row currently being hovered.
    existing[0]._gcrRow = row;
    existing[0].style.color = toolbarIconColor(anchor);
    return true;
  }
  const b = document.createElement("button");
  b.type = "button";
  b.className = "gcr-inline";
  b.style.color = toolbarIconColor(anchor);
  b.title = RTime.t("remind_title");
  b.appendChild(RTime.icon("clock", 20));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const target = b._gcrRow || row;
    activeRow = target;
    if (e.shiftKey) copyDebug(target);
    else if (menu) closeMenu();
    else openMenu(target, b);
  });
  b._gcrRow = row;
  parent.insertBefore(b, anchor);
  return true;
}

// The clock only ever lives in Chat's own hover toolbar: if the toolbar can't be found, no clock is shown.
function showFor(row) {
  activeRow = row;
  // The toolbar may render a moment after the hover starts, so retry briefly.
  const tryInline = () => alive() && activeRow === row && injectInline(row);
  if (tryInline()) return;
  const now = Date.now();
  if (now - (row._gcrRetry || 0) > 1500) {
    row._gcrRetry = now;
    [80, 250, 600, 1200].forEach((ms) => setTimeout(tryInline, ms));
  }
}

let lastTarget = null;

// Chat's per-message hover toolbar is itself tagged with data-topic-id, so it must never be mistaken for the message.
const TOOLBAR = "[data-emoji-picker-button-id], [data-menu-action]";
function rowOf(target) {
  let el = target.closest(SELECTORS.messageRow);
  if (el) return el;
  el = target.closest(SELECTORS.fallbackRow);
  while (el && el.matches(TOOLBAR)) el = el.parentElement && el.parentElement.closest(SELECTORS.fallbackRow);
  return el;
}

function onMouseOver(e) {
  if (!alive()) return shutdown();
  if (!(e.target instanceof Element) || e.target.closest(".gcr-menu")) return;
  // Moving from the message onto its toolbar: keep the message we were on.
  if (e.target.closest(TOOLBAR + ", .gcr-inline")) return;
  lastTarget = e.target;
  const row = rowOf(e.target);
  if (row && !row.closest(SELECTORS.excluded)) showFor(row);
}
function onDocClick(e) {
  if (menu && !(e.target instanceof Element && e.target.closest(".gcr-menu"))) closeMenu();
}
function onScroll(e) {
  if (menu && e && e.target instanceof Node && menu.contains(e.target)) return; // scrolling the menu itself
  closeMenu();
}
document.addEventListener("mouseover", onMouseOver, { passive: true });
document.addEventListener("click", onDocClick);
document.addEventListener("scroll", onScroll, { capture: true, passive: true });

// "Reminder set for ..." label above each message that has an active reminder.
// Chat re-renders messages as you scroll, so labels are re-applied on DOM changes, on storage changes, and
// every minute (to turn "set for" into "due" when the time passes).
let labels = {};
let labelPending = false;

function makeLabel() {
  const el = document.createElement("div");
  el.className = "gcr-label";
  const text = document.createElement("span");
  const view = document.createElement("button");
  view.type = "button";
  view.textContent = RTime.t("view_reminders");
  view.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!alive()) return shutdown();
    launcherEl ? launcherEl.click() : chrome.runtime.sendMessage({ type: "popup" });
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "gcr-label-remove";
  remove.textContent = RTime.t("remove");
  remove.title = RTime.t("remove_title");
  remove.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!alive()) return shutdown();
    const ids = el._gcrIds || [];
    el.remove();
    try { await Promise.all(ids.map((id) => send({ type: "delete", id }))); toast(RTime.t("toast_removed")); } catch (_) { toast(RTime.t("toast_remove_fail")); }
  });
  el.append(RTime.icon("clock", 14), text, document.createTextNode("·"), view, document.createTextNode("·"), remove);
  return el;
}

// In the standard (bubble) layout your own messages sit on the right. Chat's markup doesn't say so, so compare
// where the message's text actually is with the row's edges. Chat's hover toolbar and its tooltips are text in
// the row too, so they're skipped, and the answer is kept per row (until its width changes) so the label never
// jumps while hovering.
function isRightAligned(row) {
  const r = row.getBoundingClientRect();
  if (row._gcrEnd && row._gcrEnd.width === r.width) return row._gcrEnd.end;
  let left = Infinity;
  let right = -Infinity;
  const w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.nodeValue.trim() && !n.parentElement.closest(`.gcr-label, ${UI_NODES}`) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const range = document.createRange();
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    range.selectNodeContents(n);
    const b = range.getBoundingClientRect();
    if (!b.width) continue;
    left = Math.min(left, b.left);
    right = Math.max(right, b.right);
  }
  if (!(right > left)) return false;
  const end = r.right - right < left - r.left;
  row._gcrEnd = { width: r.width, end };
  return end;
}

function renderLabels() {
  labelPending = false;
  if (!alive()) return shutdown();
  document.querySelectorAll(".gcr-label").forEach((el) => {
    if (!labels[el.parentElement && el.parentElement.getAttribute("data-id")]) el.remove();
  });
  document.querySelectorAll(".gcr-has-reminder").forEach((row) => {
    if (!labels[row.getAttribute("data-id")]) row.classList.remove("gcr-has-reminder", "gcr-reminder-due", "gcr-reminder-dark");
  });
  const dark = isDarkPage();
  for (const [id, l] of Object.entries(labels)) {
    for (const row of document.querySelectorAll(`${SELECTORS.messageRow}[data-id="${id}"]`)) {
      let el = row.firstElementChild;
      if (!el || !el.classList.contains("gcr-label")) row.prepend((el = makeLabel()));
      // Only touch the DOM when something changed: our own writes would otherwise re-trigger the observer forever.
      const span = el.querySelector("span");
      el._gcrIds = l.ids;
      if (span.textContent !== l.text) span.textContent = l.text;
      if (el.classList.contains("gcr-label-due") !== l.overdue) el.classList.toggle("gcr-label-due", l.overdue);
      const end = isRightAligned(row);
      if (el.classList.contains("gcr-label-end") !== end) el.classList.toggle("gcr-label-end", end);
      if (!row.classList.contains("gcr-has-reminder")) row.classList.add("gcr-has-reminder");
      if (row.classList.contains("gcr-reminder-due") !== l.overdue) row.classList.toggle("gcr-reminder-due", l.overdue);
      // The row is Chat's own element, so it gets its own theme class rather than .gcr-dark (which also sets
      // color-scheme).
      if (row.classList.contains("gcr-reminder-dark") !== dark) row.classList.toggle("gcr-reminder-dark", dark);
      if (el.classList.contains("gcr-dark") !== dark) themed(el);
    }
  }
}

function scheduleLabels() {
  if (labelPending) return;
  labelPending = true;
  setTimeout(renderLabels, 250);
}

function loadLabels() {
  if (!alive()) return shutdown();
  chrome.storage.local.get("reminders").then((o) => {
    labels = RTime.reminderLabels(o.reminders, Date.now());
    scheduleLabels();
  }).catch(() => {});
}

const loadPresetList = () => alive() && chrome.storage.local.get("presets").then((o) => { presetData = RTime.sanitizePresets(o.presets); presets = RTime.buildPresets(presetData); }).catch(() => {});
loadPresetList();
chrome.storage.onChanged.addListener((_c, area) => area === "local" && loadPresetList());

loadLabels();
chrome.storage.onChanged.addListener((_c, area) => area === "local" && loadLabels());
labelTick = setInterval(loadLabels, 60 * 1000);
labelObserver = new MutationObserver(() => Object.keys(labels).length && scheduleLabels());
labelObserver.observe(document.body, { childList: true, subtree: true });

// The background asks us to open a message link the way Chat's own links work: clicking a real <a> lets Chat's
// router handle it in-app (no page reload). If Chat doesn't intercept it, the browser follows it normally.
if (window.top === window) {
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg || msg.type !== "gcr-navigate" || !alive()) return false;
    try {
      const a = document.createElement("a");
      a.href = msg.url;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      reply({ ok: true });
    } catch (_) {
      reply({ ok: false });
    }
    return false;
  });
}

// Launcher: small button (top frame only) that opens the reminders overview, with a count of active reminders.
if (window.top === window) {
  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.className = "gcr-launcher";
  launcher.title = RTime.t("launcher_title");
  const icon = document.createElement("span");
  icon.className = "gcr-icon";
  icon.appendChild(RTime.icon("clock", 22));
  const badge = document.createElement("span");
  launcher.append(icon, badge);
  themed(launcher);
  launcherEl = launcher;
  launcher.addEventListener("click", () => (alive() ? togglePanel() : shutdown()));
  launcher.addEventListener("mouseenter", () => themed(launcher));
  document.body.appendChild(launcher);

  // In-page reminders panel (rounded, themed, anchored under the launcher). Rendered by the page, so unlike the
  // toolbar popup its corners can be styled.
  const call = (msg) => chrome.runtime.sendMessage(msg).then((r) => {
    if (!r || !r.ok) throw new Error((r && r.error) || "no response");
    return r.data;
  });
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  let panel = null;
  const closePanel = () => {
    if (!panel) return;
    const p = panel;
    panel = panelEl = null;
    p.classList.remove("gcr-open");
    setTimeout(() => p.remove(), 180);
    document.removeEventListener("pointerdown", onPanelOutside, true);
    document.removeEventListener("keydown", onPanelKey, true);
  };
  const onPanelOutside = (e) => { if (panel && !panel.contains(e.target) && !launcher.contains(e.target)) closePanel(); };
  const onPanelKey = (e) => { if (e.key === "Escape") closePanel(); };

  const renderPanel = async () => {
    if (!panel || !alive()) return;
    let items;
    try { items = (await call({ type: "list" })).filter((r) => !r.done).sort((a, b) => a.when - b.when); } catch (_) { return; }
    if (!panel) return;
    const now = Date.now();
    const dueCount = items.filter((r) => r.when <= now).length;
    panel.querySelector(".gcr-p-sub").textContent = !items.length ? "" : dueCount ? RTime.t("sub_due", { due: dueCount, total: items.length }) : RTime.t("sub_up", { n: items.length });
    const list = panel.querySelector(".gcr-p-list");
    list.replaceChildren();
    panel.querySelector(".gcr-p-empty").style.display = items.length ? "none" : "block";
    for (const r of items) {
      const row = el("li", "gcr-p-row");
      row.title = RTime.t("open_msg");
      row.addEventListener("click", () => { call({ type: "open", id: r.id }).catch(() => {}); closePanel(); });
      const check = el("input", "gcr-p-check");
      check.type = "checkbox";
      check.title = RTime.t("mark_done");
      check.setAttribute("aria-label", RTime.t("mark_done"));
      check.addEventListener("click", async (e) => { e.stopPropagation(); await call({ type: "complete", id: r.id }).catch(() => {}); renderPanel(); });
      const body = el("div", "gcr-p-body");
      if (r.sender) body.append(el("div", "gcr-p-from", r.sender));
      body.append(el("div", "gcr-p-text", r.text));
      const meta = el("div", "gcr-p-meta");
      if (r.when <= now) meta.append(el("span", "gcr-p-duepill", RTime.t("due")));
      meta.append(el("span", null, RTime.formatDue(r.when, now)));
      body.append(meta);
      const actions = el("div", "gcr-p-actions");
      const snooze = el("button", "gcr-p-snooze", RTime.t("snooze_10"));
      snooze.type = "button";
      snooze.addEventListener("click", async (e) => { e.stopPropagation(); await call({ type: "snooze", id: r.id, ms: 10 * 60e3 }).catch(() => {}); renderPanel(); });
      const del = el("button", "gcr-p-del");
      del.type = "button";
      del.title = RTime.t("del");
      del.setAttribute("aria-label", RTime.t("del"));
      del.appendChild(RTime.icon("close", 16));
      del.addEventListener("click", async (e) => { e.stopPropagation(); await call({ type: "delete", id: r.id }).catch(() => {}); renderPanel(); });
      actions.append(snooze, del);
      row.append(check, body, actions);
      list.appendChild(row);
    }
  };

  const openPanel = () => {
    panel = panelEl = themed(el("div", "gcr-panel"));
    chatTheme(panel);
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", RTime.t("reminders"));
    const head = el("div", "gcr-p-head");
    const titles = el("div");
    titles.append(el("div", "gcr-p-title", RTime.t("reminders")), el("div", "gcr-p-sub"));
    const all = el("button", "gcr-p-all", RTime.t("view_all"));
    all.type = "button";
    all.addEventListener("click", () => { call({ type: "overview" }).catch(() => {}); closePanel(); });
    head.append(titles, all);
    const empty = el("div", "gcr-p-empty");
    empty.append(el("b", null, RTime.t("caught_up")), el("span", null, RTime.t("empty_hint")));
    const note = el("div", "gcr-p-update");
    note.hidden = true;
    call({ type: "updateInfo" }).then((u) => {
      if (!u || !panel) return;
      note.textContent = RTime.t("banner", { version: u.version });
      note.hidden = false;
      note.style.cursor = "pointer";
      note.addEventListener("click", () => { call({ type: "openUpdate" }).catch(() => {}); closePanel(); });
    }).catch(() => {});
    panel.append(head, note, el("ul", "gcr-p-list"), empty);
    const r = launcher.getBoundingClientRect();
    const w = Math.min(420, innerWidth - 24);
    panel.style.width = `${w}px`;
    panel.style.left = `${Math.max(12, Math.min(r.left, innerWidth - w - 12))}px`;
    panel.style.top = `${Math.round(r.bottom + 8)}px`;
    panel.style.maxHeight = `${Math.max(200, innerHeight - r.bottom - 24)}px`;
    panel.style.transformOrigin = `${Math.round(r.left + r.width / 2 - parseFloat(panel.style.left))}px top`;
    document.body.appendChild(panel);
    requestAnimationFrame(() => panel && panel.classList.add("gcr-open"));
    document.addEventListener("pointerdown", onPanelOutside, true);
    document.addEventListener("keydown", onPanelKey, true);
    renderPanel();
  };
  const togglePanel = () => (panel ? closePanel() : openPanel());
  chrome.storage.onChanged.addListener((_c, area) => area === "local" && renderPanel());

  // Red + count when something is due; faded otherwise (future reminders don't count).
  const refresh = () => {
    if (!alive()) return shutdown();
    return chrome.storage.local.get("reminders").then((o) => {
      const now = Date.now();
      const due = Object.values(o.reminders || {}).filter((r) => !r.done && r.when <= now).length;
      badge.textContent = due ? String(due) : "";
      launcher.classList.toggle("gcr-due", due > 0);
      launcher.title = due ? RTime.t(due > 1 ? "launcher_due_other" : "launcher_due_one", { n: due }) : RTime.t("launcher_title");
    }).catch(() => {});
  };
  chrome.storage.onChanged.addListener((_c, area) => area === "local" && refresh());

  // Sit right of the "Chat" wordmark in the top-left header. Found by its text, since Chat's markup is obfuscated.
  // Any implausible result falls back to the fixed spot in the CSS, so the button can never end up off-screen.
  const WORDMARK = /^(Chat|聊天|即時通訊)$/;
  const findWordmark = () => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!WORDMARK.test(n.nodeValue.trim())) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (r.width > 0 && r.top >= 0 && r.top < 70 && r.right > 40 && r.right < 360) return r;
    }
    return null;
  };
  // Second method, independent of Chat's markup: walk along the header's vertical centre from the left edge and
  // follow the run of small elements (menu icon, logo, wordmark) until the first real gap; the run's right edge
  // is where the launcher goes.
  const scanHeaderRight = () => {
    const y = 28;
    let right = 0, lastHit = -1e9;
    for (let x = 8; x < 320; x += 4) {
      if (x - lastHit > 28) break;
      for (const el of document.elementsFromPoint(x, y)) {
        if (el === launcher || el === document.body || el === document.documentElement) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 220 || r.height > 64 || r.width < 4) continue;
        right = Math.max(right, r.right);
        lastHit = x;
      }
    }
    return right;
  };
  // Preferred spot: a pill right of the "New chat" button, matching its height. Found by its text; the nearest
  // ancestor with a plausible button size is taken as the button.
  const NEW_CHAT = /^(New chat|發起新聊天|新聊天|新对话|新對話)$/;
  const findNewChat = () => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!NEW_CHAT.test(n.nodeValue.trim())) continue;
      for (let el = n.parentElement, i = 0; el && i < 6; el = el.parentElement, i++) {
        const r = el.getBoundingClientRect();
        if (r.height >= 36 && r.height <= 72 && r.width >= 90 && r.width <= 280 && r.left < 400 && r.top < 200) return el;
      }
    }
    return null;
  };
  // Chat popups (e.g. the New chat panel) must cover the button. Stacking order alone wasn't enough, so hide the
  // button while something popup-like is the topmost element at its centre. pointer-events:none makes the
  // launcher invisible to elementsFromPoint, so we see what is really underneath.
  const POPUP = "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox'], [aria-modal='true']";
  const coveredByPopup = () => {
    const r = launcher.getBoundingClientRect();
    if (!r.width) return false;
    launcher.style.pointerEvents = "none";
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    launcher.style.pointerEvents = "";
    for (let el = top, i = 0; el && el !== document.body && i < 14; el = el.parentElement, i++) {
      if (el.matches(POPUP)) return true;
      const cs = getComputedStyle(el);
      if ((cs.position === "fixed" || cs.position === "absolute") && parseInt(cs.zIndex, 10) >= 1000) return true;
    }
    return false;
  };
  const syncCover = () => {
    if (!alive()) return shutdown();
    launcher.style.visibility = coveredByPopup() ? "hidden" : "";
  };
  const place = () => {
    if (!alive()) return shutdown();
    themed(launcher);
    refresh();
    const ncEl = findNewChat();
    if (ncEl) {
      const nc = ncEl.getBoundingClientRect();
      // Copy the look of Chat's own button (user theme colour, corner radius, shadow) from the nearest styled element.
      let look = null;
      for (let el = ncEl, i = 0; el && i < 4 && !look; el = el.parentElement, i++) {
        const cs = getComputedStyle(el);
        if (!/^rgba\(.*,\s*0\)$|^transparent$/.test(cs.backgroundColor)) look = cs;
      }
      launcher.classList.add("gcr-pill");
      launcher.style.setProperty("--gcr-pill-bg", look ? look.backgroundColor : "");
      launcher.style.setProperty("--gcr-pill-fg", look ? look.color : "");
      launcher.style.setProperty("--gcr-pill-shadow", look ? look.boxShadow : "none");
      launcher.style.setProperty("--gcr-pill-radius", look ? look.borderRadius : `${Math.round(nc.height / 3)}px`);
      launcher.style.left = `${Math.round(nc.right + 10)}px`;
      launcher.style.top = `${Math.round(nc.top)}px`;
      launcher.style.height = `${Math.round(nc.height)}px`;
      launcher.style.minWidth = `${Math.round(nc.height)}px`;
      return;
    }
    // New chat not visible (e.g. collapsed sidebar): sit right of the header wordmark instead.
    launcher.classList.remove("gcr-pill");
    launcher.style.height = launcher.style.minWidth = "";
    const word = findWordmark();
    const right = Math.max(word ? word.right : 0, scanHeaderRight());
    if (right < 60 || right > 340) return; // implausible: keep the fixed fallback position from the CSS
    launcher.style.left = `${Math.round(right + 14)}px`;
    launcher.style.top = "10px";
  };
  place();
  syncCover();
  addEventListener("resize", place);
  document.addEventListener("click", () => setTimeout(syncCover, 120), true);
  document.addEventListener("keyup", () => setTimeout(syncCover, 120), true);
  setInterval(syncCover, 500);
  placeTimer = setInterval(place, 3000); // header renders late; also keeps the due state current as time passes
}
