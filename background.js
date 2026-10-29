importScripts("time.js");

const KEY = "reminders";
const SNOOZE_MS = 20 * 60 * 1000;
const FALLBACK_URL = "https://chat.google.com/";

async function load() {
  const o = await chrome.storage.local.get(KEY);
  return o[KEY] || {};
}
const save = (r) => chrome.storage.local.set({ [KEY]: r });

function schedule(r) {
  // Past-due times fire almost immediately.
  chrome.alarms.create(r.id, { when: Math.max(r.when, Date.now() + 1000) });
}

// A message has at most one active reminder: setting another one moves the existing reminder to the new time
// (and drops any extra copies left from before this rule).
async function add({ text, sender, when, url, source }) {
  const all = await load();
  const [keep, ...extra] = RTime.activeForMessage(all, url);
  const r = {
    id: keep || `r_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    text: String(text || "Reminder").slice(0, 500),
    sender: String(sender || "").slice(0, 100),
    when,
    url: url || FALLBACK_URL,
    source: source || "manual",
  };
  all[r.id] = r;
  extra.forEach((id) => delete all[id]);
  await save(all);
  schedule(r);
  await Promise.all([r.id, ...extra].map((id) => chrome.notifications.clear(id)));
  await Promise.all(extra.map((id) => chrome.alarms.clear(id)));
  return r;
}

async function remove(id) {
  const all = await load();
  delete all[id];
  await save(all);
  await chrome.alarms.clear(id);
  await chrome.notifications.clear(id);
}

// Move a reminder to a new time (also reactivates a completed one). Pass `when` (epoch ms) or `ms` (from now).
async function snooze(id, { when, ms } = {}) {
  const all = await load();
  if (!all[id]) return;
  all[id].when = Number.isFinite(when) ? when : Date.now() + (ms || SNOOZE_MS);
  delete all[id].done;
  await save(all);
  schedule(all[id]);
  await chrome.notifications.clear(id);
}

// Mark done: kept in the overview under "Completed" until deleted.
async function complete(id) {
  const all = await load();
  if (!all[id]) return;
  all[id].done = Date.now();
  await save(all);
  await chrome.alarms.clear(id);
  await chrome.notifications.clear(id);
}

async function list() {
  return Object.values(await load()).sort((a, b) => a.when - b.when);
}

async function resync() {
  const all = await load();
  const alarms = new Set((await chrome.alarms.getAll()).map((a) => a.name));
  Object.values(all).forEach((r) => r.done || alarms.has(r.id) || schedule(r));
}

chrome.runtime.onInstalled.addListener(resync);
chrome.runtime.onStartup.addListener(resync);

chrome.alarms.onAlarm.addListener(async ({ name }) => {
  if (name === UPDATE_ALARM) return checkUpdate();
  const r = (await load())[name];
  if (!r || r.done) return;
  chrome.notifications.create(r.id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: RTime.t("notif_reminder"),
    message: r.text,
    contextMessage: "Google Chat",
    requireInteraction: true,
    buttons: [{ title: RTime.t("btn_snooze20") }, { title: RTime.t("mark_done") }],
  });
});

// Update check for unpacked (git clone) installs, which Chrome never updates by itself: once a day, compare our
// manifest version with the one on the repo's main branch and offer a one-click update (update.html).
const REPO_URL = "https://github.com/marandy0905/chat-reminders";
const REMOTE_MANIFEST = "https://raw.githubusercontent.com/marandy0905/chat-reminders/main/manifest.json";
const UPDATE_ALARM = "gcr-update-check";
const UPDATE_NOTE = "gcr-update";

async function checkUpdate() {
  try {
    const res = await fetch(REMOTE_MANIFEST, { cache: "no-store" });
    if (!res.ok) return;
    const latest = String((await res.json()).version || "");
    const current = chrome.runtime.getManifest().version;
    const { update } = await chrome.storage.local.get("update");
    if (!latest || RTime.compareVersions(latest, current) <= 0) {
      if (update) await chrome.storage.local.remove("update");
      return chrome.action.setBadgeText({ text: "" });
    }
    await chrome.storage.local.set({ update: { version: latest, notified: update && update.version === latest && update.notified } });
    chrome.action.setBadgeText({ text: "NEW" });
    chrome.action.setBadgeBackgroundColor({ color: "#0a66e6" });
    if (!(update && update.version === latest && update.notified)) {
      await chrome.storage.local.set({ update: { version: latest, notified: true } });
      chrome.notifications.create(UPDATE_NOTE, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: RTime.t("notif_title"),
        message: RTime.t("notif_msg", { latest, current }),
      });
    }
  } catch (_) { /* offline or rate-limited: try again at the next check */ }
}
// After an update the stored "update available" flag is stale until the next network check; drop it right away.
async function clearStaleUpdate() {
  const { update } = await chrome.storage.local.get("update");
  if (update && RTime.compareVersions(update.version, chrome.runtime.getManifest().version) <= 0) {
    await chrome.storage.local.remove("update");
    chrome.action.setBadgeText({ text: "" });
  }
}
clearStaleUpdate();
const scheduleUpdateCheck = () => {
  chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 12 * 60 });
};
chrome.runtime.onInstalled.addListener(scheduleUpdateCheck);
chrome.runtime.onStartup.addListener(scheduleUpdateCheck);

async function open(r) {
  // Only match Chat itself (never the Gmail app, which lives at mail.google.com/mail/ and can also be a PWA).
  const tabs = await chrome.tabs.query({ url: ["https://chat.google.com/*", "https://mail.google.com/chat/*"] });
  const wins = await Promise.all(tabs.map((t) => chrome.windows.get(t.windowId)));
  // Prefer an installed-PWA ("app") window on chat.google.com, then any chat.google.com tab.
  const rank = (i) => (new URL(tabs[i].url).hostname === "chat.google.com" ? 0 : 2) + (wins[i].type === "app" ? 0 : 1);
  const order = tabs.map((_, i) => i).sort((a, b) => rank(a) - rank(b));
  const i = order[0];
  if (i === undefined) return chrome.tabs.create({ url: r.url });

  const tab = tabs[i];
  const sameOrigin = new URL(r.url).origin === new URL(tab.url).origin;
  await chrome.windows.update(tab.windowId, { focused: true, state: wins[i].state === "minimized" ? "normal" : undefined });
  await chrome.tabs.update(tab.id, { active: true });
  if (!sameOrigin || r.url === FALLBACK_URL) return;
  // Ask the page to follow the link itself, like clicking a message link inside Chat: Chat's router then jumps to
  // the message without reloading. If the page can't (old content script, no response), navigate the tab instead.
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "gcr-navigate", url: r.url }, { frameId: 0 });
    if (!res || !res.ok) throw new Error("not handled");
  } catch (_) {
    await chrome.tabs.update(tab.id, { url: r.url });
  }
}

// Nothing here marks a reminder done except the explicit "Mark as done" button:
// clicking the notification only opens the chat, and dismissing it leaves the reminder Overdue.
chrome.notifications.onButtonClicked.addListener(async (id, idx) => {
  if (idx === 0) return snooze(id);
  return complete(id);
});

chrome.notifications.onClicked.addListener(async (id) => {
  if (id === UPDATE_NOTE) {
    await openUpdate();
    return chrome.notifications.clear(id);
  }
  const r = (await load())[id];
  if (r) await open(r);
  await chrome.notifications.clear(id);
});

// Opened as a small focused window instead of a background tab: it comes to the front on top of Chat (including
// when Chat runs as an installed app window) and the user can't miss it. It has to be an extension page, not
// something injected into Chat, because the folder picker isn't allowed in cross-origin frames.
async function openUpdate() {
  const url = chrome.runtime.getURL("update.html");
  const [tab] = await chrome.tabs.query({ url });
  if (tab) {
    await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
    return chrome.tabs.update(tab.id, { active: true });
  }
  const width = 600, height = 620;
  let left, top;
  try {
    const w = await chrome.windows.getLastFocused();
    left = Math.max(0, Math.round((w.left || 0) + ((w.width || width) - width) / 2));
    top = Math.max(0, Math.round((w.top || 0) + ((w.height || height) - height) / 3));
  } catch (_) { /* let Chrome place it */ }
  return chrome.windows.create({ url, type: "popup", width, height, left, top, focused: true });
}

async function openOverview() {
  const url = chrome.runtime.getURL("reminders.html");
  const [tab] = await chrome.tabs.query({ url });
  if (!tab) return chrome.tabs.create({ url });
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
}

// Open the toolbar popup (Chrome 127+); fall back to the overview page if that isn't possible.
const openPopup = () => chrome.action.openPopup().catch(() => openOverview());

chrome.commands.onCommand.addListener((c) => c === "open-overview" && openPopup());

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const run = {
    add: () => add(msg),
    list: () => list(),
    delete: () => remove(msg.id),
    snooze: () => snooze(msg.id, msg),
    complete: () => complete(msg.id),
    popup: () => openPopup(),
    overview: () => openOverview(),
    openUpdate: () => openUpdate(),
    updateInfo: async () => {
      const { update } = await chrome.storage.local.get("update");
      return update && RTime.compareVersions(update.version, chrome.runtime.getManifest().version) > 0 ? update : null;
    },
    open: async () => { const r = (await load())[msg.id]; if (r) await open(r); },
  }[msg.type];
  if (!run) return false;
  run().then((data) => reply({ ok: true, data }), (e) => reply({ ok: false, error: String(e) }));
  return true; // async reply
});
