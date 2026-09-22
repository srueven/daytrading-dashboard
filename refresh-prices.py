#!/usr/bin/env python3
"""Refresh futures/stocks/crypto prices from Yahoo Finance chart API
and FinancialJuice headlines (RSS) into data.json + embedded index.html.

Updates price fields and financialjuice Top-5. Does not invent numbers —
exits non-zero only if every price fetch fails (FJ failure is non-fatal).
"""
from __future__ import annotations

import html as html_lib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
INDEX = ROOT / "index.html"
DATA_JSON = ROOT / "data.json"
TZ = ZoneInfo("Europe/Zurich")
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/128.0.0.0 Safari/537.36"
)
CHART_TMPL = (
    "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    "?range=1mo&interval=1d&includePrePost=true"
)
SECTIONS = ("futures", "stocks", "crypto")

FJ_RSS_URL = "https://www.financialjuice.com/feed.ashx?xy=rss"
FJ_TITLE_PREFIX = "FinancialJuice: "
FJ_NOTE = "Top 5 · letzte ~24h · auto alle 15 Min"
FJ_DEFAULT_URL = "https://www.financialjuice.com/home"

def _kw_match(low: str, kw: str) -> bool:
    """Case-folded keyword match with word-ish boundaries (avoids ripple⊂crippled)."""
    k = kw.strip().lower()
    if not k:
        return False
    # Allow flexible non-alnum edges; keep internal spaces/apostrophes
    return re.search(r"(?<![a-z0-9])" + re.escape(k) + r"(?![a-z0-9])", low) is not None


# Keyword weights for daytrading focus (MNQ/NQ, ES, Gold, Oil, XRP/BTC).
# Longer / more specific phrases first within each group when matching.
FJ_KEYWORDS: list[tuple[str, int]] = [
    # Fed / US rates / labor / inflation
    ("federal reserve", 12),
    ("fomc", 12),
    ("powell", 11),
    ("jefferson", 9),
    ("williams", 9),
    ("barkin", 8),
    ("fed ", 10),
    ("fed's", 10),
    ("fed:", 10),
    ("interest rate", 10),
    ("rate cut", 10),
    ("rate hike", 10),
    ("rates", 7),
    ("treasury", 8),
    ("yields", 8),
    ("10-year", 7),
    ("10y", 7),
    ("cpi", 11),
    ("pce", 10),
    ("inflation", 9),
    ("nfp", 11),
    ("nonfarm", 11),
    ("payroll", 9),
    ("adp", 10),
    ("unemployment", 8),
    ("jobless", 7),
    # Equities / indices
    ("nasdaq", 10),
    ("s&p", 10),
    ("s&amp;p", 10),
    ("dow ", 7),
    ("mnq", 10),
    ("mes ", 8),
    ("futures", 5),
    ("equity", 5),
    ("stock market", 7),
    # Gold / oil / commodities
    ("opec", 11),
    ("crude", 10),
    ("brent", 9),
    ("wti", 9),
    ("oil", 9),
    ("gasoline", 6),
    ("gold", 10),
    ("xau", 8),
    ("silver", 6),
    ("commodity", 5),
    # Crypto
    ("bitcoin", 10),
    ("btc", 10),
    ("xrp", 10),
    ("ripple", 9),
    ("crypto", 8),
    ("ethereum", 6),
    # Macro / geopolitics that move markets
    ("ecb", 9),
    ("lagarde", 8),
    ("boj", 7),
    ("tariff", 10),
    ("section 301", 9),
    ("ustr", 8),
    ("china", 8),
    ("xi ", 8),
    ("beijing", 7),
    ("iran", 10),
    ("israel", 7),
    ("ukraine", 7),
    ("russia", 7),
    ("war", 8),
    ("sanctions", 8),
    ("geopolit", 8),
    ("venezuela", 7),
    ("greenland", 6),
    ("unga", 5),
    ("un general", 5),
    ("trump", 4),  # present often; diversification caps Trump soundbites
    ("white house", 5),
    ("gdp", 7),
    ("recession", 8),
    ("dollar", 6),
    ("dxy", 7),
]

