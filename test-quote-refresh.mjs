import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const code = fs.readFileSync(new URL("./quote-refresh.js", import.meta.url), "utf8");
const sandbox = { console, Intl, URL, Date, Map, Set, Promise, AbortController, encodeURIComponent, Number, String, Array, Math, JSON, Error, Object, RegExp, isFinite, clearTimeout, setTimeout };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const QR = sandbox.QuoteRefresh;

const page = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
const workflow = fs.readFileSync(new URL("./.github/workflows/refresh-prices.yml", import.meta.url), "utf8");

test("no recurring timer in the browser runtime", () => {
  assert.equal(code.includes("setInterval"), false);
  assert.equal(page.includes("setInterval"), false);
  assert.match(workflow, /workflow_dispatch:/);
  assert.equal(/^\s*schedule:/m.test(workflow), false);
  assert.equal(workflow.includes("cron:"), false);
});

test("Zurich labels distinguish MEZ and MESZ", () => {
  assert.equal(QR.zurichLabel(new Date("2026-11-07T15:37:00Z")), "07.11.2026, 16:37 MEZ");
  assert.equal(QR.zurichLabel(new Date("2026-07-07T14:00:00Z")), "07.07.2026, 16:00 MESZ");
  const stamp = QR.zurichStamp(new Date("2026-11-07T15:37:08Z"));
  assert.match(stamp, /^2026-11-07T16:37:08\+01:00$/);
});

test("future vendor timestamps are not treated as fresh", () => {
  const now = Date.parse("2026-11-07T15:34:15Z");
  const future = QR.parseVendorMs("2026-11-07T17:39:00.000-0500");
  assert.equal(QR.trustworthyMs(future, now), null);
  const live = QR.parseVendorMs("2026-11-07T10:34:00.000-0500");
  assert.equal(QR.trustworthyMs(live, now), live);
  assert.equal(QR.parseVendorMs("2026-11-06"), null);
  const nanos = QR.parseVendorMs("2026-11-07T15:37:21.529679913Z");
  assert.equal(nanos, Date.parse("2026-11-07T15:37:21.529Z"));
});

test("session clock matches exchange hours, not a sticky vendor flag", () => {
  const sat = new Date("2026-11-07T15:00:00Z");
  assert.equal(QR.stockMarketState(sat, { trading_day_type: "WEEKEND", curmktstatus: "REG_MKT" }).market_state, "CLOSED");
  assert.equal(QR.futureMarketState(sat).market_state, "CLOSED");
  assert.equal(QR.futureMarketState(sat).market_open, false);

  const regular = new Date("2026-11-06T15:00:00Z"); // Friday 10:00 ET
  assert.equal(QR.stockMarketState(regular, { trading_day_type: "TRADING_DAY" }).market_state, "REGULAR");
  assert.equal(QR.stockMarketState(new Date("2026-11-06T13:00:00Z"), { trading_day_type: "TRADING_DAY" }).market_state, "PRE");
  const post = QR.stockMarketState(new Date("2026-11-06T21:30:00Z"), {
    trading_day_type: "TRADING_DAY",
    ExtendedMktQuote: { fullchange_pct: "1.25" },
  });
  assert.equal(post.market_state, "POST");
  assert.equal(post.show_premarket, true);
  assert.equal(post.premarket_pct, 1.25);
  assert.equal(QR.stockMarketState(new Date("2026-11-07T01:30:00Z"), { trading_day_type: "TRADING_DAY" }).market_state, "CLOSED");
  assert.equal(QR.stockMarketState(regular, { trading_day_type: "HOLIDAY" }).market_state, "CLOSED");

  assert.equal(QR.futureMarketState(new Date("2026-11-08T23:30:00Z")).market_state, "REGULAR"); // Sunday 18:30 ET
  assert.equal(QR.futureMarketState(new Date("2026-11-08T22:30:00Z")).market_state, "CLOSED");
  assert.equal(QR.futureMarketState(new Date("2026-11-09T22:30:00Z")).market_state, "CLOSED"); // Monday halt
  assert.equal(QR.futureMarketState(new Date("2026-11-09T23:30:00Z")).market_state, "REGULAR");
  assert.equal(QR.cmeTradeDate(new Date("2026-11-08T23:30:00Z")), "2026-11-09");
  assert.equal(QR.cmeTradeDate(new Date("2026-11-06T15:00:00Z")), "2026-11-06");
});

