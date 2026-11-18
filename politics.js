/* Prepare politics.json headlines for the Politik section.
 * No network and no holdings.
 */
(function (root) {
  "use strict";

  function clockOf(label) {
    var match = String(label || "").match(/(\d{2})\.(\d{2})\.\d{4}, (\d{2}:\d{2})/);
    if (match) return match[1] + "." + match[2] + ". " + match[3];
    var time = String(label || "").match(/(\d{2}:\d{2})/);
    return time ? time[1] : "";
  }

  function prepare(payload) {
    var items = ((payload && payload.items) || []).map(function (item) {
      return {
        title: item.title || "",
        source: item.source || "",
        url: item.url || "",
        time: clockOf(item.published_zurich),
        topic: item.topic || "",
      };
    }).filter(function (item) { return item.title && item.url; });
    var stand = (payload && (payload.generated_at_label || payload.generated_at)) || "";
    var source = (payload && payload.source) || "Google News";
    return {
      items: items,
      stale: false,
      statusText: stand ? ("Stand: " + stand + " · " + source) : source,
    };
  }

  function prepareFallback(data) {
    var when = (data && (data.updated_at_label || data.updated_at)) || "";
    var items = ((data && data.politics) || []).map(function (item) {
      var title = typeof item === "string" ? item : (item.text || item.title || "");
      var url = (item && typeof item === "object" && item.url)
        ? item.url
        : ("https://news.google.com/search?q=" + encodeURIComponent(title) + "&hl=de&gl=CH&ceid=CH:de");
      return { title: title, source: "", url: url, time: "", topic: "", legacy: true };
    }).filter(function (item) { return item.title; });
    return {
      items: items,
      stale: true,
      statusText: "Alte Politik-Liste · Stand " + (when || "unbekannt"),
    };
  }

  root.PoliticsView = {
    prepare: prepare,
    prepareFallback: prepareFallback,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
