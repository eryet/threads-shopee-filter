// Runs in the page's MAIN world (configured in manifest.json) so it can wrap
// the page's native fetch/XHR. When Threads' own API responses contain a
// Shopee URL, dispatch a CustomEvent that the ISOLATED-world content script
// listens for. This lets us mark posts without doing our own HTTP requests.
(() => {
  const SHOPEE_FAST_RE =
    /shopee\.(?:tw|com|com\.my|ph|co\.id|sg|vn|co\.th|com\.br)|shp\.ee|s\.shopee\.[a-z.]+/i;

  // Only forward responses whose URL looks like a Threads API call.
  const API_URL_RE = /\/(graphql|api)\//i;

  const MAX_DISPATCH_BYTES = 1_500_000; // 1.5 MB safety ceiling on payload

  function shouldHandle(url) {
    return typeof url === "string" && API_URL_RE.test(url);
  }

  function dispatch(url, text) {
    if (!text || text.length > MAX_DISPATCH_BYTES) return;
    if (!SHOPEE_FAST_RE.test(text)) return;
    try {
      window.dispatchEvent(
        new CustomEvent("tsf:graphql", {
          detail: { url, body: text, ts: Date.now() },
        })
      );
    } catch (_) {}
  }

  // ----- fetch hook ----------------------------------------------------------
  const origFetch = window.fetch;
  if (origFetch && !origFetch.__tsfHooked) {
    const hooked = async function tsfFetch(...args) {
      const res = await origFetch.apply(this, args);
      try {
        let url;
        const first = args[0];
        if (typeof first === "string") url = first;
        else if (first && typeof first.url === "string") url = first.url;
        if (shouldHandle(url)) {
          // Clone so we don't consume the body the app needs.
          res
            .clone()
            .text()
            .then((text) => dispatch(url, text))
            .catch(() => {});
        }
      } catch (_) {}
      return res;
    };
    hooked.__tsfHooked = true;
    window.fetch = hooked;
  }

  // ----- XHR hook ------------------------------------------------------------
  const XHRProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHRProto && !XHRProto.__tsfHooked) {
    const origOpen = XHRProto.open;
    const origSend = XHRProto.send;
    XHRProto.open = function tsfOpen(method, url, ...rest) {
      try { this.__tsfUrl = url; } catch (_) {}
      return origOpen.apply(this, [method, url, ...rest]);
    };
    XHRProto.send = function tsfSend(...sendArgs) {
      try {
        this.addEventListener("load", () => {
          try {
            const url = this.__tsfUrl;
            if (!shouldHandle(url)) return;
            // responseType '' or 'text' gives us responseText; otherwise skip.
            if (this.responseType && this.responseType !== "text") return;
            dispatch(url, this.responseText);
          } catch (_) {}
        });
      } catch (_) {}
      return origSend.apply(this, sendArgs);
    };
    XHRProto.__tsfHooked = true;
  }

  // Signal to the content script that the hook installed successfully.
  try {
    window.dispatchEvent(new CustomEvent("tsf:injected-ready", { detail: { ts: Date.now() } }));
  } catch (_) {}
})();