test("5T uses the previous completed bar when the last close is the live price", () => {
  const closes = [10, 11, 12, 13, 14, 15, 16];
  assert.equal(QR.change5d(16, closes), QR.pctChange(16, 11));
  assert.equal(QR.change5d(20, closes), QR.pctChange(20, 12));
  assert.equal(QR.change30d(16, closes), QR.pctChange(16, 10));
});

test("weekend bars are dropped and the one-month window starts on the calendar month", () => {
  assert.equal(QR.minusOneMonth("2026-11-07"), "2026-10-07");
  const bars = QR.parseCnbcBars({
    barData: {
      priceBars: [
        { tradeTime: "20261007000000", close: "10" },
        { tradeTime: "20261010000000", close: "99" },
        { tradeTime: "20261012000000", close: "11" },
        { tradeTime: "20261102000000", close: "12" },
        { tradeTime: "20261103000000", close: "13" },
        { tradeTime: "20261104000000", close: "14" },
        { tradeTime: "20261105000000", close: "15" },
        { tradeTime: "20261106000000", close: "16" },
        { tradeTime: "20261107000000", close: "80" },
      ],
    },
  });
  const weekdays = QR.weekdayBars(bars).filter(b => b.date <= "2026-11-06");
  assert.deepEqual(weekdays.map(b => b.date), [
    "2026-10-07", "2026-10-12", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06",
  ]);
  const closes = QR.windowCloses(weekdays, "2026-11-07");
  assert.equal(closes[0], 10);
  assert.equal(closes[closes.length - 1], 16);
  assert.equal(closes.includes(99), false);
  assert.equal(closes.includes(80), false);
});

test("closed futures use settlement, not the stale last trade", () => {
  const now = new Date("2026-11-07T15:34:00Z");
  const bars = [];
  for (let i = 0; i < 8; i += 1) {
    const day = 6 - i;
    // Build weekday dates ending 2026-11-06. Oct/Nov 2026 weekdays are filled explicitly below.
  }
  const dates = ["2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"];
  const closes = [100, 101, 102, 103, 104, 105, 110, 108];
  const parsed = dates.map((date, i) => ({ date, close: closes[i] }));
  const quote = {
    last: "27107.50",
    previous_day_closing: "110",
    trading_day_type: "TRADING_DAY",
    curmktstatus: "REG_MKT",
    last_time: "2026-11-07T17:39:00.000-0500",
  };
  const out = QR.applyListedSymbol(
    { symbol: "NQ=F" },
    "future",
    quote,
    parsed,
    { price: 108, date: "2026-11-06" },
    now,
  );
  assert.equal(out.price, 108);
  assert.equal(out.market_state, "CLOSED");
  assert.equal(out.change_pct, QR.pctChange(108, 110));
  assert.equal(out.show_premarket, false);
  assert.equal(out.sessionDate, "2026-11-06");
  assert.equal(out.sourceMs, null);
});

test("holdings stay separate percentages and match the saved snapshot", () => {
  const data = JSON.parse(fs.readFileSync(new URL("./data.json", import.meta.url), "utf8"));
  const stocks = data.stocks.map(s => ({ symbol: s.symbol, price: s.price }));
  const crypto = data.crypto.map(s => ({ symbol: s.symbol, price: s.price }));
  QR.applyNorm(stocks, data.holdings_norm);
  QR.applyNorm(crypto, data.crypto_holdings_norm);
  data.stocks.forEach((saved, i) => {
    assert.equal(stocks[i].weight_pct, saved.weight_pct);
    assert.equal(stocks[i].gv_pct, saved.gv_pct);
  });
  data.crypto.forEach((saved, i) => {
    assert.equal(crypto[i].weight_pct, saved.weight_pct);
    assert.equal(crypto[i].gv_pct, saved.gv_pct);
  });
  const stockWeight = stocks.reduce((sum, s) => sum + (s.weight_pct || 0), 0);
  assert.ok(Math.abs(stockWeight - 100) < 0.05);
  assert.equal(crypto.find(s => s.symbol === "BTC-USD").weight_pct, null);
  assert.equal(crypto.find(s => s.symbol === "XRP-USD").weight_pct, 100);
  assert.equal(JSON.stringify(stocks).includes("purchase"), false);
});

