#!/usr/bin/env python3
"""Build calendar.json from the Forex Factory weekly feed.

One HTTP fetch per run. On failure the existing file is left untouched
and the process exits 0. The file is rewritten only when the selected
events change, so a later generated_at does not create an empty commit.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
OUT = Path(os.environ.get("CALENDAR_OUT") or (ROOT / "calendar.json"))
FEED_URL = os.environ.get(
    "CALENDAR_URL",
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
)
TZ = ZoneInfo("Europe/Zurich")
SOURCE = "Forex Factory · ff_calendar_thisweek.json"
HIGH_COUNTRIES = ("EUR", "GBP", "CNY", "JPY")
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/128.0.0.0 Safari/537.36"
)


def zurich_label(dt: datetime) -> str:
    z = dt.astimezone(TZ)
    name = {"CET": "MEZ", "CEST": "MESZ"}.get(z.tzname() or "", z.tzname() or "")
    return z.strftime("%d.%m.%Y, %H:%M") + (f" {name}" if name else "")


def impact_de(impact: str, title: str) -> str:
    low = (impact or "").strip().lower()
    if low == "high":
        return "hoch"
    if low == "medium":
        return "mittel"
    if low == "holiday" or "holiday" in (title or "").lower():
        return "feiertag"
    return low or ""


def is_usd_holiday(event: dict) -> bool:
    title = (event.get("title") or "").lower()
    impact = (event.get("impact") or "").strip().lower()
    return event.get("country") == "USD" and (impact == "holiday" or "holiday" in title)


def keep_event(event: dict) -> bool:
    country = event.get("country") or ""
    impact = (event.get("impact") or "").strip()
    if is_usd_holiday(event):
        return True
    if country == "USD" and impact in ("High", "Medium"):
        return True
    if country in HIGH_COUNTRIES and impact == "High":
        return True
    return False


def parse_when(value: str) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ZoneInfo("America/New_York"))
    return dt


def blank(value) -> str:
    return str(value or "").strip()


def build_payload(feed: list, now: datetime) -> dict:
    if now.tzinfo is None:
        now = now.replace(tzinfo=TZ)
    now_z = now.astimezone(TZ)
    window = {now_z.date(), now_z.date() + timedelta(days=1)}
    events = []
    for raw in feed or []:
        if not isinstance(raw, dict) or not keep_event(raw):
            continue
        when = parse_when(raw.get("date") or "")
        if when is None:
            continue
        local = when.astimezone(TZ)
        if local.date() not in window:
            continue
        title = blank(raw.get("title"))
        if not title:
            continue
        item = {
            "date": local.date().isoformat(),
            "time": local.strftime("%H:%M"),
            "time_zurich": local.isoformat(timespec="seconds"),
            "title": title,
            "country": raw.get("country") or "",
            "impact": raw.get("impact") or "",
            "impact_de": impact_de(raw.get("impact") or "", title),
        }
        forecast = blank(raw.get("forecast"))
        previous = blank(raw.get("previous"))
        if forecast:
            item["forecast"] = forecast
        if previous:
            item["previous"] = previous
        events.append(item)
    events.sort(key=lambda e: e["time_zurich"])
    return {
        "generated_at": now_z.isoformat(timespec="seconds"),
        "generated_at_label": zurich_label(now_z),
        "timezone": "Europe/Zurich",
        "source": SOURCE,
        "source_url": "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
        "events": events,
    }


def fetch_feed() -> list:
    """Single GET. Callers must not retry."""
    req = urllib.request.Request(
        FEED_URL,
        headers={"User-Agent": UA, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if not isinstance(payload, list):
        raise ValueError("calendar feed is not a list")
    return payload


def write_if_changed(payload: dict) -> bool:
    new_events = payload.get("events") or []
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            old = None
        if isinstance(old, dict) and (old.get("events") or []) == new_events:
            print("calendar events unchanged")
            return False
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT.name} events={len(new_events)} at {payload['generated_at_label']}")
    return True


def resolve_now() -> datetime:
    raw = os.environ.get("CALENDAR_NOW")
    if not raw:
        return datetime.now(TZ)
    dt = datetime.fromisoformat(raw)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ)
    return dt


def main() -> int:
    now = resolve_now()
    fixture = os.environ.get("CALENDAR_FIXTURE")
    try:
        if fixture:
            feed = json.loads(Path(fixture).read_text(encoding="utf-8"))
            if not isinstance(feed, list):
                raise ValueError("fixture is not a list")
        else:
            feed = fetch_feed()
    except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError, OSError) as exc:
        print(f"WARN calendar fetch failed: {exc}", file=sys.stderr)
        print("keeping existing calendar.json")
        return 0
    write_if_changed(build_payload(feed, now))
    return 0


if __name__ == "__main__":
    sys.exit(main())
