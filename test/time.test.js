const assert = require("assert");
const T = require("../time.js");
T.setLang("en");

const now = new Date(2026, 9, 27, 15, 30).getTime();
assert.strictEqual(T.tomorrowAt(now, 10), new Date(2026, 9, 28, 10, 0).getTime());
assert.strictEqual(T.tomorrowAt(new Date(2026, 9, 31, 23, 0).getTime(), 10), new Date(2026, 10, 1, 10, 0).getTime());
const defaults = T.buildPresets();
assert.strictEqual(defaults[0].at(now), now + 20 * 60e3);
assert.deepStrictEqual(defaults.map((p) => p.label), ["In 20 minutes", "In 1 hour", "In 2 hours", "In 3 hours", "Tomorrow 10:00"]);
assert.strictEqual(defaults[2].at(now), now + 120 * 60e3);
assert.strictEqual(defaults[4].at(now), T.tomorrowAt(now, 10));
// Custom options: labels, tomorrow with minutes, sorting, clamping, junk dropped, cap.
const custom = T.buildPresets([{ kind: "tomorrow", time: "08:30" }, { kind: "in", minutes: 1440 }, { kind: "in", minutes: 5 }, { kind: "in", minutes: 90 }, { kind: "in", minutes: "x" }, { kind: "tomorrow", time: "25:00" }, null]);
assert.deepStrictEqual(custom.map((p) => p.label), ["In 5 minutes", "In 90 minutes", "In 1 day", "Tomorrow 08:30"]);
assert.strictEqual(custom[3].at(now), T.tomorrowAt(now, 8, 30));
assert.strictEqual(T.tomorrowAt(now, 8, 30), new Date(2026, 9, 28, 8, 30).getTime());
assert.deepStrictEqual(T.sanitizePresets([{ kind: "in", minutes: 0 }, { kind: "in", minutes: 9e9 }]), [{ kind: "in", minutes: 1 }, { kind: "in", minutes: 43200 }]);
assert.deepStrictEqual(T.sanitizePresets([]), []);
assert.deepStrictEqual(T.sanitizePresets(undefined), T.DEFAULT_PRESETS);
assert.strictEqual(T.sanitizePresets(Array.from({ length: 20 }, (_, i) => ({ kind: "in", minutes: i + 1 }))).length, T.MAX_PRESETS);
assert.strictEqual(T.parseLocalInput("2026-10-27T15:30"), now);
assert.ok(Number.isNaN(T.parseLocalInput("")));
assert.strictEqual(T.parseLocalInput(T.toLocalInput(now)), now);

// Fixed, locale-independent date format: "YYYY/MM/DD HH:mm" (24-hour).
assert.strictEqual(T.formatWhen(new Date(2026, 9, 28, 18, 15).getTime()), "2026/10/28 18:15");
assert.strictEqual(T.formatWhen(new Date(2026, 0, 5, 9, 5).getTime()), "2026/01/05 09:05");
assert.strictEqual(T.formatTime(new Date(2000, 0, 1, 0, 18 * 60 + 15).getTime()), "18:15");

// Message id from a reminder's saved link (content.js permalink(): /room/<space>/<topic>/<message>?cls=10).
assert.strictEqual(T.messageIdOf("https://chat.google.com/room/sJEKDqAAAAE/ZWfffvkSQ38/ZWfffvkSQ38?cls=10"), "ZWfffvkSQ38");
assert.strictEqual(T.messageIdOf("https://chat.google.com/room/AAAAxyz123/topicId1234/msgId56789"), "msgId56789");
assert.strictEqual(T.messageIdOf("https://chat.google.com/app/chat/sJEKDqAAAAE"), "");
assert.strictEqual(T.messageIdOf(undefined), "");

// Labels shown on messages: one per message, nearest active reminder, done ones ignored.
const link = (msg) => `https://chat.google.com/room/sJEKDqAAAAE/topic123456/${msg}?cls=10`;
const fmt = (ms) => `@${ms}`;
const labels = T.reminderLabels(
  {
    a: { when: now + 60e3, url: link("msgAAAAAAAA") },
    b: { when: now + 30e3, url: link("msgAAAAAAAA") },
    c: { when: now - 60e3, url: link("msgBBBBBBBB") },
    d: { when: now + 60e3, url: link("msgCCCCCCCC"), done: now },
    e: { when: now + 60e3, url: "https://chat.google.com/app/chat/sJEKDqAAAAE" },
    f: { when: now + 4 * 3600e3, url: link("msgDDDDDDDD") },
  },
  now,
  fmt
);
assert.deepStrictEqual(labels, {
  msgAAAAAAAA: { text: "Due in 1 minute", overdue: false, ids: ["a", "b"] },
  msgBBBBBBBB: { text: `Reminder due @${now - 60e3}`, overdue: true, ids: ["c"] },
  msgDDDDDDDD: { text: `Reminder set for @${now + 4 * 3600e3}`, overdue: false, ids: ["f"] },
});
assert.deepStrictEqual(T.reminderLabels({}, now, fmt), {});
assert.ok(T.compareVersions("1.10.0", "1.9.2") > 0);
assert.ok(T.compareVersions("1.0.0", "1.0.1") < 0);
assert.strictEqual(T.compareVersions("1.0", "1.0.0"), 0);
// List times: relative within 3 hours ("Due in N minutes" under an hour, "Due in N hours" up to 3), absolute otherwise.
{
  const n0 = new Date(2026, 9, 29, 12, 0).getTime();
  const M = 60e3;
  assert.strictEqual(T.formatDue(n0 + 1 * M, n0), "Due in 1 minute");
  assert.strictEqual(T.formatDue(n0 + 30 * M - 1000, n0), "Due in 30 minutes");
  assert.strictEqual(T.formatDue(n0 + 59 * M, n0), "Due in 59 minutes");
  assert.strictEqual(T.formatDue(n0 + 60 * M, n0), "Due in 1 hour");
  assert.strictEqual(T.formatDue(n0 + 100 * M, n0), "Due in 2 hours");
  assert.strictEqual(T.formatDue(n0 + 180 * M, n0), "Due in 3 hours");
  assert.strictEqual(T.formatDue(n0 + 181 * M, n0), T.formatWhen(n0 + 181 * M));
  assert.strictEqual(T.formatDue(n0 - M, n0), T.formatWhen(n0 - M));
  T.setLang("zh-TW");
  assert.strictEqual(T.formatDue(n0 + 30 * M, n0), "30 分鐘後到期");
  assert.strictEqual(T.formatDue(n0 + 120 * M, n0), "2 小時後到期");
  T.setLang("en");
}
console.log("ok");