test("headline selection caps trump soundbites and keeps https links", () => {
  const now = Date.parse("2026-11-07T15:00:00Z");
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Trump: short line</title><link>https://www.financialjuice.com/a</link><pubDate>Sat, 07 Nov 2026 14:00:00 GMT</pubDate></item>
    <item><title>Trump: another short line</title><link>javascript:alert(1)</link><pubDate>Sat, 07 Nov 2026 14:10:00 GMT</pubDate></item>
    <item><title>Fed's Powell signals patience on interest rate path</title><link>https://www.financialjuice.com/b</link><pubDate>Sat, 07 Nov 2026 13:00:00 GMT</pubDate></item>
    <item><title>Oil falls as OPEC crude supply rises</title><link>https://www.financialjuice.com/c</link><pubDate>Sat, 07 Nov 2026 12:00:00 GMT</pubDate></item>
    <item><title>Gold holds after CPI inflation print</title><link>https://www.financialjuice.com/d</link><pubDate>Sat, 07 Nov 2026 11:00:00 GMT</pubDate></item>
    <item><title>Bitcoin and XRP swing with crypto risk</title><link>https://www.financialjuice.com/e</link><pubDate>Sat, 07 Nov 2026 10:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const rows = QR.refreshHeadlines(xml, new Date(now));
  assert.equal(rows.length, 5);
  const trump = rows.filter(r => r.title.toLowerCase().startsWith("trump:"));
  assert.equal(trump.length, 1);
  assert.equal(rows.some(r => String(r.link).startsWith("javascript:")), false);
  assert.match(rows[0].time, /^\d{2}:\d{2}$/);
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function sampleData() {
  return {
    updated_at: "2026-11-07T01:05:58+01:00",
    updated_at_label: "07.11.2026, 01:05 MEZ",
    futures: [{ symbol: "NQ=F", name: "Nasdaq-100 Micro", alias: "MNQ/NQ", price: 1, change_pct: 0, change_5d_pct: 0, change_30d_pct: 0, market_open: false }],
    stocks: [
      { symbol: "ONDS", name: "Ondas", alias: "ONDS", price: 1, change_pct: 0, change_5d_pct: 0, change_30d_pct: 0, weight_pct: 50, gv_pct: 1 },
      { symbol: "HIMS", name: "Hims", alias: "HIMS", price: 1, change_pct: 0, change_5d_pct: 0, change_30d_pct: 0, weight_pct: 50, gv_pct: -1 },
    ],
    crypto: [{ symbol: "BTC-USD", name: "Bitcoin", alias: "BTC", price: 1, change_pct: 0, change_5d_pct: 0, change_30d_pct: 0, weight_pct: null, gv_pct: null }],
    holdings_norm: { ONDS: { u: 2, c: 10 }, HIMS: { u: 1, c: 20 } },
    crypto_holdings_norm: { "BTC-USD": { u: 1, c: 100 } },
    financialjuice: [{ time: "01:00", title: "old", link: "https://www.financialjuice.com/old", source: "FinancialJuice" }],
    financialjuice_note: "alt",
    sources: ["Yahoo Finance"],
    stocks_summary: { change_pct: 0, change_5d_pct: 0, change_30d_pct: 0, premarket_pct: null, count: 2, label: "Stocks-Basket (gleichgewichtet)" },
  };
}

function bars(lastClose) {
  const dates = ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-11-06"];
  return {
    barData: {
      priceBars: dates.map((date, i) => ({
        tradeTime: date.replace(/-/g, "") + "000000",
        close: String(i === dates.length - 1 ? lastClose : 100 + i),
      })),
    },
  };
}

function quotes() {
  return {
    QuickQuoteResult: {
      QuickQuote: [
        { symbol: "@ND.1", code: "0", last: "27107.5", previous_day_closing: "100", trading_day_type: "TRADING_DAY", curmktstatus: "REG_MKT", last_time: "2026-11-07T17:39:00.000-0500" },
        { symbol: "ONDS", code: "0", last: "10", previous_day_closing: "8", trading_day_type: "WEEKEND", curmktstatus: "POST_MKT", last_time: "2026-11-06", ExtendedMktQuote: { fullchange_pct: "20" } },
        { symbol: "HIMS", code: "0", last: "30", previous_day_closing: "25", trading_day_type: "WEEKEND", curmktstatus: "POST_MKT", last_time: "2026-11-06" },
      ],
    },
  };
}

function installFetch(handler) {
  return async (url) => handler(String(url));
}

test("successful refresh updates prices, weights and the fetch time", async () => {
  const now = new Date("2026-11-07T15:37:00Z");
  const fetchImpl = installFetch(async (url) => {
    if (url.includes("quote.htm")) return jsonResponse(quotes());
    if (url.includes("restQuote")) {
      return jsonResponse({ FormattedQuoteResult: { FormattedQuote: [{ symbol: "@ND.1", code: 0, settlePrice: "108", settleDate: "2026-11-06" }] } });
    }
    if (url.includes("charts/1M.json")) {
      const close = url.includes("%40ND.1") || url.includes("@ND.1") ? 108 : url.includes("HIMS") ? 30 : 10;
      return jsonResponse(bars(close));
    }
    if (url.includes("/ticker")) return jsonResponse({ price: "200", time: "2026-11-07T15:36:30.123456789Z" });
    if (url.includes("/stats")) return jsonResponse({ open: "180" });
    if (url.includes("/candles")) {
      const start = Date.parse("2026-10-07T00:00:00Z") / 1000;
      const rows = [];
      for (let i = 0; i < 32; i += 1) rows.push([start + i * 86400, 1, 1, 1, 150 + i, 1]);
      return jsonResponse(rows);
    }
    if (url.includes("financialjuice")) {
      return jsonResponse(`<rss><channel><item><title>Oil and OPEC supply</title><link>https://www.financialjuice.com/x</link><pubDate>Sat, 07 Nov 2026 14:00:00 GMT</pubDate></item></channel></rss>`);
    }
    throw new Error("unexpected " + url);
  });
  const before = sampleData();
  const result = await QR.refreshQuotes(before, { fetchImpl, now, timeoutMs: 1000 });
  assert.equal(before.updated_at, "2026-11-07T01:05:58+01:00");
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.fjOk, true);
  assert.equal(result.data.futures[0].price, 108);
  assert.equal(result.data.futures[0].market_state, "CLOSED");
  assert.equal(result.data.stocks[0].price, 10);
  assert.equal(result.data.stocks[0].show_premarket, false);
  assert.equal(result.data.stocks[1].price, 30);
  assert.equal(result.data.crypto[0].price, 200);
  assert.equal(result.data.crypto[0].change_pct, QR.pctChange(200, 180));
  assert.equal(result.data.crypto[0].market_open, true);
  assert.equal(result.weightsFresh.stocks, true);
  assert.equal(result.weightsFresh.crypto, true);
  const weights = result.data.stocks.map(s => s.weight_pct);
  assert.equal(weights[0], 40);
  assert.equal(weights[1], 60);
  assert.equal(result.data.crypto[0].weight_pct, 100);
  assert.equal(result.data.updated_at_label, "07.11.2026, 16:37 MEZ");
  assert.match(result.sourceLabel, /Handelstag 06\.11\.2026/);
  assert.match(result.sourceLabel, /Krypto-Quelle/);
  assert.equal(result.data.financialjuice[0].title, "Oil and OPEC supply");
  assert.equal(result.data.financialjuice_note.includes("beim Öffnen"), true);
  assert.equal(JSON.stringify(result.data.sources).includes("Coinbase"), true);
  assert.equal(JSON.stringify(result.data).includes("purchase price"), false);
});

test("total timeout keeps the previous timestamp and prices", async () => {
  const before = sampleData();
  const fetchImpl = () => new Promise(() => {});
  const result = await QR.refreshQuotes(before, { fetchImpl, now: new Date("2026-11-07T15:37:00Z"), timeoutMs: 40 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.fetchedAtLabel, null);
  assert.equal(result.data.updated_at, before.updated_at);
  assert.equal(result.data.updated_at_label, before.updated_at_label);
  assert.equal(result.data.futures[0].price, 1);
  assert.equal(result.data.stocks[0].price, 1);
  assert.equal(result.data.crypto[0].price, 1);
  assert.equal(result.data.financialjuice[0].title, "old");
  assert.equal(result.view.staleSymbols.length, 4);
});

test("partial failure keeps the failed price and does not recompute stock weights", async () => {
  const now = new Date("2026-11-07T15:37:00Z");
  const fetchImpl = installFetch(async (url) => {
    if (url.includes("quote.htm")) {
      const body = quotes();
      body.QuickQuoteResult.QuickQuote = body.QuickQuoteResult.QuickQuote.map(row => (
        row.symbol === "HIMS" ? { symbol: "HIMS", code: "1" } : row
      ));
      return jsonResponse(body);
    }
    if (url.includes("restQuote")) {
      return jsonResponse({ FormattedQuoteResult: { FormattedQuote: [{ symbol: "@ND.1", code: 0, settlePrice: "108", settleDate: "2026-11-06" }] } });
    }
    if (url.includes("symbol=HIMS")) return jsonResponse("nope", 503);
    if (url.includes("charts/1M.json")) return jsonResponse(bars(10));
    if (url.includes("BTC-USD")) return jsonResponse("down", 500);
    if (url.includes("financialjuice")) return jsonResponse("blocked", 429);
    throw new Error("unexpected " + url);
  });
  const before = sampleData();
  const result = await QR.refreshQuotes(before, { fetchImpl, now, timeoutMs: 1000 });
  assert.equal(result.ok, true);
  assert.equal(result.complete, false);
  assert.equal(result.data.futures[0].price, 108);
  assert.equal(result.data.stocks[0].price, 10);
  assert.equal(result.data.stocks[1].price, 1);
  assert.equal(result.data.stocks[1].weight_pct, 50);
  assert.equal(result.data.stocks[0].weight_pct, 50);
  assert.equal(result.weightsFresh.stocks, false);
  assert.equal(result.data.crypto[0].price, 1);
  assert.equal(result.data.financialjuice[0].title, "old");
  assert.ok(result.view.staleSymbols.includes("HIMS"));
  assert.ok(result.view.staleSymbols.includes("BTC-USD"));
  assert.equal(result.fjOk, false);
  assert.equal(result.data.updated_at_label, "07.11.2026, 16:37 MEZ");
});

test("retry after a failed attempt can replace the stale snapshot", async () => {
  const now = new Date("2026-11-07T15:37:00Z");
  let attempt = 0;
  const fetchImpl = installFetch(async (url) => {
    if (attempt === 0) return new Promise(() => {});
    if (url.includes("quote.htm")) return jsonResponse(quotes());
    if (url.includes("restQuote")) {
      return jsonResponse({ FormattedQuoteResult: { FormattedQuote: [{ symbol: "@ND.1", code: 0, settlePrice: "108", settleDate: "2026-11-06" }] } });
    }
    if (url.includes("charts/1M.json")) {
      const close = url.includes("HIMS") ? 30 : url.includes("ND") ? 108 : 10;
      return jsonResponse(bars(close));
    }
    if (url.includes("/ticker")) return jsonResponse({ price: "200", time: "2026-11-07T15:36:30Z" });
    if (url.includes("/stats")) return jsonResponse({ open: "180" });
    if (url.includes("/candles")) return jsonResponse([[Date.parse("2026-11-06T00:00:00Z") / 1000, 1, 1, 1, 180, 1]]);
    if (url.includes("financialjuice")) return jsonResponse("<rss><channel></channel></rss>", 200);
    throw new Error(url);
  });
  const data = sampleData();
  const failed = await QR.refreshQuotes(data, { fetchImpl, now, timeoutMs: 30 });
  assert.equal(failed.ok, false);
  attempt = 1;
  const again = await QR.refreshQuotes(failed.data, { fetchImpl, now, timeoutMs: 1000 });
  assert.equal(again.ok, true);
  assert.equal(again.data.stocks[0].price, 10);
  assert.equal(again.data.crypto[0].price, 200);
  assert.notEqual(again.data.updated_at, data.updated_at);
});