# Topic buckets for diversification (first match wins).
FJ_TOPIC_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("fed_rates", ("fed", "fomc", "powell", "jefferson", "williams", "barkin",
                   "rate cut", "rate hike", "interest rate", "discount window",
                   "monetary policy", "treasury", "yield")),
    ("inflation_labor", ("cpi", "pce", "inflation", "nfp", "nonfarm", "payroll",
                         "adp", "unemployment", "jobless")),
    ("oil", ("oil", "opec", "crude", "brent", "wti", "gasoline", "petroleum")),
    ("gold", ("gold", "xau", "bullion")),
    ("crypto", ("bitcoin", "btc", "xrp", "ripple", "crypto", "ethereum")),
    ("equities", ("nasdaq", "s&p", "s&amp;p", "dow", "mnq", "mes", "stock market",
                  "equity", "futures")),
    ("china_trade", ("china", "xi ", "beijing", "tariff", "section 301", "ustr",
                     "trade war")),
    ("iran_geo", ("iran", "israel", "middle east")),
    ("russia_ukraine", ("russia", "ukraine", "putin", "zelensky")),
    ("ecb_eu", ("ecb", "lagarde", "eurozone", "eu envoys", "eu ")),
    ("trump_other", ("trump",)),
]


def load_data() -> dict:
    if DATA_JSON.exists():
        return json.loads(DATA_JSON.read_text(encoding="utf-8"))
    text = INDEX.read_text(encoding="utf-8")
    m = re.search(
        r'<script id="data" type="application/json">\s*(.*?)\s*</script>',
        text,
        re.DOTALL,
    )
    if not m:
        raise SystemExit("No data.json and no embedded #data JSON in index.html")
    return json.loads(m.group(1))


def write_data(data: dict) -> None:
    payload = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    DATA_JSON.write_text(payload, encoding="utf-8")
    text = INDEX.read_text(encoding="utf-8")
    new_text, n = re.subn(
        r'(<script id="data" type="application/json">\s*).*?(\s*</script>)',
        lambda m: m.group(1) + payload.rstrip("\n") + m.group(2),
        text,
        count=1,
        flags=re.DOTALL,
    )
    if n != 1:
        raise SystemExit("Failed to replace embedded JSON in index.html")
    INDEX.write_text(new_text, encoding="utf-8")


