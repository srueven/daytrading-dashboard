#!/usr/bin/env python3
"""Build politics.json from Google News RSS, plus FinancialJuice if reachable.

One fetch per source. On failure the existing file is left untouched and
the process exits 0. The file is rewritten only when the selected headlines
change.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
OUT = Path(os.environ.get("POLITICS_OUT") or (ROOT / "politics.json"))
TZ = ZoneInfo("Europe/Zurich")
SOURCE = "Google News"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/128.0.0.0 Safari/537.36"
)
QUERY = (
    '(Trump OR "White House" OR tariff OR tariffs OR "trade deal" OR sanctions '
    'OR China OR Iran OR Ukraine OR Russia OR OPEC OR "Federal Reserve" '
    'OR "Fed chair" OR "Fed independence" OR "government shutdown" OR Bessent OR Treasury) '
    "when:1d"
)
GOOGLE_URL = os.environ.get(
    "POLITICS_GOOGLE_URL",
    "https://news.google.com/rss/search?q="
    + urllib.parse.quote(QUERY)
    + "&hl=en-US&gl=US&ceid=US:en",
)
FJ_URL = os.environ.get("POLITICS_FJ_URL", "https://www.financialjuice.com/feed.ashx?xy=rss")

# First match wins. Specific market themes come before generic Trump.
TOPIC_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("Fed", ("fed independence", "fed chair", "federal reserve", "fomc", "powell")),
    ("Öl", ("opec", "crude oil", "oil price", "oil prices", "brent")),
    ("Zölle", ("tariff", "tariffs", "trade deal", "trade war")),
    ("Sanktionen", ("sanction",)),
    ("Iran", ("iran",)),
    ("China", ("china", "beijing", "xi jinping", "xi ")),
    ("Ukraine", ("ukraine", "zelensky", "putin", "russia")),
    ("Shutdown", ("government shutdown", "shutdown")),
    ("Treasury", ("bessent", "treasury")),
    ("Krypto", ("bitcoin", "btc", "xrp", "crypto")),
    ("Weißes Haus", ("white house", "trump")),
]
MARKET_WORDS = ("nasdaq", "s&p", "futures", "stocks", "gold", "oil", "bitcoin", "xrp", "yields", "dollar")


def zurich_label(dt: datetime) -> str:
    z = dt.astimezone(TZ)
    name = {"CET": "MEZ", "CEST": "MESZ"}.get(z.tzname() or "", z.tzname() or "")
    return z.strftime("%d.%m.%Y, %H:%M") + (f" {name}" if name else "")


def decode_xml(text: str) -> str:
    text = re.sub(r"<!\[CDATA\[(.*?)\]\]>", r"\1", text, flags=re.S)
    return (
        text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&apos;", "'")
    )


def xml_tag(block: str, name: str) -> str:
    match = re.search(rf"<{name}[^>]*>(.*?)</{name}>", block, re.S | re.I)
    if not match:
        return ""
    return decode_xml(re.sub(r"<[^>]+>", "", match.group(1))).strip()


def kw_match(low: str, kw: str) -> bool:
    key = kw.strip().lower()
    if not key:
        return False
    return re.search(r"(?<![a-z0-9])" + re.escape(key) + r"(?![a-z0-9])", low) is not None


def topic_of(title: str) -> str:
    low = f" {title.lower()} "
    for topic, keys in TOPIC_RULES:
        for key in keys:
            if kw_match(low, key):
                return topic
    return ""


def parse_pubdate(value: str) -> datetime | None:
    if not value:
        return None
    try:
        dt = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        try:
            dt = datetime.fromisoformat(value)
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def safe_url(url: str) -> str:
    try:
        parsed = urllib.parse.urlparse(url.strip())
    except ValueError:
        return ""
    if parsed.scheme in ("http", "https") and parsed.netloc:
        return url.strip()
    return ""


def strip_source_suffix(title: str, source: str) -> str:
    title = re.sub(r"\s+", " ", title).strip()
    if source and title.lower().endswith(" - " + source.lower()):
        return title[: -(len(source) + 3)].strip()
    return title


def parse_google(xml_text: str) -> list[dict]:
    items = []
    for block in re.findall(r"<item>(.*?)</item>", xml_text, re.S | re.I):
        title = xml_tag(block, "title")
        source_match = re.search(r"<source\b[^>]*>(.*?)</source>", block, re.S | re.I)
        source = decode_xml(re.sub(r"<[^>]+>", "", source_match.group(1))).strip() if source_match else "Google News"
        link = xml_tag(block, "link")
        published = parse_pubdate(xml_tag(block, "pubDate"))
        title = strip_source_suffix(title, source)
        url = safe_url(link)
        if title and url and published:
            items.append({
                "title": title,
                "source": source or "Google News",
                "url": url,
                "published": published,
                "origin": "Google News",
            })
    return items


def parse_fj(xml_text: str) -> list[dict]:
    items = []
    for block in re.findall(r"<item>(.*?)</item>", xml_text, re.S | re.I):
        title = xml_tag(block, "title")
        if title.startswith("FinancialJuice: "):
            title = title[len("FinancialJuice: "):].strip()
        title = re.sub(r"\s+", " ", title).strip()
        url = safe_url(xml_tag(block, "link")) or "https://www.financialjuice.com/home"
        published = parse_pubdate(xml_tag(block, "pubDate"))
        if title and published:
            items.append({
                "title": title,
                "source": "FinancialJuice",
                "url": url,
                "published": published,
                "origin": "FinancialJuice",
            })
    return items


def score_item(item: dict, now: datetime) -> float:
    low = f" {item['title'].lower()} "
    score = 0.0
    for _topic, keys in TOPIC_RULES:
        for key in keys:
            if kw_match(low, key):
                score += 8
    for word in MARKET_WORDS:
        if kw_match(low, word):
            score += 6
    age_h = (now - item["published"]).total_seconds() / 3600.0
    if age_h < 0:
        age_h = 0
    score += max(0.0, 24.0 - age_h)
    return score


def norm_key(title: str) -> str:
    return re.sub(r"\W+", "", title.lower())[:48]


def near_dup(item: dict, selected: list[dict]) -> bool:
    key = norm_key(item["title"])
    if not key:
        return False
    for other in selected:
        other_key = norm_key(other["title"])
        if key == other_key or key in other_key or other_key in key:
            return True
    return False


def select_items(items: list[dict], now: datetime, limit: int = 5) -> list[dict]:
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    now = now.astimezone(timezone.utc)
    cutoff = now - timedelta(hours=24)
    pool = []
    for item in items:
        published = item.get("published")
        if not isinstance(published, datetime):
            continue
        if published.tzinfo is None:
            published = published.replace(tzinfo=timezone.utc)
            item = dict(item, published=published)
        if published < cutoff or published > now + timedelta(minutes=5):
            continue
        topic = topic_of(item["title"])
        if not topic:
            continue
        pool.append(dict(item, topic=topic, published=published))
    ranked = sorted(pool, key=lambda it: score_item(it, now), reverse=True)
    selected: list[dict] = []
    topics: set[str] = set()

    def try_add(item: dict, allow_topic_dup: bool) -> bool:
        if near_dup(item, selected):
            return False
        if not allow_topic_dup and item["topic"] in topics:
            return False
        selected.append(item)
        topics.add(item["topic"])
        return True

    for item in ranked:
        if len(selected) >= limit:
            break
        try_add(item, False)
    if len(selected) < limit:
        for item in ranked:
            if len(selected) >= limit:
                break
            if item in selected:
                continue
            try_add(item, True)
    selected.sort(key=lambda it: it["published"], reverse=True)
    return selected[:limit]


def to_record(item: dict) -> dict:
    return {
        "title": item["title"],
        "source": item["source"],
        "url": item["url"],
        "published_zurich": zurich_label(item["published"]),
        "topic": item["topic"],
    }


def build_payload(items: list[dict], now: datetime) -> dict:
    if now.tzinfo is None:
        now = now.replace(tzinfo=TZ)
    now_z = now.astimezone(TZ)
    chosen = [to_record(item) for item in select_items(items, now_z)]
    return {
        "generated_at": now_z.isoformat(timespec="seconds"),
        "generated_at_label": zurich_label(now_z),
        "timezone": "Europe/Zurich",
        "source": SOURCE,
        "source_url": "https://news.google.com/rss/search",
        "items": chosen,
    }


def fetch_text(url: str) -> str:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, */*"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", "replace")


def write_if_changed(payload: dict) -> bool:
    new_items = payload.get("items") or []
    if not new_items:
        print("no politics items selected; keeping existing politics.json")
        return False
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            old = None
        if isinstance(old, dict) and (old.get("items") or []) == new_items:
            print("politics items unchanged")
            return False
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT.name} items={len(new_items)} at {payload['generated_at_label']}")
    return True


def load_items(now: datetime) -> list[dict]:
    fixture = os.environ.get("POLITICS_FIXTURE")
    if fixture:
        raw = json.loads(Path(fixture).read_text(encoding="utf-8"))
        items = []
        for row in raw:
            published = row.get("published")
            if isinstance(published, str):
                published = parse_pubdate(published) or datetime.fromisoformat(published)
            items.append({
                "title": row["title"],
                "source": row.get("source") or "Google News",
                "url": row["url"],
                "published": published,
                "origin": row.get("origin") or "Google News",
            })
        return items
    google_xml = fetch_text(GOOGLE_URL)
    if "<item>" not in google_xml.lower():
        raise ValueError("Google News RSS has no items")
    items = parse_google(google_xml)
    try:
        fj_xml = fetch_text(FJ_URL)
        if "<item>" in fj_xml.lower() and "error code: 1015" not in fj_xml:
            items.extend(parse_fj(fj_xml))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        print(f"WARN FinancialJuice politics fetch skipped: {exc}", file=sys.stderr)
    return items


def resolve_now() -> datetime:
    raw = os.environ.get("POLITICS_NOW")
    if not raw:
        return datetime.now(TZ)
    dt = datetime.fromisoformat(raw)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ)
    return dt


def main() -> int:
    now = resolve_now()
    try:
        items = load_items(now)
    except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError, OSError) as exc:
        print(f"WARN politics fetch failed: {exc}", file=sys.stderr)
        print("keeping existing politics.json")
        return 0
    write_if_changed(build_payload(items, now))
    return 0


if __name__ == "__main__":
    sys.exit(main())
