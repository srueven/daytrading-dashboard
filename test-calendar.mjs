import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.dirname(new URL(import.meta.url).pathname);
const code = fs.readFileSync(path.join(root, "calendar.js"), "utf8");
const sandbox = { console, Intl, Date, JSON, Number, String, Array, Math, Object };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const CV = sandbox.CalendarView;

const page = fs.readFileSync(path.join(root, "index.html"), "utf8");
const pricesYml = fs.readFileSync(path.join(root, ".github/workflows/refresh-prices.yml"), "utf8");
const calendarYml = fs.readFileSync(path.join(root, ".github/workflows/refresh-calendar.yml"), "utf8");

const FIXTURE = [
  { title: "CPI y/y", country: "GBP", date: "2026-11-18T02:00:00-05:00", impact: "High", forecast: "3.6%", previous: "3.5%" },
  { title: "Low noise", country: "USD", date: "2026-11-18T08:30:00-05:00", impact: "Low", forecast: "", previous: "1" },
  { title: "EUR medium", country: "EUR", date: "2026-11-18T05:00:00-05:00", impact: "Medium", forecast: "1", previous: "1" },
  { title: "FOMC Meeting Minutes", country: "USD", date: "2026-11-18T14:00:00-05:00", impact: "High", forecast: "", previous: "" },
  { title: "Unemployment Claims", country: "USD", date: "2026-11-19T08:30:00-05:00", impact: "Medium", forecast: "198K", previous: "200K" },
  { title: "Bank Holiday", country: "USD", date: "2026-11-19T00:00:00-05:00", impact: "Holiday", forecast: "", previous: "" },
  { title: "Next week", country: "USD", date: "2026-11-21T08:30:00-05:00", impact: "High", forecast: "", previous: "" },
  { title: "JPY high outside", country: "JPY", date: "2026-11-20T01:00:00-05:00", impact: "High", forecast: "", previous: "" },
];

function runCalendar(extraEnv, fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cal-"));
  const feed = path.join(dir, "feed.json");
  const out = path.join(dir, "calendar.json");
  fs.writeFileSync(feed, JSON.stringify(fixture));
  const env = Object.assign({}, process.env, extraEnv, {
    CALENDAR_FIXTURE: feed,
    CALENDAR_OUT: out,
    CALENDAR_NOW: "2026-11-18T13:00:00+01:00",
  });
  const result = spawnSync("python3", [path.join(root, "refresh-calendar.py")], { env, encoding: "utf8" });
  return { result, out, dir };
}

test("calendar workflow is scheduled on weekdays and price cron stays off", () => {
  assert.match(calendarYml, /cron:\s*"0 4,7,12,14 \* \* 1-5"/);
  assert.match(calendarYml, /workflow_dispatch:/);
  assert.match(calendarYml, /git add calendar\.json/);
  assert.equal(/^\s*schedule:/m.test(pricesYml), false);
  assert.equal(pricesYml.includes("cron:"), false);
  assert.equal(page.includes("setInterval"), false);
  assert.match(page, /id="kalender"/);
  assert.match(page, /calendar\.json\?t=/);
});

test("selector keeps USD high/medium and holidays, plus high-impact EUR GBP CNY JPY", () => {
  const { result, out } = runCalendar({}, FIXTURE);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(fs.readFileSync(out, "utf8"));
  const titles = payload.events.map(e => e.title);
  assert.deepEqual(titles, [
    "CPI y/y",
    "FOMC Meeting Minutes",
    "Bank Holiday",
    "Unemployment Claims",
  ]);
  const cpi = payload.events[0];
  assert.equal(cpi.country, "GBP");
  assert.equal(cpi.time, "08:00");
  assert.equal(cpi.date, "2026-11-18");
  assert.equal(cpi.impact_de, "hoch");
  assert.equal(cpi.forecast, "3.6%");
  assert.equal(cpi.previous, "3.5%");
  const fomc = payload.events[1];
  assert.equal(fomc.time, "20:00");
  assert.equal(fomc.forecast, undefined);
  const holiday = payload.events[2];
  assert.equal(holiday.impact_de, "feiertag");
  assert.equal(holiday.date, "2026-11-19");
  const claims = payload.events[3];
  assert.equal(claims.time, "14:30");
  assert.equal(claims.impact_de, "mittel");
  assert.match(payload.generated_at_label, /18\.11\.2026, 13:00 MEZ/);
  assert.match(payload.source, /Forex Factory/);
  assert.equal(JSON.stringify(payload).includes("holdings"), false);
});

test("unchanged events do not rewrite calendar.json", () => {
  const { result, out } = runCalendar({}, FIXTURE);
  assert.equal(result.status, 0);
  const first = fs.readFileSync(out, "utf8");
  const again = spawnSync("python3", [path.join(root, "refresh-calendar.py")], {
    env: Object.assign({}, process.env, {
      CALENDAR_FIXTURE: path.join(path.dirname(out), "feed.json"),
      CALENDAR_OUT: out,
      CALENDAR_NOW: "2026-11-18T18:00:00+01:00",
    }),
    encoding: "utf8",
  });
  assert.equal(again.status, 0);
  assert.match(again.stdout, /unchanged/);
  assert.equal(fs.readFileSync(out, "utf8"), first);
});

test("fetch failure keeps the previous file and exits 0", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cal-fail-"));
  const out = path.join(dir, "calendar.json");
  fs.writeFileSync(out, "{\"events\":[]}\n");
  const result = spawnSync("python3", [path.join(root, "refresh-calendar.py")], {
    env: Object.assign({}, process.env, {
      CALENDAR_URL: "http://127.0.0.1:9/missing.json",
      CALENDAR_OUT: out,
    }),
    encoding: "utf8",
  });
  delete process.env.CALENDAR_FIXTURE;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /WARN calendar fetch failed/);
  assert.equal(fs.readFileSync(out, "utf8"), "{\"events\":[]}\n");
});

test("view groups today and tomorrow and dims only past events", () => {
  const { out } = runCalendar({}, FIXTURE);
  const payload = JSON.parse(fs.readFileSync(out, "utf8"));
  const view = CV.prepare(payload, new Date("2026-11-18T12:00:00Z"));
  assert.equal(view.stale, false);
  assert.match(String(view.statusText), /^Stand: /);
  assert.equal(view.groups.map(g => String(g.label)).join("|"), "Heute|Morgen");
  const today = view.groups[0].items;
  assert.equal(String(today[0].title), "CPI y/y");
  assert.equal(today[0].past, true);
  assert.equal(String(today[1].title), "FOMC Meeting Minutes");
  assert.equal(today[1].past, false);
  const tomorrow = view.groups[1].items;
  assert.equal(tomorrow[0].past, false);
  assert.equal(String(tomorrow[0].impact), "feiertag");
});

test("missing calendar file falls back to the snapshot and labels it old", () => {
  const view = CV.prepareFallback({
    updated_at_label: "07.11.2026, 01:05 MEZ",
    calendar: [{ time_cest: "14:15", event: "ADP Employment Change (weekly)", impact: "hoch" }],
  });
  assert.equal(view.stale, true);
  assert.equal(view.statusText, "Alter Kalender · Stand 07.11.2026, 01:05 MEZ");
  assert.equal(view.groups[0].items[0].title, "ADP Employment Change (weekly)");
  assert.equal(view.groups[0].items[0].legacy, true);
});