def http_get_json(url: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/json,text/plain,*/*",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_get_text(url: str, accept: str, *, retry_429: bool = True) -> str:
    """GET text body; on HTTP 429 sleep once and retry (FinancialJuice)."""
    headers = {
        "User-Agent": UA,
        "Accept": accept,
        "Accept-Language": "en-US,en;q=0.9",
    }
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        if exc.code == 429 and retry_429:
            sleep_s = 12
            print(
                f"WARN FinancialJuice HTTP 429 — retrying once after {sleep_s}s",
                file=sys.stderr,
            )
            time.sleep(sleep_s)
            return http_get_text(url, accept, retry_429=False)
        raise


def pct_change(new: float, old: float) -> float | None:
    if old is None or old == 0 or new is None:
        return None
    return round((new - old) / old * 100.0, 3)


def infer_market_state(meta: dict, now_ts: int) -> str:
    ctp = meta.get("currentTradingPeriod") or {}
    for name in ("pre", "regular", "post"):
        period = ctp.get(name) or {}
        start, end = period.get("start"), period.get("end")
        if start is None or end is None:
            continue
        # Futures/crypto often have degenerate pre/post (start==end)
        if start == end:
            continue
        if start <= now_ts < end:
            return {"pre": "PRE", "regular": "REGULAR", "post": "POST"}[name]
    # Fallback: if regular window contains now (including degenerate handled above)
    reg = ctp.get("regular") or {}
    if reg.get("start") is not None and reg.get("end") is not None:
        if reg["start"] <= now_ts < reg["end"]:
            return "REGULAR"
    return "CLOSED"


def fetch_quote(symbol: str) -> dict:
    enc = urllib.parse.quote(symbol, safe="")
    url = CHART_TMPL.format(symbol=enc)
    raw = http_get_json(url)
    result = (raw.get("chart") or {}).get("result") or []
    if not result:
        err = (raw.get("chart") or {}).get("error")
        raise RuntimeError(f"No chart result for {symbol}: {err}")
    block = result[0]
    meta = block.get("meta") or {}
    quote = ((block.get("indicators") or {}).get("quote") or [{}])[0]
    closes_raw = quote.get("close") or []
    closes = [float(c) for c in closes_raw if c is not None]

    price = meta.get("regularMarketPrice")
    if price is None and closes:
        price = closes[-1]
    if price is None:
        raise RuntimeError(f"No price for {symbol}")
    price = float(price)

    # Day change vs previous close
    change_pct = meta.get("regularMarketChangePercent")
    if change_pct is not None:
        change_pct = round(float(change_pct), 3)
    else:
        # If last bar is today's close (~price), prev is closes[-2]; else closes[-1]
        if len(closes) >= 2 and abs(closes[-1] - price) / max(abs(price), 1e-9) < 0.002:
            change_pct = pct_change(price, closes[-2])
        elif closes:
            change_pct = pct_change(price, closes[-1])
        else:
            change_pct = None

    # 5 trading days: closes[-6] when last bar is today, else closes[-5]
    change_5d_pct = None
    if len(closes) >= 6 and abs(closes[-1] - price) / max(abs(price), 1e-9) < 0.002:
        change_5d_pct = pct_change(price, closes[-6])
    elif len(closes) >= 5:
        change_5d_pct = pct_change(price, closes[-5])

    # ~30d / 1mo window: vs first available daily close in range
    change_30d_pct = pct_change(price, closes[0]) if closes else None

    now_ts = int(time.time())
    market_state = infer_market_state(meta, now_ts)
    market_open = market_state == "REGULAR"

    has_prepost = bool(meta.get("hasPrePostMarketData"))
    fullday = meta.get("fulldayPrice")
    fullday_pct = meta.get("fulldayChangePercent")

    premarket_pct = None
    show_premarket = False
    if has_prepost and market_state in ("PRE", "POST"):
        show_premarket = True
        if fullday_pct is not None:
            premarket_pct = round(float(fullday_pct), 3)
        elif fullday is not None:
            premarket_pct = pct_change(float(fullday), price)

    return {
        "price": price,
        "change_pct": change_pct,
        "change_5d_pct": change_5d_pct,
        "change_30d_pct": change_30d_pct,
        "market_state": market_state,
        "market_open": market_open,
        "premarket_pct": premarket_pct,
        "show_premarket": show_premarket,
    }


def avg(values: list[float | None]) -> float | None:
    nums = [v for v in values if v is not None]
    if not nums:
        return None
    return round(sum(nums) / len(nums), 3)


def recompute_stocks_summary(stocks: list[dict]) -> dict:
    return {
        "change_pct": avg([s.get("change_pct") for s in stocks]),
        "change_5d_pct": avg([s.get("change_5d_pct") for s in stocks]),
        "change_30d_pct": avg([s.get("change_30d_pct") for s in stocks]),
        "premarket_pct": avg([s.get("premarket_pct") for s in stocks]),
        "count": len(stocks),
        "label": "Stocks-Basket (gleichgewichtet)",
    }


def stamp_now() -> tuple[str, str]:
    now = datetime.now(TZ)
    updated_at = now.isoformat(timespec="seconds")
    tz_label = {"CEST": "MESZ", "CET": "MEZ"}.get(now.tzname() or "", now.tzname() or "")
    label = now.strftime("%d.%m.%Y, %H:%M") + (f" {tz_label}" if tz_label else "")
    return updated_at, label


def _xml_tag(block: str, name: str) -> str:
    m = re.search(rf"<{name}>(.*?)</{name}>", block, re.DOTALL | re.IGNORECASE)
    if not m:
        return ""
    return html_lib.unescape(m.group(1).strip())


def parse_fj_rss(xml_text: str) -> list[dict]:
    """Parse RSS items → {title, link, pubDate, dt}."""
    items: list[dict] = []
    for block in re.findall(r"<item>(.*?)</item>", xml_text, re.DOTALL | re.IGNORECASE):
        title = _xml_tag(block, "title")
        link = _xml_tag(block, "link")
        pub = _xml_tag(block, "pubDate")
        if not title:
            continue
        if title.startswith(FJ_TITLE_PREFIX):
            title = title[len(FJ_TITLE_PREFIX) :].strip()
        # Collapse whitespace / newlines from RSS
        title = re.sub(r"\s+", " ", title).strip()
        dt: datetime | None = None
        if pub:
            try:
                dt = parsedate_to_datetime(pub)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
            except (TypeError, ValueError, IndexError):
                dt = None
        items.append({"title": title, "link": link, "pubDate": pub, "dt": dt})
    return items


def fj_topic(title: str) -> str:
    low = title.lower()
    for topic, keys in FJ_TOPIC_RULES:
        for k in keys:
            if _kw_match(low, k):
                return topic
    return "other"


def fj_is_trump_soundbite(title: str) -> bool:
    """True for near-duplicate live Trump quote lines (not substantive news)."""
    t = title.strip()
    low = t.lower()
    if low.startswith("trump:"):
        return True
    if low.startswith("trump at un:") and len(t) < 80:
        return True
    return False


def score_fj_item(item: dict, now: datetime) -> float:
    title = item["title"]
    low = title.lower()
    score = 0.0
    for kw, w in FJ_KEYWORDS:
        if _kw_match(low, kw):
            score += w
    dt = item.get("dt")
    if dt is not None:
        age_h = (now - dt).total_seconds() / 3600.0
        if age_h <= 0:
            score += 15
        elif age_h <= 6:
            score += 12
        elif age_h <= 12:
            score += 9
        elif age_h <= 24:
            score += 6
        elif age_h <= 36:
            score += 2
        else:
            score -= 8  # prefer ~last 24h
    else:
        score -= 3
    # Soft penalty for raw Trump soundbites so substantive items can win
    if fj_is_trump_soundbite(title):
        score -= 6
    # Tiny length bump: very short "Trump: X." lines are weaker signal
    if len(title) < 40 and fj_is_trump_soundbite(title):
        score -= 3
    return score


def select_top_fj(items: list[dict], n: int = 5) -> list[dict]:
    """Score + diversify: max 1 Trump soundbite, prefer distinct topics."""
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=36)
    recent = [
        it
        for it in items
        if it.get("dt") is None or it["dt"] >= cutoff
    ]
    pool = recent if recent else list(items)

    ranked = sorted(pool, key=lambda it: score_fj_item(it, now), reverse=True)

    selected: list[dict] = []
    topics_used: set[str] = set()
    trump_count = 0

    def near_dup(it: dict) -> bool:
        key = re.sub(r"\W+", "", it["title"].lower())[:48]
        if not key:
            return False
        for s in selected:
            sk = re.sub(r"\W+", "", s["title"].lower())[:48]
            if key == sk or key in sk or sk in key:
                return True
        return False

    def try_add(it: dict, *, allow_topic_dup: bool) -> bool:
        nonlocal trump_count
        topic = fj_topic(it["title"])
        is_trump = fj_is_trump_soundbite(it["title"])
        if is_trump and trump_count >= 1:
            return False
        if not allow_topic_dup and topic in topics_used and topic != "other":
            return False
        if near_dup(it):
            return False
        selected.append(it)
        topics_used.add(topic)
        if is_trump:
            trump_count += 1
        return True

    # Pass 1: distinct topics only
    for it in ranked:
        if len(selected) >= n:
            break
        try_add(it, allow_topic_dup=False)

    # Pass 2: still prefer unused topics from a wider scan (score floor)
    if len(selected) < n:
        for it in ranked:
            if len(selected) >= n:
                break
            if it in selected:
                continue
            try_add(it, allow_topic_dup=False)

    # Pass 3: fill only if still short (allow topic dup; still cap Trump soundbites)
    if len(selected) < n:
        for it in ranked:
            if len(selected) >= n:
                break
            if it in selected:
                continue
            try_add(it, allow_topic_dup=True)

    # Chronological-ish for display: newest first among selected
    selected.sort(
        key=lambda it: it["dt"] or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )
    return selected[:n]


def fj_to_record(item: dict) -> dict:
    dt = item.get("dt")
    if dt is not None:
        time_str = dt.astimezone(TZ).strftime("%H:%M")
    else:
        time_str = "--:--"
    return {
        "time": time_str,
        "title": item["title"],
        "link": item.get("link") or FJ_DEFAULT_URL,
        "source": "FinancialJuice",
    }


def refresh_financialjuice(data: dict) -> tuple[int, list[str]]:
    """Fetch/select Top-5 FJ headlines. Returns (parsed_count, selected_titles).

    On failure: leave previous financialjuice intact and print a warning.
    Always refreshes note / url when possible.
    """
    data.setdefault("financialjuice_url", FJ_DEFAULT_URL)
    try:
        xml_text = http_get_text(
            FJ_RSS_URL,
            accept="application/rss+xml, application/xml, text/xml, */*",
        )
        if "error code: 1015" in xml_text or "<item>" not in xml_text.lower():
            raise RuntimeError("FinancialJuice RSS blocked or empty")
        items = parse_fj_rss(xml_text)
        if not items:
            raise RuntimeError("FinancialJuice RSS parsed 0 items")
        top = select_top_fj(items, n=5)
        data["financialjuice"] = [fj_to_record(it) for it in top]
        data["financialjuice_note"] = FJ_NOTE
        titles = [it["title"] for it in top]
        print(f"OK FinancialJuice: parsed={len(items)} selected={len(top)}")
        for i, t in enumerate(titles, 1):
            print(f"  FJ{i}: {t}")
        return len(items), titles
    except Exception as exc:  # noqa: BLE001 — non-fatal vs prices
        print(f"WARN FinancialJuice refresh failed: {exc}", file=sys.stderr)
        # Keep previous list; still nudge note toward auto cadence if present
        if "financialjuice_note" in data:
            data["financialjuice_note"] = FJ_NOTE
        return 0, []


