// Shared time helpers (content script, popup, service worker, node tests).
(function (root) {
  const MIN = 60 * 1000;

  // Quick options shown in the reminder menu and the snooze menu. Users edit them in the reminder menu itself; they are
  // stored as data: { kind: "in", minutes } or { kind: "tomorrow", time: "HH:MM" }.
  const DEFAULT_PRESETS = [
    { kind: "in", minutes: 20 },
    { kind: "in", minutes: 60 },
    { kind: "in", minutes: 120 },
    { kind: "in", minutes: 180 },
    { kind: "tomorrow", time: "10:00" },
  ];
  const MAX_PRESETS = 8;
  const MAX_MINUTES = 30 * 24 * 60;

  // Validate and normalise stored options: drop junk, clamp, cap the count, "from now" ascending then "tomorrow" ascending.
  // Anything that isn't a list falls back to the defaults; an empty list is allowed (only "Custom time" is shown).
  function sanitizePresets(list) {
    if (!Array.isArray(list)) return DEFAULT_PRESETS.map((p) => ({ ...p }));
    const ins = [], tmr = [];
    for (const o of list) {
      if (o && o.kind === "tomorrow" && /^([01]\d|2[0-3]):[0-5]\d$/.test(o.time)) tmr.push({ kind: "tomorrow", time: o.time });
      else if (o && o.kind === "in" && Number.isFinite(+o.minutes)) ins.push({ kind: "in", minutes: Math.min(MAX_MINUTES, Math.max(1, Math.round(+o.minutes))) });
    }
    ins.sort((x, y) => x.minutes - y.minutes);
    tmr.sort((x, y) => (x.time < y.time ? -1 : 1));
    return [...ins, ...tmr].slice(0, MAX_PRESETS);
  }

  function durationLabel(min) {
    if (min % 1440 === 0) return t(min / 1440 === 1 ? "in_day_one" : "in_day_other", { n: min / 1440 });
    if (min % 60 === 0) return t(min / 60 === 1 ? "in_hr_one" : "in_hr_other", { n: min / 60 });
    return t(min === 1 ? "in_min_one" : "in_min_other", { n: min });
  }

  // [{ label, at(now) -> epoch ms }]; labels follow the current language.
  function buildPresets(list) {
    return sanitizePresets(list).map((o) => {
      if (o.kind === "tomorrow") {
        const [h, m] = o.time.split(":").map(Number);
        return { label: t("tomorrow_at", { time: o.time }), at: (now) => tomorrowAt(now, h, m) };
      }
      return { label: durationLabel(o.minutes), at: (now) => now + o.minutes * MIN };
    });
  }

  const loadPresets = () => chrome.storage.local.get("presets").then((o) => buildPresets(o.presets));

  function tomorrowAt(now, hour, minute = 0) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
  }

  // <input type="datetime-local"> value ("YYYY-MM-DDTHH:mm", local) -> epoch ms, or NaN.
  function parseLocalInput(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || "");
    if (!m) return NaN;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  }

  function toLocalInput(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // Fixed format regardless of browser locale: "2026/10/28 18:15".
  const pad = (n) => String(n).padStart(2, "0");
  function formatTime(ms) {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function formatWhen(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${formatTime(ms)}`;
  }

  // Chat message id from a reminder's saved link (/room/<space>/<topic>/<message>), or "" for a space/DM link.
  function messageIdOf(url) {
    const m = /\/room\/[^/]+\/[^/]+\/([A-Za-z0-9_-]{8,16})(?:[?#]|$)/.exec(url || "");
    return m ? m[1] : "";
  }

  // Labels for messages with an active reminder: { messageId: { text, overdue } }, nearest reminder per message.
  function reminderLabels(reminders, now, fmt = formatWhen) {
    const nearest = {};
    const ids = {};
    for (const [key, r] of Object.entries(reminders || {})) {
      const id = !r.done && messageIdOf(r.url);
      if (!id) continue;
      (ids[id] = ids[id] || []).push(r.id || key);
      if (!nearest[id] || r.when < nearest[id].when) nearest[id] = r;
    }
    const out = {};
    for (const [id, r] of Object.entries(nearest)) {
      const overdue = r.when <= now;
      out[id] = { text: t(overdue ? "label_due" : "label_set", { when: fmt(r.when) }), overdue, ids: ids[id] };
    }
    return out;
  }

  const QUARTER = 15 * MIN;
  const ceilQuarter = (ms) => Math.ceil(ms / QUARTER) * QUARTER;

  // Picker: a date field plus a dropdown of 15-minute slots.
  // Returns { el, get() -> epoch ms | NaN, set(ms) }.
  function createPicker(initialMs) {
    const el = document.createElement("div");
    el.className = "rt-picker";
    const date = document.createElement("input");
    date.type = "date";
    const time = document.createElement("select");
    for (let m = 0; m < 24 * 60; m += 15) {
      const o = document.createElement("option");
      o.value = String(m);
      o.textContent = formatTime(new Date(2000, 0, 1, 0, m).getTime());
      time.appendChild(o);
    }
    el.append(date, time);
    const set = (ms) => {
      const d = new Date(ceilQuarter(ms));
      date.value = toLocalInput(d.getTime()).slice(0, 10);
      time.value = String(d.getHours() * 60 + d.getMinutes());
    };
    const get = () => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.value);
      if (!m) return NaN;
      return new Date(+m[1], +m[2] - 1, +m[3], 0, +time.value).getTime();
    };
    set(initialMs);
    return { el, get, set };
  }

  // Inline SVG icons (Material-style paths, filled with currentColor) so no emoji is needed anywhere.
  const ICONS = {
    clock: "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z",
    check: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
    close: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
    caret: "M7 10l5 5 5-5z",
  };
  function icon(name, size) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size || 18));
    svg.setAttribute("height", String(size || 18));
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "display:block;flex:none;pointer-events:none";
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", ICONS[name]);
    svg.appendChild(p);
    return svg;
  }

  // > 0 when version a is newer than b ("1.10.0" > "1.9.2"); non-numeric parts count as 0.
  function compareVersions(a, b) {
    const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  // Wording for the update flow: Traditional Chinese when the browser/system language is, otherwise English.
  const STRINGS = {
    en: {
      reminders: "Reminders",
      view_all: "View all",
      caught_up: "All caught up",
      empty_hint: "Hover a message in Google Chat and click the clock to add a reminder.",
      mark_done: "Mark as done",
      del: "Delete",
      snooze_10: "Snooze 10m",
      snooze_10_title: "Snooze 10 minutes",
      open_msg: "Open this message in Chat",
      due: "Due",
      sub_due: "{due} due · {total} total",
      sub_up: "{n} upcoming",
      remind_me: "Remind me about this",
      remind_title: "Remind me about this message",
      custom_time: "Custom time",
      set_reminder: "Set reminder",
      toast_set: "Reminder set for {when}",
      toast_fail: "Couldn't set reminder (reload the page if the extension was updated)",
      toast_removed: "Reminder removed",
      toast_remove_fail: "Couldn't remove the reminder",
      remove: "Remove",
      remove_title: "Remove this reminder",
      view_reminders: "View reminders",
      label_set: "Reminder set for {when}",
      label_due: "Reminder due {when}",
      launcher_title: "Show my reminders",
      launcher_due_one: "{n} reminder due",
      launcher_due_other: "{n} reminders due",
      msg_fallback: "Message in Google Chat",
      msg_image: "Image",
      notif_reminder: "Reminder",
      btn_snooze20: "Snooze 20 min",
      ov_title: "Reminders",
      ov_empty: "No reminders yet. Hover a message in Google Chat and click the clock button, or use the toolbar popup.",
      sec_overdue: "Overdue",
      sec_today: "Today",
      sec_tomorrow: "Tomorrow",
      sec_later: "Later",
      sec_completed: "Completed",
      completed_at: "Completed {when}",
      from_message: "from message",
      reactivate: "Reactivate",
      snooze: "Snooze",
      set_custom: "Set custom time",
      in_min_one: "In {n} minute",
      in_min_other: "In {n} minutes",
      in_hr_one: "In {n} hour",
      in_hr_other: "In {n} hours",
      in_day_one: "In {n} day",
      in_day_other: "In {n} days",
      tomorrow_at: "Tomorrow {time}",
      edit: "Edit",
      done: "Done",
      opt_from_now: "From now",
      opt_tomorrow: "Tomorrow at",
      unit_min: "minutes",
      unit_hr: "hours",
      unit_day: "days",
      opt_add_in: "Add a time from now",
      opt_add_tmr: "Add a time tomorrow",
      opt_reset: "Reset to defaults",
      opt_max: "You can have up to {n} options.",
      page_title: "Update Chat Reminders",
      versions_new: "You have v{current}. v{latest} is available.",
      versions_none: "You have v{current}. No newer version found yet.",
      step1_title: "Allow updating",
      step1_desc: "Pick the folder this extension was loaded from. You only need to do this once.",
      btn_pick: "Choose folder",
      step2_title: "Update",
      step2_desc: "Downloads the latest version into that folder and reloads the extension.",
      btn_go: "Update now",
      manual_pre: "Prefer to do it by hand?",
      manual_link: "Download the zip",
      manual_post: "and unzip it over your folder.",
      wrong_folder: "That doesn't look like the Chat Reminders folder (no matching manifest.json). Pick the folder you loaded at chrome://extensions.",
      saved: "Folder saved.",
      folder_fail: "Couldn't use that folder: {msg}",
      perm_denied: "Folder access was not granted.",
      folder_changed: "The saved folder no longer looks like this extension's folder. Choose it again.",
      downloading: "Downloading…",
      dl_fail: "Download failed ({status}).",
      bad_zip: "The download doesn't look like a Chat Reminders release.",
      installing: "Installing…",
      done: "Updated. Reloading… refresh Google Chat afterwards.",
      banner: "Update available: v{version}. Click to update.",
      notif_title: "Chat Reminders update available",
      notif_msg: "Version {latest} is out (you have {current}). Click to update in one step.",
    },
    "zh-TW": {
      reminders: "提醒",
      view_all: "查看全部",
      caught_up: "全部完成了",
      empty_hint: "將滑鼠移到 Google Chat 的訊息上，點選時鐘按鈕即可新增提醒。",
      mark_done: "標示為完成",
      del: "刪除",
      snooze_10: "延後 10 分鐘",
      snooze_10_title: "延後 10 分鐘",
      open_msg: "在 Chat 中開啟這則訊息",
      due: "已到期",
      sub_due: "{due} 則已到期 · 共 {total} 則",
      sub_up: "{n} 則即將到來",
      remind_me: "提醒我這則訊息",
      remind_title: "提醒我這則訊息",
      custom_time: "自訂時間",
      set_reminder: "設定提醒",
      toast_set: "已設定提醒：{when}",
      toast_fail: "無法設定提醒（如果擴充功能剛更新過，請重新整理頁面）",
      toast_removed: "已移除提醒",
      toast_remove_fail: "無法移除提醒",
      remove: "移除",
      remove_title: "移除這個提醒",
      view_reminders: "查看提醒",
      label_set: "已設定提醒：{when}",
      label_due: "提醒已到期：{when}",
      launcher_title: "顯示我的提醒",
      launcher_due_one: "{n} 則提醒已到期",
      launcher_due_other: "{n} 則提醒已到期",
      msg_fallback: "Google Chat 訊息",
      msg_image: "圖片",
      notif_reminder: "提醒",
      btn_snooze20: "延後 20 分鐘",
      ov_title: "提醒",
      ov_empty: "還沒有提醒。將滑鼠移到 Google Chat 的訊息上並點選時鐘按鈕，或使用工具列的彈出視窗。",
      sec_overdue: "已逾期",
      sec_today: "今天",
      sec_tomorrow: "明天",
      sec_later: "之後",
      sec_completed: "已完成",
      completed_at: "完成於 {when}",
      from_message: "來自訊息",
      reactivate: "重新啟用",
      snooze: "延後",
      set_custom: "設定自訂時間",
      in_min_one: "{n} 分鐘後",
      in_min_other: "{n} 分鐘後",
      in_hr_one: "{n} 小時後",
      in_hr_other: "{n} 小時後",
      in_day_one: "{n} 天後",
      in_day_other: "{n} 天後",
      tomorrow_at: "明天 {time}",
      edit: "編輯",
      done: "完成",
      opt_from_now: "從現在起",
      opt_tomorrow: "明天",
      unit_min: "分鐘",
      unit_hr: "小時",
      unit_day: "天",
      opt_add_in: "新增「多久之後」",
      opt_add_tmr: "新增「明天的時間」",
      opt_reset: "還原預設值",
      opt_max: "最多只能有 {n} 個選項。",
      page_title: "更新 Chat Reminders",
      versions_new: "你目前是 v{current}，最新版本為 v{latest}。",
      versions_none: "你目前是 v{current}，尚未發現新版本。",
      step1_title: "允許更新",
      step1_desc: "選擇載入此擴充功能的資料夾。只需要做一次。",
      btn_pick: "選擇資料夾",
      step2_title: "更新",
      step2_desc: "把最新版本下載到該資料夾，並重新載入擴充功能。",
      btn_go: "立即更新",
      manual_pre: "想手動更新？",
      manual_link: "下載 zip",
      manual_post: "並解壓縮覆蓋原資料夾。",
      wrong_folder: "這看起來不是 Chat Reminders 資料夾（找不到相符的 manifest.json）。請選擇你在 chrome://extensions 載入的資料夾。",
      saved: "已儲存資料夾。",
      folder_fail: "無法使用該資料夾：{msg}",
      perm_denied: "未取得資料夾存取權。",
      folder_changed: "已儲存的資料夾看起來不再是此擴充功能的資料夾，請重新選擇。",
      downloading: "下載中…",
      dl_fail: "下載失敗（{status}）。",
      bad_zip: "下載的檔案看起來不是 Chat Reminders 的發行檔。",
      installing: "安裝中…",
      done: "更新完成，即將重新載入… 之後請重新整理 Google Chat。",
      banner: "有新版本 v{version}，點此更新。",
      notif_title: "Chat Reminders 有新版本",
      notif_msg: "新版本 {latest} 已發布（目前 {current}）。點選即可一鍵更新。",
    },
  };
  let forced = null; // tests
  const setLang = (l) => { forced = l; };
  function lang() {
    if (forced) return forced;
    let l = "en";
    try { l = chrome.i18n.getUILanguage(); } catch (_) { l = (typeof navigator !== "undefined" && navigator.language) || "en"; }
    return /^zh[-_](tw|hk|mo|hant)/i.test(l) ? "zh-TW" : "en";
  }
  function t(key, vars) {
    const s = STRINGS[lang()][key] || STRINGS.en[key] || key;
    return s.replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? vars[k] : ""));
  }

  root.RTime = { t, lang, setLang, compareVersions, icon, DEFAULT_PRESETS, MAX_PRESETS, sanitizePresets, buildPresets, loadPresets, tomorrowAt, parseLocalInput, toLocalInput, formatWhen, formatTime, messageIdOf, reminderLabels, ceilQuarter, createPicker };
  if (typeof module !== "undefined") module.exports = root.RTime;
})(typeof globalThis !== "undefined" ? globalThis : this);
