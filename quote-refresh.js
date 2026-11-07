/* On-open quotes for the static dashboard.
 * No polling, no API keys, no CORS proxy, no bot or model calls.
 * Stocks and futures: CNBC public quote + daily chart (browser CORS *).
 * BTC and XRP: Coinbase Exchange public market data (browser CORS *).
 * Headlines: FinancialJuice RSS when the browser can read it.
 * Last embedded snapshot stays on screen if a request fails.
 */
(function (root) {
  "use strict";

  var REQUEST_TIMEOUT_MS = 8000;
  var CHART_POOL = 4;
  var FJ_RSS_URL = "https://www.financialjuice.com/feed.ashx?xy=rss";
  var FJ_DEFAULT_URL = "https://www.financialjuice.com/home";
  var FJ_TITLE_PREFIX = "FinancialJuice: ";
  var FJ_NOTE = "Top 5 · letzte ~24h · beim Öffnen";

  /* Yahoo symbol → CNBC front contract / listing. */
  var CNBC_SYMBOL = {
    "NQ=F": "@ND.1",
    "ES=F": "@SP.1",
    "GC=F": "@GC.1",
    "CL=F": "@CL.1",
    ONDS: "ONDS",
    HIMS: "HIMS",
    COPX: "COPX",
    CELH: "CELH",
    SPCX: "SPCX",
  };

  var COINBASE_PRODUCT = {
    "BTC-USD": "BTC-USD",
    "XRP-USD": "XRP-USD",
  };

  var DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  function cloneData(data) {
    if (typeof structuredClone === "function") return structuredClone(data);
    return JSON.parse(JSON.stringify(data));
  }

  function num(value) {
    if (value == null || value === "") return null;
    var n = Number(String(value).replace(/,/g, "").replace(/%/g, "").replace(/\+/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }

  function roundTo(value, digits) {
    if (value == null || !Number.isFinite(value)) return null;
    var f = Math.pow(10, digits);
    return Math.round((value + Number.EPSILON) * f) / f;
  }

  function pctChange(next, prev) {
    if (next == null || prev == null || prev === 0) return null;
    return roundTo(((next - prev) / prev) * 100, 3);
  }

  /* Same bar rule as refresh-prices.py: last close within 0.2% counts as "today". */
  function change5d(price, closes) {
    if (price == null || !closes || !closes.length) return null;
    var last = closes[closes.length - 1];
    if (closes.length >= 6 && Math.abs(last - price) / Math.max(Math.abs(price), 1e-9) < 0.002) {
      return pctChange(price, closes[closes.length - 6]);
    }
    if (closes.length >= 5) return pctChange(price, closes[closes.length - 5]);
    return null;
  }

  function change30d(price, closes) {
    if (price == null || !closes || !closes.length) return null;
    return pctChange(price, closes[0]);
  }

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function ymd(y, m, d) {
    return y + "-" + pad(m) + "-" + pad(d);
  }

  function utcYmd(date) {
    return date.toISOString().slice(0, 10);
  }

  function addDays(ymdStr, days) {
    var p = ymdStr.split("-").map(Number);
    var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
    return dt.toISOString().slice(0, 10);
  }

  function minusOneMonth(ymdStr) {
    var p = ymdStr.split("-").map(Number);
    var year = p[0];
    var month = p[1] - 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
    var dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return ymd(year, month, Math.min(p[2], dim));
  }

  function isWeekendYmd(ymdStr) {
    var p = ymdStr.split("-").map(Number);
    var wd = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
    return wd === 0 || wd === 6;
  }

  function zonedParts(date, timeZone) {
    var fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    var map = {};
    fmt.formatToParts(date).forEach(function (part) {
      map[part.type] = part.value;
    });
    return {
      weekday: map.weekday,
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour) % 24,
      minute: Number(map.minute),
      second: Number(map.second),
    };
  }

  function zurichOffsetHours(date) {
    var fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Zurich",
      timeZoneName: "shortOffset",
    });
    var name = "";
    fmt.formatToParts(date).forEach(function (part) {
      if (part.type === "timeZoneName") name = part.value;
    });
    var m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (!m) return 1;
    var sign = m[1] === "-" ? -1 : 1;
    return sign * (Number(m[2]) + Number(m[3] || 0) / 60);
  }

  function zurichLabel(date) {
    var p = zonedParts(date, "Europe/Zurich");
    var off = zurichOffsetHours(date);
    var tz = off >= 2 ? "MESZ" : "MEZ";
    return pad(p.day) + "." + pad(p.month) + "." + p.year + ", " + pad(p.hour) + ":" + pad(p.minute) + " " + tz;
  }

  function zurichClock(date) {
    var p = zonedParts(date, "Europe/Zurich");
    return pad(p.hour) + ":" + pad(p.minute);
  }

  function zurichStamp(date) {
    var p = zonedParts(date, "Europe/Zurich");
    var off = zurichOffsetHours(date);
    var sign = off >= 0 ? "+" : "-";
    var abs = Math.abs(off);
    var hh = pad(Math.floor(abs));
    var mm = pad(Math.round((abs - Math.floor(abs)) * 60));
    return (
      p.year + "-" + pad(p.month) + "-" + pad(p.day) +
      "T" + pad(p.hour) + ":" + pad(p.minute) + ":" + pad(p.second) +
      sign + hh + ":" + mm
    );
  }

  function formatSession(ymdStr) {
    var p = ymdStr.split("-");
    return p[2] + "." + p[1] + "." + p[0];
  }

  function nyYmd(date) {
    var p = zonedParts(date, "America/New_York");
    return ymd(p.year, p.month, p.day);
  }

  function packState(name, pre) {
    var show = (name === "PRE" || name === "POST") && pre != null;
    return {
      market_state: name,
      market_open: name === "REGULAR",
      show_premarket: show,
      premarket_pct: show ? roundTo(pre, 3) : null,
    };
  }

  function stockMarketState(now, quote) {
    var dayType = quote && quote.trading_day_type ? String(quote.trading_day_type) : "";
    if (dayType && dayType !== "TRADING_DAY") return packState("CLOSED", null);
    var p = zonedParts(now, "America/New_York");
    var dow = DOW[p.weekday];
    var mins = p.hour * 60 + p.minute;
    if (dow === 0 || dow === 6) return packState("CLOSED", null);
    var pre = quote ? num(quote.ExtendedMktQuote && quote.ExtendedMktQuote.fullchange_pct) : null;
    if (mins >= 4 * 60 && mins < 9 * 60 + 30) return packState("PRE", pre);
    if (mins >= 9 * 60 + 30 && mins < 16 * 60) return packState("REGULAR", null);
    if (mins >= 16 * 60 && mins < 20 * 60) return packState("POST", pre);
    return packState("CLOSED", null);
  }

  /* CME Globex-style session for equity index, gold and WTI.
   * CNBC's curmktstatus stays REG_MKT through Saturday, so the clock decides. */
  function futureMarketState(now) {
    var p = zonedParts(now, "America/New_York");
    var dow = DOW[p.weekday];
    var mins = p.hour * 60 + p.minute;
    if (dow === 6) return packState("CLOSED", null);
    if (dow === 0 && mins < 18 * 60) return packState("CLOSED", null);
    if (dow === 5 && mins >= 17 * 60) return packState("CLOSED", null);
    if (dow >= 1 && dow <= 4 && mins >= 17 * 60 && mins < 18 * 60) return packState("CLOSED", null);
    return packState("REGULAR", null);
  }

  function cmeTradeDate(now) {
    var p = zonedParts(now, "America/New_York");
    var dow = DOW[p.weekday];
    var mins = p.hour * 60 + p.minute;
    var current = ymd(p.year, p.month, p.day);
    if ((dow === 0 && mins >= 18 * 60) || (dow >= 1 && dow <= 4 && mins >= 18 * 60)) {
      return addDays(current, 1);
    }
    return current;
  }

  function dateOnly(value) {
    var s = String(value || "");
    var m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
    return m ? m[1] : null;
  }

  function parseVendorMs(value) {
    if (value == null || value === "") return null;
    var s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    var m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
    if (!m) {
      var parsed = Date.parse(s);
      return Number.isFinite(parsed) ? parsed : null;
    }
    var frac = m[2] ? m[2].slice(0, 4) : "";
    var zone = m[3] || "Z";
    if (/^[+-]\d{4}$/.test(zone)) zone = zone.slice(0, 3) + ":" + zone.slice(3);
    var ms = Date.parse(m[1] + frac + zone);
    return Number.isFinite(ms) ? ms : null;
  }

  function trustworthyMs(ms, nowMs) {
    if (ms == null || !Number.isFinite(ms)) return null;
    if (ms > nowMs + 2 * 60 * 1000) return null;
    return ms;
  }

  function dedupeBars(bars) {
    var map = new Map();
    (bars || []).forEach(function (bar) {
      if (!bar || !bar.date || bar.close == null || !Number.isFinite(bar.close)) return;
      map.set(bar.date, bar.close);
    });
    return Array.from(map.keys()).sort().map(function (date) {
      return { date: date, close: map.get(date) };
    });
  }

  function upsertBar(bars, date, close) {
    if (!date || close == null) return bars;
    var next = bars.filter(function (bar) { return bar.date !== date; });
    next.push({ date: date, close: close });
    next.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return next;
  }

  function parseCnbcBars(body) {
    var rows = body && body.barData && body.barData.priceBars;
    if (!Array.isArray(rows)) return null;
    var out = [];
    rows.forEach(function (row) {
      var close = num(row && row.close);
      var raw = String((row && row.tradeTime) || "");
      if (close == null || !/^\d{8}/.test(raw)) return;
      out.push({
        date: raw.slice(0, 4) + "-" + raw.slice(4, 6) + "-" + raw.slice(6, 8),
        close: close,
      });
    });
    return dedupeBars(out);
  }

  function parseCoinbaseCandles(body) {
    if (!Array.isArray(body)) return null;
    var out = [];
    body.forEach(function (row) {
      if (!Array.isArray(row) || row.length < 5) return;
      var sec = Number(row[0]);
      var close = num(row[4]);
      if (!Number.isFinite(sec) || close == null) return;
      out.push({ date: new Date(sec * 1000).toISOString().slice(0, 10), close: close });
    });
    return dedupeBars(out);
  }

  function weekdayBars(bars) {
    return dedupeBars(bars).filter(function (bar) { return !isWeekendYmd(bar.date); });
  }

  function windowCloses(bars, todayUtc) {
    var start = minusOneMonth(todayUtc);
    return bars.filter(function (bar) { return bar.date >= start; }).map(function (bar) { return bar.close; });
  }

  function settledSeries(bars, settle, todayUtc) {
    var series = weekdayBars(bars).filter(function (bar) { return bar.date <= todayUtc; });
    if (settle && settle.date && settle.price != null && settle.date <= todayUtc) {
      series = upsertBar(series, settle.date, settle.price);
    }
    return series;
  }

  function applyNorm(items, norm) {
    var vals = {};
    var total = 0;
    (items || []).forEach(function (item) {
      var h = norm && norm[item.symbol];
      if (h && item.price != null && h.u) {
        vals[item.symbol] = item.price * h.u;
        total += vals[item.symbol];
      }
    });
    (items || []).forEach(function (item) {
      var h = norm && norm[item.symbol];
      if (!h || vals[item.symbol] == null || total <= 0) {
        item.weight_pct = null;
        item.gv_pct = null;
        return;
      }
      item.weight_pct = roundTo((vals[item.symbol] / total) * 100, 2);
      item.gv_pct = h.c ? roundTo((vals[item.symbol] / h.c - 1) * 100, 2) : null;
    });
  }

  function average(values) {
    var nums = values.filter(function (v) { return v != null && Number.isFinite(Number(v)); });
    if (!nums.length) return null;
    var sum = nums.reduce(function (a, b) { return a + Number(b); }, 0);
    return roundTo(sum / nums.length, 3);
  }

  function recomputeStocksSummary(stocks) {
    return {
      change_pct: average(stocks.map(function (s) { return s.change_pct; })),
      change_5d_pct: average(stocks.map(function (s) { return s.change_5d_pct; })),
      change_30d_pct: average(stocks.map(function (s) { return s.change_30d_pct; })),
      premarket_pct: average(stocks.map(function (s) { return s.premarket_pct; })),
      count: stocks.length,
      label: "Stocks-Basket (gleichgewichtet)",
    };
  }

  function reasonOf(err) {
    if (!err) return "empty";
    if (err.code === "timeout" || err.name === "AbortError") return "timeout";
    if (err.code === "unmapped" || err.code === "empty" || err.code === "parse" || err.code === "http") {
      return err.code;
    }
    if (err.status) return "http";
    return "http";
  }

  function fetchText(url, opts) {
    var fetchImpl = opts.fetchImpl;
    var timeoutMs = opts.timeoutMs;
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = null;
    var timed = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        var err = new Error("timeout");
        err.code = "timeout";
        reject(err);
      }, timeoutMs);
    });
    var init = { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" };
    if (ctrl) init.signal = ctrl.signal;
    var task = Promise.resolve()
      .then(function () { return fetchImpl(url, init); })
      .then(function (res) {
        if (!res || !res.ok) {
          var httpErr = new Error("HTTP " + (res && res.status));
          httpErr.code = "http";
          httpErr.status = res && res.status;
          throw httpErr;
        }
        return res.text();
      })
      .catch(function (err) {
        if (err && (err.name === "AbortError" || err.code === "timeout")) {
          var timeoutErr = new Error("timeout");
          timeoutErr.code = "timeout";
          throw timeoutErr;
        }
        if (err && err.code) throw err;
        var netErr = new Error(err && err.message ? err.message : "network");
        netErr.code = "http";
        throw netErr;
      });
    /* Keep a handler so a late abort does not surface as an unhandled rejection. */
    task.catch(function () {});
    return Promise.race([task, timed]).finally(function () { clearTimeout(timer); });
  }

  function fetchJson(url, opts) {
    return fetchText(url, opts).then(function (text) {
      try {
        return JSON.parse(text);
      } catch (e) {
        var err = new Error("parse");
        err.code = "parse";
        throw err;
      }
    });
  }

  function mapPool(items, limit, fn) {
    var ret = new Array(items.length);
    var cursor = 0;
    function worker() {
      if (cursor >= items.length) return Promise.resolve();
      var idx = cursor;
      cursor += 1;
      return Promise.resolve()
        .then(function () { return fn(items[idx], idx); })
        .then(function (value) {
          ret[idx] = value;
          return worker();
        });
    }
    var n = Math.max(1, Math.min(limit, items.length || 1));
    var jobs = [];
    for (var i = 0; i < n && i < items.length; i += 1) jobs.push(worker());
    return Promise.all(jobs).then(function () { return ret; });
  }

  function quoteUrl(symbols) {
    return (
      "https://quote.cnbc.com/quote-html-webservice/quote.htm?partnerId=2&requestMethod=quick&exthrs=1&output=json&noform=1&symbols=" +
      encodeURIComponent(symbols.join("|")).replace(/%7C/g, "|")
    );
  }

  function restUrl(symbols) {
    return (
      "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1&symbols=" +
      encodeURIComponent(symbols.join("|")).replace(/%7C/g, "|")
    );
  }

  function chartUrl(symbol) {
    return "https://ts-api.cnbc.com/harmony/app/charts/1M.json?symbol=" + encodeURIComponent(symbol);
  }

  function coinbaseUrl(product, kind) {
    var base = "https://api.exchange.coinbase.com/products/" + encodeURIComponent(product);
    if (kind === "ticker") return base + "/ticker";
    if (kind === "stats") return base + "/stats";
    return base + "/candles?granularity=86400";
  }

  function indexBySymbol(list) {
    var map = new Map();
    (list || []).forEach(function (row) {
      if (row && row.symbol) map.set(row.symbol, row);
    });
    return map;
  }

  function quoteOk(row) {
    if (!row) return false;
    var code = row.code;
    return code == null || code === 0 || code === "0";
  }

  function assignPct(item, key, value, staleSet) {
    if (value == null) staleSet.add(item.symbol);
    else item[key] = value;
  }

  function applyListedSymbol(item, kind, quote, bars, settle, now) {
    var today = utcYmd(now);
    var state = kind === "future" ? futureMarketState(now) : stockMarketState(now, quote);
    var series = weekdayBars(bars || []);
    var price = null;
    var sessionDate = null;
    if (kind === "future" && state.market_state !== "REGULAR") {
      series = settledSeries(series, settle, today);
      price = series.length ? series[series.length - 1].close : null;
      sessionDate = series.length ? series[series.length - 1].date : (settle && settle.date);
    } else if (kind === "future") {
      price = num(quote.last);
      sessionDate = cmeTradeDate(now);
      if (price != null && sessionDate) series = upsertBar(series, sessionDate, price);
    } else if (state.market_state === "REGULAR" || state.market_state === "POST") {
      price = num(quote.last);
      sessionDate = nyYmd(now);
      series = series.filter(function (bar) { return bar.date <= sessionDate; });
      if (price != null) series = upsertBar(series, sessionDate, price);
    } else {
      price = num(quote.last);
      sessionDate = dateOnly(quote.last_time);
      if (sessionDate) series = series.filter(function (bar) { return bar.date <= sessionDate; });
      else if (series.length) sessionDate = series[series.length - 1].date;
    }
    if (price == null) return null;
    var closes = windowCloses(series, today);
    var prev = num(quote.previous_day_closing);
    if (prev == null && closes.length >= 2) prev = closes[closes.length - 2];
    var day = pctChange(price, prev);
    var sourceMs = null;
    if (kind === "future" && state.market_state === "REGULAR") {
      sourceMs = trustworthyMs(parseVendorMs(quote.last_time), now.getTime());
    }
    return {
      price: price,
      change_pct: day,
      change_5d_pct: change5d(price, closes),
      change_30d_pct: change30d(price, closes),
      market_state: state.market_state,
      market_open: state.market_open,
      show_premarket: state.show_premarket,
      premarket_pct: state.premarket_pct,
      sessionDate: sessionDate,
      sourceMs: sourceMs,
      rangesReady: closes.length >= 5,
    };
  }

  function applyCrypto(item, ticker, stats, candles, now) {
    var price = num(ticker && ticker.price);
    if (price == null) return null;
    var today = utcYmd(now);
    var bars = parseCoinbaseCandles(candles) || [];
    var start = minusOneMonth(today);
    var series = bars.filter(function (bar) { return bar.date >= start && bar.date <= today; });
    series = upsertBar(series, today, price);
    var closes = series.map(function (bar) { return bar.close; });
    var open = num(stats && stats.open);
    var day = pctChange(price, open);
    if (day == null && closes.length >= 2) day = pctChange(price, closes[closes.length - 2]);
    return {
      price: price,
      change_pct: day,
      change_5d_pct: change5d(price, closes),
      change_30d_pct: change30d(price, closes),
      market_state: "REGULAR",
      market_open: true,
      show_premarket: false,
      premarket_pct: null,
      sessionDate: today,
      sourceMs: trustworthyMs(parseVendorMs(ticker && ticker.time), now.getTime()),
      rangesReady: closes.length >= 5,
    };
  }

  function writeQuote(item, computed, fresh, rangeStale) {
    if (!computed) return false;
    item.price = computed.price;
    item.market_state = computed.market_state;
    item.market_open = computed.market_open;
    item.show_premarket = computed.show_premarket;
    item.premarket_pct = computed.premarket_pct;
    assignPct(item, "change_pct", computed.change_pct, rangeStale);
    assignPct(item, "change_5d_pct", computed.change_5d_pct, rangeStale);
    assignPct(item, "change_30d_pct", computed.change_30d_pct, rangeStale);
    if (!computed.rangesReady) rangeStale.add(item.symbol);
    fresh.add(item.symbol);
    return true;
  }

  function sourceSummary(rows) {
    var sessions = [];
    var cryptoMs = [];
    rows.forEach(function (row) {
      if (!row) return;
      if (row.kind === "crypto") {
        if (row.sourceMs != null) cryptoMs.push(row.sourceMs);
      } else if (row.sessionDate) {
        sessions.push(row.sessionDate);
      }
    });
    var parts = [];
    if (sessions.length) {
      sessions.sort();
      var oldest = sessions[0];
      var newest = sessions[sessions.length - 1];
      parts.push(
        "Aktien & Futures: Handelstag " +
          (oldest === newest ? formatSession(oldest) : formatSession(oldest) + "–" + formatSession(newest))
      );
    }
    if (cryptoMs.length) {
      cryptoMs.sort(function (a, b) { return a - b; });
      parts.push("Krypto-Quelle " + zurichLabel(new Date(cryptoMs[cryptoMs.length - 1])));
    }
    return parts.join(" · ");
  }

  function aliasOf(item) {
    return item.alias || item.symbol;
  }

  /* FinancialJuice scoring — same rules as refresh-prices.py. */
  var FJ_KEYWORDS = [
    ["federal reserve", 12], ["fomc", 12], ["powell", 11], ["jefferson", 9], ["williams", 9],
    ["barkin", 8], ["fed ", 10], ["fed's", 10], ["fed:", 10], ["interest rate", 10],
    ["rate cut", 10], ["rate hike", 10], ["rates", 7], ["treasury", 8], ["yields", 8],
    ["10-year", 7], ["10y", 7], ["cpi", 11], ["pce", 10], ["inflation", 9], ["nfp", 11],
    ["nonfarm", 11], ["payroll", 9], ["adp", 10], ["unemployment", 8], ["jobless", 7],
    ["nasdaq", 10], ["s&p", 10], ["s&amp;p", 10], ["dow ", 7], ["mnq", 10], ["mes ", 8],
    ["futures", 5], ["equity", 5], ["stock market", 7], ["opec", 11], ["crude", 10],
    ["brent", 9], ["wti", 9], ["oil", 9], ["gasoline", 6], ["gold", 10], ["xau", 8],
    ["silver", 6], ["commodity", 5], ["bitcoin", 10], ["btc", 10], ["xrp", 10],
    ["ripple", 9], ["crypto", 8], ["ethereum", 6], ["ecb", 9], ["lagarde", 8], ["boj", 7],
    ["tariff", 10], ["section 301", 9], ["ustr", 8], ["china", 8], ["xi ", 8],
    ["beijing", 7], ["iran", 10], ["israel", 7], ["ukraine", 7], ["russia", 7],
    ["war", 8], ["sanctions", 8], ["geopolit", 8], ["venezuela", 7], ["greenland", 6],
    ["unga", 5], ["un general", 5], ["trump", 4], ["white house", 5], ["gdp", 7],
    ["recession", 8], ["dollar", 6], ["dxy", 7],
  ];

  var FJ_TOPIC_RULES = [
    ["fed_rates", ["fed", "fomc", "powell", "jefferson", "williams", "barkin", "rate cut", "rate hike", "interest rate", "discount window", "monetary policy", "treasury", "yield"]],
    ["inflation_labor", ["cpi", "pce", "inflation", "nfp", "nonfarm", "payroll", "adp", "unemployment", "jobless"]],
    ["oil", ["oil", "opec", "crude", "brent", "wti", "gasoline", "petroleum"]],
    ["gold", ["gold", "xau", "bullion"]],
    ["crypto", ["bitcoin", "btc", "xrp", "ripple", "crypto", "ethereum"]],
    ["equities", ["nasdaq", "s&p", "s&amp;p", "dow", "mnq", "mes", "stock market", "equity", "futures"]],
    ["china_trade", ["china", "xi ", "beijing", "tariff", "section 301", "ustr", "trade war"]],
    ["iran_geo", ["iran", "israel", "middle east"]],
    ["russia_ukraine", ["russia", "ukraine", "putin", "zelensky"]],
    ["ecb_eu", ["ecb", "lagarde", "eurozone", "eu envoys", "eu "]],
    ["trump_other", ["trump"]],
  ];

  function escapeReg(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function kwMatch(low, kw) {
    var k = String(kw || "").trim().toLowerCase();
    if (!k) return false;
    return new RegExp("(?<![a-z0-9])" + escapeReg(k) + "(?![a-z0-9])").test(low);
  }

  function xmlTag(block, name) {
    var m = new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">", "i").exec(block);
    if (!m) return "";
    return decodeXml(m[1].trim());
  }

  function decodeXml(s) {
    return String(s)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");
  }

  function parseFjRss(xmlText) {
    var items = [];
    var re = /<item>([\s\S]*?)<\/item>/gi;
    var m;
    while ((m = re.exec(xmlText))) {
      var block = m[1];
      var title = xmlTag(block, "title");
      var link = xmlTag(block, "link");
      var pub = xmlTag(block, "pubDate");
      if (!title) continue;
      if (title.indexOf(FJ_TITLE_PREFIX) === 0) title = title.slice(FJ_TITLE_PREFIX.length).trim();
      title = title.replace(/\s+/g, " ").trim();
      var dt = null;
      if (pub) {
        var ms = Date.parse(pub);
        if (Number.isFinite(ms)) dt = ms;
      }
      items.push({ title: title, link: link, pubDate: pub, dt: dt });
    }
    return items;
  }

  function fjTopic(title) {
    var low = title.toLowerCase();
    for (var i = 0; i < FJ_TOPIC_RULES.length; i += 1) {
      var keys = FJ_TOPIC_RULES[i][1];
      for (var j = 0; j < keys.length; j += 1) {
        if (kwMatch(low, keys[j])) return FJ_TOPIC_RULES[i][0];
      }
    }
    return "other";
  }

  function fjIsTrumpSoundbite(title) {
    var t = title.trim();
    var low = t.toLowerCase();
    if (low.indexOf("trump:") === 0) return true;
    if (low.indexOf("trump at un:") === 0 && t.length < 80) return true;
    return false;
  }

  function scoreFjItem(item, nowMs) {
    var title = item.title;
    var low = title.toLowerCase();
    var score = 0;
    FJ_KEYWORDS.forEach(function (pair) {
      if (kwMatch(low, pair[0])) score += pair[1];
    });
    if (item.dt != null) {
      var ageH = (nowMs - item.dt) / 3600000;
      if (ageH <= 0) score += 15;
      else if (ageH <= 6) score += 12;
      else if (ageH <= 12) score += 9;
      else if (ageH <= 24) score += 6;
      else if (ageH <= 36) score += 2;
      else score -= 8;
    } else score -= 3;
    if (fjIsTrumpSoundbite(title)) score -= 6;
    if (title.length < 40 && fjIsTrumpSoundbite(title)) score -= 3;
    return score;
  }

  function selectTopFj(items, n, nowMs) {
    n = n || 5;
    var cutoff = nowMs - 36 * 3600000;
    var recent = items.filter(function (it) { return it.dt == null || it.dt >= cutoff; });
    var pool = recent.length ? recent : items.slice();
    var ranked = pool.slice().sort(function (a, b) { return scoreFjItem(b, nowMs) - scoreFjItem(a, nowMs); });
    var selected = [];
    var topics = {};
    var trumpCount = 0;
    function nearDup(it) {
      var key = it.title.toLowerCase().replace(/\W+/g, "").slice(0, 48);
      if (!key) return false;
      return selected.some(function (s) {
        var sk = s.title.toLowerCase().replace(/\W+/g, "").slice(0, 48);
        return key === sk || key.indexOf(sk) !== -1 || sk.indexOf(key) !== -1;
      });
    }
    function tryAdd(it, allowDup) {
      var topic = fjTopic(it.title);
      var isTrump = fjIsTrumpSoundbite(it.title);
      if (isTrump && trumpCount >= 1) return false;
      if (!allowDup && topics[topic] && topic !== "other") return false;
      if (nearDup(it)) return false;
      selected.push(it);
      topics[topic] = true;
      if (isTrump) trumpCount += 1;
      return true;
    }
    ranked.forEach(function (it) {
      if (selected.length >= n) return;
      tryAdd(it, false);
    });
    if (selected.length < n) {
      ranked.forEach(function (it) {
        if (selected.length >= n) return;
        if (selected.indexOf(it) !== -1) return;
        tryAdd(it, false);
      });
    }
    if (selected.length < n) {
      ranked.forEach(function (it) {
        if (selected.length >= n) return;
        if (selected.indexOf(it) !== -1) return;
        tryAdd(it, true);
      });
    }
    selected.sort(function (a, b) { return (b.dt || 0) - (a.dt || 0); });
    return selected.slice(0, n);
  }

  function safeHttpUrl(url) {
    try {
      var u = new URL(url, FJ_DEFAULT_URL);
      if (u.protocol === "https:" || u.protocol === "http:") return u.href;
    } catch (e) { /* ignore */ }
    return FJ_DEFAULT_URL;
  }

  function fjRecord(item) {
    return {
      time: item.dt != null ? zurichClock(new Date(item.dt)) : "--:--",
      title: item.title,
      link: safeHttpUrl(item.link || FJ_DEFAULT_URL),
      source: "FinancialJuice",
    };
  }

  function refreshHeadlines(xmlText, now) {
    if (!xmlText || String(xmlText).toLowerCase().indexOf("<item>") === -1) throw new Error("empty");
    if (xmlText.indexOf("error code: 1015") !== -1) throw new Error("blocked");
    var items = parseFjRss(xmlText);
    if (!items.length) throw new Error("empty");
    return selectTopFj(items, 5, now.getTime()).map(fjRecord);
  }

  async function refreshQuotes(data, opts) {
    opts = opts || {};
    var fetchImpl = opts.fetchImpl || root.fetch.bind(root);
    var now = opts.now instanceof Date ? opts.now : new Date();
    var timeoutMs = opts.timeoutMs || REQUEST_TIMEOUT_MS;
    var net = { fetchImpl: fetchImpl, timeoutMs: timeoutMs };
    var next = cloneData(data || {});
    var failures = [];
    var fresh = new Set();
    var rangeStale = new Set();
    var sourceRows = [];
    var timedOut = false;

    function pushFail(symbol, err) {
      var reason = reasonOf(err);
      if (reason === "timeout") timedOut = true;
      failures.push({ symbol: symbol, reason: reason });
    }

    var listed = [];
    (next.futures || []).forEach(function (item) { listed.push({ item: item, kind: "future" }); });
    (next.stocks || []).forEach(function (item) { listed.push({ item: item, kind: "stock" }); });
    var cryptos = next.crypto || [];

    listed.forEach(function (row) {
      if (!CNBC_SYMBOL[row.item.symbol]) pushFail(row.item.symbol, { code: "unmapped" });
    });
    cryptos.forEach(function (item) {
      if (!COINBASE_PRODUCT[item.symbol]) pushFail(item.symbol, { code: "unmapped" });
    });

    var cnbcRows = listed.filter(function (row) { return CNBC_SYMBOL[row.item.symbol]; });
    var cnbcSymbols = cnbcRows.map(function (row) { return CNBC_SYMBOL[row.item.symbol]; });
    var futureSymbols = cnbcRows.filter(function (row) { return row.kind === "future"; }).map(function (row) {
      return CNBC_SYMBOL[row.item.symbol];
    });

    var quickP = cnbcSymbols.length
      ? fetchJson(quoteUrl(cnbcSymbols), net).then(function (body) { return { body: body }; }, function (err) { return { error: err }; })
      : Promise.resolve({ body: null });
    var restP = futureSymbols.length
      ? fetchJson(restUrl(futureSymbols), net).then(function (body) { return { body: body }; }, function (err) { return { error: err }; })
      : Promise.resolve({ body: null });
    var chartP = mapPool(cnbcRows, CHART_POOL, function (row) {
      var symbol = CNBC_SYMBOL[row.item.symbol];
      return fetchJson(chartUrl(symbol), net).then(
        function (body) { return { yahoo: row.item.symbol, body: body }; },
        function (err) { return { yahoo: row.item.symbol, error: err }; }
      );
    });
    var cryptoP = mapPool(cryptos.filter(function (item) { return COINBASE_PRODUCT[item.symbol]; }), CHART_POOL, function (item) {
      var product = COINBASE_PRODUCT[item.symbol];
      return Promise.all([
        fetchJson(coinbaseUrl(product, "ticker"), net),
        fetchJson(coinbaseUrl(product, "stats"), net),
        fetchJson(coinbaseUrl(product, "candles"), net),
      ]).then(
        function (parts) { return { symbol: item.symbol, ticker: parts[0], stats: parts[1], candles: parts[2] }; },
        function (err) { return { symbol: item.symbol, error: err }; }
      );
    });
    var fjP = fetchText(FJ_RSS_URL, net).then(
      function (text) { return { text: text }; },
      function (err) { return { error: err }; }
    );

    var quickRes = await quickP;
    var restRes = await restP;
    var chartRes = await chartP;
    var cryptoRes = await cryptoP;
    var fjRes = await fjP;

    var quotes = indexBySymbol(
      quickRes.body && quickRes.body.QuickQuoteResult && quickRes.body.QuickQuoteResult.QuickQuote
    );
    var settles = indexBySymbol(
      restRes.body && restRes.body.FormattedQuoteResult && restRes.body.FormattedQuoteResult.FormattedQuote
    );
    var charts = new Map();
    (chartRes || []).forEach(function (row) {
      if (row) charts.set(row.yahoo, row);
    });

    cnbcRows.forEach(function (row) {
      var cnbc = CNBC_SYMBOL[row.item.symbol];
      if (quickRes.error) {
        pushFail(row.item.symbol, quickRes.error);
        return;
      }
      var quote = quotes.get(cnbc);
      if (!quoteOk(quote)) {
        pushFail(row.item.symbol, { code: "empty" });
        return;
      }
      var chart = charts.get(row.item.symbol);
      var bars = chart && !chart.error ? parseCnbcBars(chart.body) : null;
      if (!chart || chart.error || !bars) rangeStale.add(row.item.symbol);
      var settleRow = settles.get(cnbc);
      var settle = null;
      if (settleRow && quoteOk(settleRow) && num(settleRow.settlePrice) != null && dateOnly(settleRow.settleDate)) {
        settle = { price: num(settleRow.settlePrice), date: dateOnly(settleRow.settleDate) };
      }
      var computed = null;
      try {
        computed = applyListedSymbol(row.item, row.kind, quote, bars || [], settle, now);
      } catch (e) {
        computed = null;
      }
      if (!computed || !writeQuote(row.item, computed, fresh, rangeStale)) {
        pushFail(row.item.symbol, { code: "empty" });
        rangeStale.delete(row.item.symbol);
        return;
      }
      sourceRows.push({
        kind: row.kind,
        sessionDate: computed.sessionDate,
        sourceMs: computed.sourceMs,
      });
    });

    (cryptoRes || []).forEach(function (row) {
      if (!row) return;
      var item = cryptos.filter(function (c) { return c.symbol === row.symbol; })[0];
      if (!item) return;
      if (row.error) {
        pushFail(row.symbol, row.error);
        return;
      }
      var computed = applyCrypto(item, row.ticker, row.stats, row.candles, now);
      if (!computed || !writeQuote(item, computed, fresh, rangeStale)) {
        pushFail(row.symbol, { code: "empty" });
        return;
      }
      sourceRows.push({ kind: "crypto", sessionDate: computed.sessionDate, sourceMs: computed.sourceMs });
    });

    var fjOk = false;
    var fjError = null;
    if (fjRes && fjRes.text) {
      try {
        var headlines = refreshHeadlines(fjRes.text, now);
        if (headlines.length) {
          next.financialjuice = headlines;
          next.financialjuice_note = FJ_NOTE;
          next.financialjuice_url = next.financialjuice_url || FJ_DEFAULT_URL;
          fjOk = true;
        } else fjError = "empty";
      } catch (e) {
        fjError = "empty";
      }
    } else {
      fjError = reasonOf(fjRes && fjRes.error);
      if (fjError === "timeout") timedOut = true;
    }

    var stockItems = next.stocks || [];
    var cryptoItems = next.crypto || [];
    var allStocksFresh = stockItems.length > 0 && stockItems.every(function (s) { return fresh.has(s.symbol); });
    var allCryptoFresh = cryptoItems.length > 0 && cryptoItems.every(function (s) { return fresh.has(s.symbol); });
    if (allStocksFresh) {
      applyNorm(stockItems, next.holdings_norm || {});
      next.stocks_summary = recomputeStocksSummary(stockItems);
    }
    if (allCryptoFresh) applyNorm(cryptoItems, next.crypto_holdings_norm || {});

    var quoteTotal = listed.length + cryptos.length;
    var fetchedAtLabel = null;
    if (fresh.size > 0) {
      next.updated_at = zurichStamp(now);
      next.updated_at_label = zurichLabel(now);
      fetchedAtLabel = next.updated_at_label;
      next.source_as_of_label = sourceSummary(sourceRows);
      var sources = (next.sources || []).filter(function (s) { return String(s).indexOf("Live:") !== 0; });
      sources.push("Live: CNBC Quote Cache (Aktien & Futures) und Coinbase Exchange (BTC, XRP), Abruf beim Öffnen");
      if (fjOk) sources.push("Live: FinancialJuice RSS, Abruf beim Öffnen");
      next.sources = sources;
    }

    var failedSymbols = {};
    failures.forEach(function (f) { failedSymbols[f.symbol] = true; });
    /* A range flag on a fully failed symbol is just stale, not a separate warning. */
    Array.from(rangeStale).forEach(function (symbol) {
      if (failedSymbols[symbol]) rangeStale.delete(symbol);
    });

    return {
      data: next,
      ok: fresh.size > 0,
      complete: fresh.size === quoteTotal && rangeStale.size === 0 && failures.length === 0,
      timedOut: timedOut,
      failures: failures,
      fetchedAtLabel: fetchedAtLabel,
      sourceLabel: fresh.size > 0 ? next.source_as_of_label : null,
      quoteCount: fresh.size,
      quoteTotal: quoteTotal,
      fjOk: fjOk,
      fjError: fjOk ? null : fjError,
      weightsFresh: { stocks: allStocksFresh, crypto: allCryptoFresh },
      view: {
        staleSymbols: failures.map(function (f) { return f.symbol; }),
        rangeStaleSymbols: Array.from(rangeStale),
      },
    };
  }

  root.QuoteRefresh = {
    refreshQuotes: refreshQuotes,
    pctChange: pctChange,
    change5d: change5d,
    change30d: change30d,
    applyNorm: applyNorm,
    recomputeStocksSummary: recomputeStocksSummary,
    stockMarketState: stockMarketState,
    futureMarketState: futureMarketState,
    cmeTradeDate: cmeTradeDate,
    zurichLabel: zurichLabel,
    zurichStamp: zurichStamp,
    minusOneMonth: minusOneMonth,
    parseVendorMs: parseVendorMs,
    trustworthyMs: trustworthyMs,
    parseCnbcBars: parseCnbcBars,
    parseCoinbaseCandles: parseCoinbaseCandles,
    applyListedSymbol: applyListedSymbol,
    applyCrypto: applyCrypto,
    parseFjRss: parseFjRss,
    selectTopFj: selectTopFj,
    refreshHeadlines: refreshHeadlines,
    safeHttpUrl: safeHttpUrl,
    windowCloses: windowCloses,
    weekdayBars: weekdayBars,
    REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
