import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.dirname(new URL(import.meta.url).pathname);
const code = fs.readFileSync(path.join(root, "politics.js"), "utf8");
const sandbox = { console, Date, JSON, encodeURIComponent, String, Array, Object };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const PV = sandbox.PoliticsView;

const page = fs.readFileSync(path.join(root, "index.html"), "utf8");
const yml = fs.readFileSync(path.join(root, ".github/workflows/refresh-calendar.yml"), "utf8");
const pricesYml = fs.readFileSync(path.join(root, ".github/workflows/refresh-prices.yml"), "utf8");

const NOW = "2026-11-18T14:00:00+01:00";

function iso(hoursAgo) {
  return new Date(Date.parse(NOW) - hoursAgo * 3600 * 1000).toISOString();
}

const FIXTURE = [
  { title: "Trump tariffs hit China imports", source: "Reuters", url: "https://news.google.com/rss/articles/a", published: iso(1) },
  { title: "Trump tariffs hit China imports again", source: "AP", url: "https://news.google.com/rss/articles/b", published: iso(1.2) },
  { title: "OPEC weighs oil output after sanctions talk", source: "Bloomberg", url: "https://news.google.com/rss/articles/c", published: iso(2) },
  { title: "Fed chair defends Fed independence", source: "FT", url: "https://news.google.com/rss/articles/d", published: iso(3) },
  { title: "Iran sanctions rattle oil", source: "Reuters", url: "https://news.google.com/rss/articles/e", published: iso(4) },
  { title: "White House shutdown talks stall", source: "NPR", url: "https://news.google.com/rss/articles/f", published: iso(5) },
  { title: "Bessent outlines Treasury funding", source: "WSJ", url: "https://news.google.com/rss/articles/g", published: iso(6) },
  { title: "Old tariff story", source: "Reuters", url: "https://news.google.com/rss/articles/h", published: iso(30) },
  { title: "Local parade has no market angle", source: "Blog", url: "https://example.com/parade", published: iso(1) },
];

function runPolitics(extraEnv, fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pol-"));
  const feed = path.join(dir, "feed.json");
  const out = path.join(dir, "politics.json");
  fs.writeFileSync(feed, JSON.stringify(fixture));
  const result = spawnSync("python3", [path.join(root, "refresh-politics.py")], {
    env: Object.assign({}, process.env, extraEnv, {
      POLITICS_FIXTURE: feed,
      POLITICS_OUT: out,
      POLITICS_NOW: NOW,
    }),
    encoding: "utf8",
  });
  return { result, out };
}

test("politics job shares the weekday schedule and price cron stays off", () => {
  assert.match(yml, /cron:\s*"0 4,7,12,14 \* \* 1-5"/);
  assert.match(yml, /workflow_dispatch:/);
  assert.match(yml, /refresh-politics\.py/);
  assert.match(yml, /git add calendar\.json politics\.json/);
  assert.equal(pricesYml.includes("cron:"), false);
  assert.equal(page.includes("setInterval"), false);
  assert.match(page, /id="politik"/);
  assert.match(page, /politics\.json\?t=/);
  assert.match(page, /Politik wird geladen/);
});

test("selector keeps five diversified headlines from the last 24h", () => {
  const { result, out } = runPolitics({}, FIXTURE);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(payload.items.length, 5);
  const topics = payload.items.map(item => item.topic);
  assert.equal(new Set(topics).size, 5);
  assert.equal(topics.includes("Zölle"), true);
  assert.equal(topics.includes("Öl"), true);
  assert.equal(topics.includes("Fed"), true);
  assert.equal(payload.items.some(item => item.title === "Old tariff story"), false);
  assert.equal(payload.items.some(item => item.title.includes("parade")), false);
  assert.equal(payload.items.filter(item => item.topic === "Zölle").length, 1);
  const zolle = payload.items.find(item => item.topic === "Zölle");
  assert.equal(zolle.title, "Trump tariffs hit China imports");
  assert.match(zolle.published_zurich, /\d{2}:\d{2} MEZ/);
  assert.match(payload.generated_at_label, /18\.11\.2026, 14:00 MEZ/);
  assert.equal(payload.source, "Google News");
  assert.equal(JSON.stringify(payload).includes("holdings"), false);
});

test("unchanged headlines do not rewrite politics.json", () => {
  const { result, out } = runPolitics({}, FIXTURE);
  assert.equal(result.status, 0);
  const first = fs.readFileSync(out, "utf8");
  const again = spawnSync("python3", [path.join(root, "refresh-politics.py")], {
    env: Object.assign({}, process.env, {
      POLITICS_FIXTURE: path.join(path.dirname(out), "feed.json"),
      POLITICS_OUT: out,
      POLITICS_NOW: "2026-11-18T16:00:00+01:00",
    }),
    encoding: "utf8",
  });
  assert.equal(again.status, 0);
  assert.match(again.stdout, /unchanged/);
  assert.equal(fs.readFileSync(out, "utf8"), first);
});

test("fetch failure keeps the previous file and exits 0", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pol-fail-"));
  const out = path.join(dir, "politics.json");
  fs.writeFileSync(out, "{\"items\":[]}\n");
  const result = spawnSync("python3", [path.join(root, "refresh-politics.py")], {
    env: Object.assign({}, process.env, {
      POLITICS_GOOGLE_URL: "http://127.0.0.1:9/missing.xml",
      POLITICS_OUT: out,
    }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /WARN politics fetch failed/);
  assert.equal(fs.readFileSync(out, "utf8"), "{\"items\":[]}\n");
});

test("view shows stand line and fallback labels the snapshot", () => {
  const { out } = runPolitics({}, FIXTURE);
  const payload = JSON.parse(fs.readFileSync(out, "utf8"));
  const view = PV.prepare(payload);
  assert.equal(view.stale, false);
  assert.match(String(view.statusText), /^Stand: .+ · Google News$/);
  assert.equal(view.items.length, 5);
  const fallback = PV.prepareFallback({
    updated_at_label: "07.11.2026, 01:05 MEZ",
    politics: ["Trump–Xi-Gipfel bleibt der alte Text"],
  });
  assert.equal(fallback.stale, true);
  assert.equal(String(fallback.statusText), "Alte Politik-Liste · Stand 07.11.2026, 01:05 MEZ");
  assert.equal(String(fallback.items[0].title), "Trump–Xi-Gipfel bleibt der alte Text");
  assert.match(String(fallback.items[0].url), /^https:\/\//);
});