def main() -> int:
    data = load_data()
    successes = 0
    failures: list[str] = []

    for section in SECTIONS:
        items = data.get(section) or []
        for item in items:
            sym = item.get("symbol")
            if not sym:
                continue
            try:
                q = fetch_quote(sym)
                # Only overwrite fields we actually fetched (no invention)
                for k, v in q.items():
                    if v is None and k in ("change_pct", "change_5d_pct", "change_30d_pct"):
                        failures.append(f"{sym}:{k}=None")
                        continue
                    item[k] = v
                successes += 1
                print(
                    f"OK {sym}: price={q['price']} chg={q['change_pct']} "
                    f"5d={q['change_5d_pct']} 30d={q['change_30d_pct']} "
                    f"state={q['market_state']} pre={q['premarket_pct']}"
                )
            except Exception as exc:  # noqa: BLE001 — collect and continue
                failures.append(f"{sym}: {exc}")
                print(f"FAIL {sym}: {exc}", file=sys.stderr)
            time.sleep(0.15)

    # FinancialJuice is secondary — never flip exit code by itself
    refresh_financialjuice(data)

    if successes == 0:
        print("Total failure: no symbols updated", file=sys.stderr)
        return 1

    stocks = data.get("stocks") or []
    if stocks:
        data["stocks_summary"] = recompute_stocks_summary(stocks)

    data["updated_at"], data["updated_at_label"] = stamp_now()
    write_data(data)

    print(
        f"Updated {successes} symbols at {data['updated_at_label']}"
        + (f" (failures: {len(failures)})" if failures else "")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
