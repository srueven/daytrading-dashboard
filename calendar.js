/* Group a committed Forex Factory snapshot for the Kalender section.
 * No network, no polling, no holdings.
 */
(function (root) {
  "use strict";

  function zurichParts(date) {
    var fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Zurich",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    var map = {};
    fmt.formatToParts(date).forEach(function (part) {
      map[part.type] = part.value;
    });
    return {
      date: map.year + "-" + map.month + "-" + map.day,
      minutes: (Number(map.hour) % 24) * 60 + Number(map.minute),
    };
  }

  function addDays(ymd, days) {
    var p = ymd.split("-").map(Number);
    var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
    return dt.toISOString().slice(0, 10);
  }

  function dayLabel(date, today) {
    if (date === today) return "Heute";
    if (date === addDays(today, 1)) return "Morgen";
    var bits = date.split("-");
    return bits[2] + "." + bits[1] + "." + bits[0];
  }

  function prepare(payload, now) {
    var clock = zurichParts(now instanceof Date ? now : new Date());
    var events = (payload && payload.events) || [];
    var groups = [];
    var index = {};
    events.forEach(function (event) {
      if (!event || !event.date) return;
      var label = dayLabel(event.date, clock.date);
      if (!index[event.date]) {
        index[event.date] = { date: event.date, label: label, items: [] };
        groups.push(index[event.date]);
      }
      var past = false;
      if (event.date === clock.date && event.impact_de !== "feiertag") {
        var hm = String(event.time || "00:00").split(":");
        var mins = Number(hm[0]) * 60 + Number(hm[1] || 0);
        past = mins < clock.minutes;
      }
      index[event.date].items.push({
        time: event.time || "",
        title: event.title || "",
        country: event.country || "",
        impact: event.impact_de || "",
        forecast: event.forecast || "",
        previous: event.previous || "",
        past: past,
      });
    });
    var stand = (payload && (payload.generated_at_label || payload.generated_at)) || "";
    var source = (payload && payload.source) || "Forex Factory";
    return {
      groups: groups,
      stale: false,
      statusText: stand ? ("Stand: " + stand + " · " + source) : source,
    };
  }

  function prepareFallback(data) {
    var when = (data && (data.updated_at_label || data.updated_at)) || "";
    var items = ((data && data.calendar) || []).map(function (item) {
      return {
        time: item.time_cest || item.time || "",
        title: item.event || item.title || "",
        country: "",
        impact: item.impact || "",
        forecast: "",
        previous: "",
        past: false,
        legacy: true,
      };
    });
    return {
      groups: items.length ? [{ date: "", label: "", items: items }] : [],
      stale: true,
      statusText: "Alter Kalender · Stand " + (when || "unbekannt"),
    };
  }

  root.CalendarView = {
    prepare: prepare,
    prepareFallback: prepareFallback,
    dayLabel: dayLabel,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
