(() => {
  const SHOPEE_HOST_RE =
    /(^|\.)shopee\.(tw|com|com\.my|ph|co\.id|sg|vn|co\.th|com\.br)$|(^|\.)shp\.ee$|(^|\.)s\.shopee\./i;
  const SHOPEE_TEXT_RE =
    /\b(shopee\.(?:tw|com|com\.my|ph|co\.id|sg|vn|co\.th|com\.br)|shp\.ee|s\.shopee\.[a-z.]+)\b/i;
  const SHOPEE_ANY_RE =
    /shopee\.(?:tw|com|com\.my|ph|co\.id|sg|vn|co\.th|com\.br)|shp\.ee|s\.shopee\.[a-z.]+/i;
  const PROCESSED_ATTR = "data-tsf-processed";
  const HIDDEN_ATTR = "data-tsf-hidden";
  const FEED_CHECKED_ATTR = "data-tsf-feed-checked";

  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const MAX_CACHE_SIZE = 5000;
  const CLEAN_RECHECK_MS = 5 * 60 * 1000; // re-evaluate clean GraphQL bodies after 5 min
  const PENDING_STALE_MS = 30_000;
  const DEFAULT_CONCURRENCY = 6;
  const MAX_CONCURRENCY = 10;
  const STREAM_CHECK_INTERVAL_BYTES = 65536; // re-evaluate every 64 KB while streaming
  const CACHE_KEY = "tsf_cache_v1";

  const state = {
    enabled: true,
    debug: true,
    dryRun: false,
    prefetch: true,
    looseMatch: true,
    concurrency: DEFAULT_CONCURRENCY,
    hiddenCount: 0,
    scanCount: 0,
    lastScanAt: null,
    lastScanFoundShopee: 0,
    lastScanMatched: 0,
    inlineCandidates: [],
    // prefetch state
    cache: new Map(), // shortcode -> { status: 'pending'|'clean'|'shopee', ts, permalink, author }
    queue: [],
    activeWorkers: 0,
    fetchedCount: 0,
    prefetchHits: 0,
    graphqlEvents: 0,
    graphqlHits: 0,
    graphqlReady: false,
    // Shortcodes the user has explicitly revealed via "Show anyway". Stays in memory
    // for the session — clears on page reload. Prevents any code path from re-marking
    // a post the user already chose to see.
    revealed: new Set(),
  };

  // ---- logging --------------------------------------------------------------
  function log(...args) {
    if (!state.debug) return;
    console.log("%c[TSF]", "color:#1f8a4c;font-weight:bold", ...args);
  }
  function group(label) {
    if (!state.debug) return { end: () => {} };
    console.groupCollapsed(
      `%c[TSF] ${label}`,
      "color:#1f8a4c;font-weight:bold",
    );
    return { end: () => console.groupEnd() };
  }
  function warn(...args) {
    console.warn("%c[TSF]", "color:#b46f00;font-weight:bold", ...args);
  }

  // True if we're on a permalink/thread-detail page (/@user/post/CODE). Filtering
  // is disabled there: the user explicitly clicked in to read it, and the
  // page bundles the whole thread into one document — which makes our heuristics
  // over-fire on every reply.
  function isThreadDetailPage() {
    return /^\/@[A-Za-z0-9._]+\/post\/[A-Za-z0-9_-]+/.test(location.pathname);
  }

  function clampConcurrency(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_CONCURRENCY;
    return Math.min(Math.max(1, Math.floor(n)), MAX_CONCURRENCY);
  }

  // ---- storage --------------------------------------------------------------
  chrome.storage.sync.get(
    {
      enabled: true,
      debug: true,
      dryRun: false,
      prefetch: true,
      looseMatch: true,
      concurrency: DEFAULT_CONCURRENCY,
    },
    (v) => {
      state.enabled = v.enabled !== false;
      state.debug = v.debug !== false;
      state.dryRun = !!v.dryRun;
      state.prefetch = v.prefetch !== false;
      state.looseMatch = v.looseMatch !== false;
      state.concurrency = clampConcurrency(v.concurrency);
      log("loaded settings", {
        enabled: state.enabled,
        debug: state.debug,
        dryRun: state.dryRun,
        prefetch: state.prefetch,
        looseMatch: state.looseMatch,
        concurrency: state.concurrency,
        url: location.href,
      });
      loadCacheFromStorage().then(() => scanSoon());
    },
  );

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      state.enabled = changes.enabled.newValue !== false;
      log("enabled ->", state.enabled);
      if (!state.enabled) clearAllMarkers();
      else scanSoon();
    }
    if (changes.debug) {
      state.debug = changes.debug.newValue !== false;
      console.log(
        "%c[TSF]",
        "color:#1f8a4c;font-weight:bold",
        "debug ->",
        state.debug,
      );
    }
    if (changes.dryRun) {
      state.dryRun = !!changes.dryRun.newValue;
      log("dryRun ->", state.dryRun);
      if (state.dryRun) clearAllMarkers();
      else scanSoon();
    }
    if (changes.prefetch) {
      state.prefetch = changes.prefetch.newValue !== false;
      log("prefetch ->", state.prefetch);
      if (state.prefetch) scanSoon();
    }
    if (changes.concurrency) {
      state.concurrency = clampConcurrency(changes.concurrency.newValue);
      log("concurrency ->", state.concurrency);
      pump(); // start more workers if we just raised the cap
    }
    if (changes.looseMatch) {
      state.looseMatch = !!changes.looseMatch.newValue;
      log("looseMatch ->", state.looseMatch);
      // Re-scan so cached "clean" entries get re-evaluated under new rules
      state.cache.clear();
      chrome.storage.local.remove(CACHE_KEY);
      document
        .querySelectorAll(`[${FEED_CHECKED_ATTR}]`)
        .forEach((el) => el.removeAttribute(FEED_CHECKED_ATTR));
      scanSoon();
    }
  });

  // Write to state.cache with bounded size + LRU eviction. Map preserves insertion
  // order, so re-inserting on update moves an entry to the most-recent slot, and
  // overflow evicts via keys().next() which is the oldest insertion.
  function setCache(shortcode, entry) {
    if (state.cache.has(shortcode)) state.cache.delete(shortcode);
    state.cache.set(shortcode, entry);
    while (state.cache.size > MAX_CACHE_SIZE) {
      const oldestKey = state.cache.keys().next().value;
      if (oldestKey === undefined) break;
      state.cache.delete(oldestKey);
    }
  }

  async function loadCacheFromStorage() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ [CACHE_KEY]: {} }, (v) => {
        const raw = v[CACHE_KEY] || {};
        const now = Date.now();
        let kept = 0,
          dropped = 0;
        for (const [k, entry] of Object.entries(raw)) {
          if (!entry || typeof entry !== "object") continue;
          if (entry.status === "pending") {
            dropped++;
            continue;
          }
          if (now - (entry.ts || 0) > CACHE_TTL_MS) {
            dropped++;
            continue;
          }
          setCache(k, entry);
          kept++;
        }
        log(
          `cache loaded: kept ${kept}, dropped ${dropped}, size ${state.cache.size}`,
        );
        resolve();
      });
    });
  }

  let persistTimer = null;
  function persistCacheDebounced() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const out = {};
      for (const [k, v] of state.cache.entries()) {
        if (v.status === "pending") continue;
        out[k] = v;
      }
      chrome.storage.local.set({ [CACHE_KEY]: out });
    }, 1000);
  }

  // ---- messaging from popup -------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "tsf:getStats") {
      sendResponse({
        hiddenCount: state.hiddenCount,
        scanCount: state.scanCount,
        lastScanFoundShopee: state.lastScanFoundShopee,
        lastScanMatched: state.lastScanMatched,
        fetchedCount: state.fetchedCount,
        prefetchHits: state.prefetchHits,
        queueLength: state.queue.length,
        cacheSize: state.cache.size,
        graphqlEvents: state.graphqlEvents,
        graphqlHits: state.graphqlHits,
        graphqlReady: state.graphqlReady,
      });
    } else if (msg && msg.type === "tsf:revealAll") {
      revealAll();
      sendResponse({ ok: true });
    } else if (msg && msg.type === "tsf:rescan") {
      forceRescan();
      sendResponse({ ok: true });
    } else if (msg && msg.type === "tsf:clearCache") {
      state.cache.clear();
      chrome.storage.local.remove(CACHE_KEY);
      log("cache cleared");
      sendResponse({ ok: true });
    }
    return true;
  });

  // ---- detection helpers ----------------------------------------------------
  function isShopeeUrl(href) {
    if (!href) return false;
    try {
      const u = new URL(href, location.origin);
      return SHOPEE_HOST_RE.test(u.hostname);
    } catch {
      return SHOPEE_TEXT_RE.test(href);
    }
  }

  function getAuthorHandleFromLink(a) {
    if (!a) return null;
    const href = a.getAttribute("href") || "";
    const m = href.match(/^\/@([A-Za-z0-9._]+)(?:\/|$|\?)/);
    return m ? m[1].toLowerCase() : null;
  }

  function findPostContainer(node) {
    let el = node instanceof Element ? node : node.parentElement;
    let candidate = null;
    while (el && el !== document.body) {
      if (el.matches?.('[data-pressable-container="true"]')) {
        candidate = el;
      }
      el = el.parentElement;
    }
    if (candidate) return candidate;
    return (
      (node instanceof Element ? node : node.parentElement)?.closest?.(
        'div[role="article"], article',
      ) ?? null
    );
  }

  function findReplyContainer(node) {
    let el = node instanceof Element ? node : node.parentElement;
    while (el && el !== document.body) {
      if (el.matches?.('[data-pressable-container="true"]')) return el;
      el = el.parentElement;
    }
    return (
      (node instanceof Element ? node : node.parentElement)?.closest?.(
        'div[role="article"], article',
      ) ?? null
    );
  }

  function getContainerAuthor(container) {
    if (!container) return null;
    const links = container.querySelectorAll('a[href^="/@"]');
    for (const a of links) {
      const handle = getAuthorHandleFromLink(a);
      if (handle) return handle;
    }
    return null;
  }

  // Read the post's age from <time datetime="..."> if present. Returns ms since posted,
  // or null if unknown. Used to bias the prefetch queue toward fresh posts (where the
  // self-reply spam pattern is most likely to appear).
  function getPostAgeMs(post) {
    if (!post) return null;
    const timeEl = post.querySelector("time[datetime]");
    if (!timeEl) return null;
    const t = Date.parse(timeEl.getAttribute("datetime"));
    if (Number.isNaN(t)) return null;
    return Date.now() - t;
  }

  function getPermalinkFromContainer(container) {
    if (!container) return null;
    const a = container.querySelector('a[href*="/post/"]');
    if (!a) return null;
    const href = a.getAttribute("href") || "";
    const m = href.match(/^\/@([A-Za-z0-9._]+)\/post\/([A-Za-z0-9_-]+)/);
    if (!m) return null;
    return {
      permalink: `/@${m[1]}/post/${m[2]}`,
      author: m[1].toLowerCase(),
      shortcode: m[2],
    };
  }

  function shortLabel(el) {
    if (!el) return "null";
    const tag = el.tagName?.toLowerCase() ?? "?";
    const id = el.id ? `#${el.id}` : "";
    const cls =
      el.className && typeof el.className === "string"
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
        : "";
    const text = (el.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
    return `${tag}${id}${cls} «${text}${text.length === 40 ? "…" : ""}»`;
  }

  // Marker icon: just emoji. Spray puff next to a belly-up cockroach
  // (rotated 180° via CSS). Static, no animation.
  const MARKER_ICON = `<span class="tsf-emoji-spray" aria-hidden="true">💨</span><span class="tsf-emoji-roach" aria-hidden="true">🪳</span>`;

  function markPost(
    post,
    reason,
    kind /* 'strong' | 'mention' | 'loose' | 'inline' */,
  ) {
    if (!post) return;

    // Single point of truth: if the user has already revealed this post, never re-mark.
    // All callers used to check state.revealed individually; consolidating here means
    // a future caller can't forget the check.
    const info = getPermalinkFromContainer(post);
    if (info?.shortcode && state.revealed.has(info.shortcode)) return;

    if (state.dryRun) {
      if (post.getAttribute(HIDDEN_ATTR)) return;
      log("WOULD mark (dryRun)", { reason, kind, post: shortLabel(post) });
      post.setAttribute(HIDDEN_ATTR, "dry");
      post.style.outline = "2px dashed #b46f00";
      post.style.outlineOffset = "-2px";
      state.hiddenCount += 1;
      return;
    }

    // If marker already present and still attached, nothing to do.
    if (post.querySelector(":scope > .tsf-marker")) return;

    post.setAttribute(HIDDEN_ATTR, "1");
    post.classList.add("tsf-marked");
    if (kind) post.setAttribute("data-tsf-kind", kind);

    const marker = document.createElement("div");
    marker.className =
      "tsf-marker" + (kind === "loose" ? " tsf-marker-loose" : "");
    const title =
      kind === "loose"
        ? "疑似分潤蟑螂（寬鬆比對）"
        : "已噴除一隻分潤蟑螂";
    marker.innerHTML = `
      <div class="tsf-marker-icon" aria-hidden="true">${MARKER_ICON}</div>
      <div class="tsf-marker-body">
        <div class="tsf-marker-title">${title}</div>
        <div class="tsf-marker-sub">${reason || ""}</div>
      </div>
      <button class="tsf-show-btn" type="button">抓回來看</button>
    `;
    const btn = marker.querySelector(".tsf-show-btn");
    // Belt and braces against Threads' SPA delegation: stop the event before any
    // ancestor click handler can navigate to the post permalink.
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const info = getPermalinkFromContainer(post);
      if (info?.shortcode) {
        state.revealed.add(info.shortcode);
        log("user revealed", info.shortcode);
      }
      post.classList.remove("tsf-marked");
      post.removeAttribute(HIDDEN_ATTR);
      post.removeAttribute("data-tsf-kind");
      marker.remove();
    });
    // Insert as the first child so it shows in place of the post body.
    post.insertBefore(marker, post.firstChild);

    state.hiddenCount += 1;
    log("marked post", { reason, kind, post: shortLabel(post) });
  }

  // Silent cleanup — strips visible markers + hidden-state attributes without
  // recording anything in state.revealed. Use for internal state transitions
  // (leaving the feed for a permalink, toggling filtering off, switching to
  // dry-run) where the user hasn't asked to permanently un-hide anything.
  // The cache stays intact, so the next scan can re-mark from it.
  function clearAllMarkers() {
    document.querySelectorAll(`[${HIDDEN_ATTR}]`).forEach((el) => {
      el.classList.remove("tsf-marked", "tsf-hidden");
      el.style.outline = "";
      el.style.outlineOffset = "";
      el.removeAttribute(HIDDEN_ATTR);
      el.removeAttribute("data-tsf-kind");
    });
    document.querySelectorAll(".tsf-marker").forEach((el) => el.remove());
  }

  function revealAll() {
    // User explicitly clicked "Show all" — record each currently-hidden post
    // in state.revealed so cache hits / virtualized re-renders / GraphQL
    // events can't re-mark them.
    const hidden = document.querySelectorAll(`[${HIDDEN_ATTR}]`);
    let added = 0;
    hidden.forEach((el) => {
      const info = getPermalinkFromContainer(el);
      if (info?.shortcode && !state.revealed.has(info.shortcode)) {
        state.revealed.add(info.shortcode);
        added += 1;
      }
    });
    clearAllMarkers();
    log(
      `revealed ${hidden.length} marked item(s) (${added} new in reveal set)`,
    );
  }

  // Re-apply markers for posts known to be shopee but where the marker is missing
  // (happens after Threads virtualization recreates the DOM).
  function reapplyMarkersFromCache() {
    if (!state.enabled || state.dryRun) return 0;
    let n = 0;
    document
      .querySelectorAll('[data-pressable-container="true"]')
      .forEach((post) => {
        if (post.querySelector(":scope > .tsf-marker")) return;
        const parentPressable = post.parentElement?.closest?.(
          '[data-pressable-container="true"]',
        );
        if (parentPressable) return;
        const info = getPermalinkFromContainer(post);
        if (!info) return;
        if (state.revealed.has(info.shortcode)) return;
        const cached = state.cache.get(info.shortcode);
        if (cached?.status === "shopee") {
          const kind = cached.reason?.includes("loose")
            ? "loose"
            : cached.reason?.includes("@handle")
              ? "mention"
              : "strong";
          markPost(post, `cached: @${info.author} linked Shopee`, kind);
          n += 1;
        }
      });
    return n;
  }

  // ---- prefetch queue -------------------------------------------------------
  function escapeForRegex(s) {
    return s.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
  }

  // Find all match indices for a regex across a string.
  function allIndices(text, re, limit = 50) {
    const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
    const r = new RegExp(re.source, flags);
    const out = [];
    let m;
    while ((m = r.exec(text)) && out.length < limit) {
      out.push({ index: m.index, len: m[0].length, value: m[0] });
      if (m.index === r.lastIndex) r.lastIndex++;
    }
    return out;
  }

  function snippet(text, idx, width = 60) {
    const start = Math.max(0, idx - width);
    const end = Math.min(text.length, idx + width);
    return text.slice(start, end).replace(/\s+/g, " ");
  }

  const TS_KEY_RE =
    /"(?:taken_at|created_at|posted_at|publish_time|publishedAt)"\s*:\s*(\d{9,11})/i;

  function extractFirstTimestamp(text) {
    const m = TS_KEY_RE.exec(text);
    return m ? Number(m[1]) : null;
  }

  function extractTimestampNear(text, index, window = 1500) {
    const start = Math.max(0, index - window);
    const end = Math.min(text.length, index + window);
    const region = text.slice(start, end);
    // Prefer the closest taken_at occurrence — search for all, pick min distance to anchor
    let best = null,
      bestDist = Infinity;
    const re = new RegExp(TS_KEY_RE.source, "gi");
    let m;
    while ((m = re.exec(region))) {
      const absIdx = start + m.index;
      const dist = Math.abs(absIdx - index);
      if (dist < bestDist) {
        bestDist = dist;
        best = Number(m[1]);
      }
    }
    return best;
  }

  function classifyTiming(opTs, replyTs) {
    if (!opTs || !replyTs) return null;
    const deltaSec = Math.abs(replyTs - opTs);
    if (deltaSec < 600) return { label: "pinned-fresh", deltaSec }; // < 10 min
    if (deltaSec < 3600) return { label: "fresh", deltaSec }; // < 1 hour
    if (deltaSec < 86400) return { label: "same-day", deltaSec }; // < 24 hours
    return { label: "late-reply", deltaSec };
  }

  function detectAuthorShopeeInHtml(htmlText, author) {
    const safe = escapeForRegex(author);

    const shopeeHits = allIndices(htmlText, SHOPEE_ANY_RE, 20);
    const usernameRe = new RegExp(`"username"\\s*:\\s*"${safe}"`, "gi");
    const mentionRe = new RegExp(`@${safe}\\b`, "gi");
    const usernameHits = allIndices(htmlText, usernameRe, 50);
    const mentionHits = allIndices(htmlText, mentionRe, 50);

    const diag = {
      responseLength: htmlText.length,
      shopeeCount: shopeeHits.length,
      usernameJsonCount: usernameHits.length,
      mentionCount: mentionHits.length,
      shopeeSamples: shopeeHits.slice(0, 5).map((h) => ({
        index: h.index,
        value: h.value,
        context: snippet(htmlText, h.index),
      })),
      minDistanceUsername: null,
      minDistanceMention: null,
    };

    if (shopeeHits.length === 0) {
      return { hit: false, reason: "no shopee in response", diag };
    }

    // Compute closest distance from username/mention to each shopee occurrence.
    function minDistance(anchorHits) {
      let best = Infinity;
      let bestPair = null;
      for (const a of anchorHits) {
        for (const s of shopeeHits) {
          const dist = s.index - (a.index + a.len);
          // We want anchor BEFORE shopee — that's the SSR ordering.
          if (dist >= 0 && dist < best) {
            best = dist;
            bestPair = { anchor: a, shopee: s };
          }
        }
      }
      return { distance: best === Infinity ? null : best, pair: bestPair };
    }

    const u = minDistance(usernameHits);
    const m = minDistance(mentionHits);
    diag.minDistanceUsername = u.distance;
    diag.minDistanceMention = m.distance;

    // Strong: SSR JSON username within 800 chars before shopee
    if (u.distance !== null && u.distance <= 800) {
      const opTs = extractFirstTimestamp(htmlText);
      const replyTs = extractTimestampNear(htmlText, u.pair.anchor.index, 1500);
      const timing = classifyTiming(opTs, replyTs);
      diag.opTimestamp = opTs;
      diag.replyTimestamp = replyTs;
      diag.timing = timing;
      diag.match = {
        kind: "strong",
        distance: u.distance,
        context: snippet(htmlText, u.pair.anchor.index, 120),
      };
      const timingTag = timing
        ? `, ${timing.label} +${Math.round(timing.deltaSec / 60)}m`
        : "";
      return {
        hit: true,
        reason: `json username→shopee (${u.distance}ch${timingTag})`,
        diag,
      };
    }
    // Mid: @handle within 600 chars before shopee
    if (m.distance !== null && m.distance <= 600) {
      diag.match = {
        kind: "mention",
        distance: m.distance,
        context: snippet(htmlText, m.pair.anchor.index, 120),
      };
      return { hit: true, reason: `@handle→shopee (${m.distance}ch)`, diag };
    }
    // Loose: shopee exists and author appears anywhere
    if (
      state.looseMatch &&
      (usernameHits.length > 0 || mentionHits.length > 0)
    ) {
      diag.match = { kind: "loose" };
      return { hit: true, reason: "loose (shopee + author present)", diag };
    }

    let why = "shopee present but no author proximity";
    if (usernameHits.length === 0 && mentionHits.length === 0) {
      why = "shopee present but author handle not found in response";
    }
    return { hit: false, reason: why, diag };
  }

  // Stream the response body and run detection every STREAM_CHECK_INTERVAL_BYTES.
  // If we get a confirmed hit before the body finishes, cancel the reader to
  // free the connection — typically saves 60-80% of body bytes on hit posts.
  async function streamAndDetect(res, author) {
    const reader = res.body?.getReader?.();
    if (!reader) {
      const text = await res.text();
      const result = detectAuthorShopeeInHtml(text, author);
      return { ...result, bytesRead: text.length, earlyExit: false };
    }
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let acc = "";
    let bytesRead = 0;
    let lastCheckAt = 0;
    let lastResult = null;
    let earlyExit = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        acc += decoder.decode(value, { stream: true });
        if (acc.length - lastCheckAt >= STREAM_CHECK_INTERVAL_BYTES) {
          lastCheckAt = acc.length;
          const probe = detectAuthorShopeeInHtml(acc, author);
          lastResult = probe;
          if (probe.hit) {
            earlyExit = true;
            try {
              await reader.cancel();
            } catch {}
            break;
          }
        }
      }
      if (!earlyExit) {
        acc += decoder.decode();
        lastResult = detectAuthorShopeeInHtml(acc, author);
      }
    } catch (e) {
      // If streaming errors out mid-way, do a best-effort check on what we have.
      warn("stream read error", e);
      if (!lastResult) lastResult = detectAuthorShopeeInHtml(acc, author);
    }
    return { ...(lastResult || { hit: false }), bytesRead, earlyExit };
  }

  function enqueuePrefetch(post, info) {
    if (!state.prefetch) return;
    if (!info?.shortcode || !info?.author) return;

    const cached = state.cache.get(info.shortcode);
    if (cached) {
      if (cached.status === "pending") {
        // Recover from stuck pending: if a worker crashed between cache.set
        // and fetch (or hung longer than a reasonable round-trip), let this
        // path retry instead of waiting forever.
        if (Date.now() - (cached.ts || 0) > 30_000) {
          log("stale pending, retrying", info.shortcode);
          state.cache.delete(info.shortcode);
          // fall through to re-enqueue below
        } else {
          return; // genuinely in flight
        }
      } else {
        if (cached.status === "shopee") {
          if (state.revealed.has(info.shortcode)) {
            log("cache hit but user revealed; skipping", info.shortcode);
            return;
          }
          const kind = cached.reason?.includes("loose")
            ? "loose"
            : cached.reason?.includes("@handle")
              ? "mention"
              : "strong";
          log("cache hit → mark", info.shortcode, kind);
          markPost(post, `cached: @${info.author} linked Shopee`, kind);
        }
        return;
      }
    }

    setCache(info.shortcode, {
      status: "pending",
      ts: Date.now(),
      permalink: info.permalink,
      author: info.author,
    });
    const ageMs = getPostAgeMs(post);
    const fresh = ageMs !== null && ageMs < 30 * 60 * 1000;
    const job = { post: new WeakRef(post), info, fresh, ageMs };
    if (fresh) {
      state.queue.unshift(job);
      log(
        "queued (priority/fresh)",
        info.permalink,
        `${Math.round(ageMs / 60000)}min old`,
      );
    } else {
      state.queue.push(job);
      log(
        "queued prefetch",
        info.permalink,
        ageMs !== null ? `${Math.round(ageMs / 60000)}min old` : "age unknown",
      );
    }
    pump();
  }

  function pump() {
    while (state.activeWorkers < state.concurrency && state.queue.length) {
      const job = state.queue.shift();
      state.activeWorkers++;
      runJob(job).finally(() => {
        state.activeWorkers--;
        pump();
      });
    }
  }

  async function runJob({ post: postRef, info }) {
    const startedAt = Date.now();
    try {
      const res = await fetch(info.permalink, {
        credentials: "include",
        headers: { Accept: "text/html,*/*;q=0.8" },
      });
      state.fetchedCount += 1;
      if (!res.ok) {
        warn("prefetch HTTP", res.status, info.permalink);
        setCache(info.shortcode, {
          status: "clean", // treat as clean to avoid retry storms; will expire
          ts: Date.now(),
          permalink: info.permalink,
          author: info.author,
          note: `http ${res.status}`,
        });
        persistCacheDebounced();
        return;
      }
      const streamed = await streamAndDetect(res, info.author);
      const { hit, reason, diag, bytesRead, earlyExit } = streamed;
      const entry = {
        status: hit ? "shopee" : "clean",
        ts: Date.now(),
        permalink: info.permalink,
        author: info.author,
        reason: reason || null,
        diag,
        ms: Date.now() - startedAt,
        bytesRead,
        earlyExit,
      };
      setCache(info.shortcode, entry);
      log(
        hit ? "PREFETCH HIT" : "prefetch clean",
        info.permalink,
        reason || "",
        `${entry.ms}ms`,
        earlyExit ? `early-exit @${bytesRead}B` : `read ${bytesRead}B`,
        {
          shopee: diag?.shopeeCount,
          usernameJson: diag?.usernameJsonCount,
          mentions: diag?.mentionCount,
          minDistU: diag?.minDistanceUsername,
          minDistM: diag?.minDistanceMention,
        },
      );
      if (hit) {
        state.prefetchHits += 1;
        if (state.revealed.has(info.shortcode)) {
          log("prefetch hit but user revealed; skipping", info.shortcode);
        } else {
          const kind = reason?.includes("loose")
            ? "loose"
            : reason?.includes("@handle")
              ? "mention"
              : "strong";
          const post = postRef.deref?.();
          if (post && post.isConnected) {
            markPost(
              post,
              `prefetched: @${info.author} linked Shopee (${reason})`,
              kind,
            );
          } else {
            log(
              "prefetch hit but post element gone — will mark on next scan",
              info.permalink,
            );
            scanSoon();
          }
        }
      }
      persistCacheDebounced();
    } catch (e) {
      warn("prefetch failed", info.permalink, e);
      // Don't cache the failure permanently
      state.cache.delete(info.shortcode);
    }
  }

  // ---- core scan ------------------------------------------------------------
  function scan() {
    if (!state.enabled) return;
    if (isThreadDetailPage()) {
      // Filtering is feed-only. On a permalink page the user wants to read the thread.
      // Clean up markers from the previous feed page — but DON'T mark those posts
      // as user-revealed, otherwise navigating back to the feed leaves them
      // permanently unfiltered for the session.
      clearAllMarkers();
      return;
    }
    state.scanCount += 1;
    state.lastScanAt = new Date().toISOString();

    const g = group(`scan #${state.scanCount}`);

    // PART 1: inline shopee detection (post-detail pages, expanded replies)
    const links = document.querySelectorAll("a[href]");
    let foundShopee = 0;
    let matched = 0;
    const inlineCandidates = [];

    for (const a of links) {
      const href = a.getAttribute("href");
      if (!href) continue;
      const matchesShopee =
        isShopeeUrl(href) || SHOPEE_TEXT_RE.test(a.textContent || "");
      if (!matchesShopee) continue;
      foundShopee += 1;

      const replyContainer = findReplyContainer(a);
      const skipBecauseProcessed =
        replyContainer && replyContainer.getAttribute(PROCESSED_ATTR) === "1";

      const replyAuthor = getContainerAuthor(replyContainer);

      let outer = replyContainer?.parentElement ?? null;
      let matchedPost = null;
      while (outer && outer !== document.body) {
        if (outer.matches?.('[data-pressable-container="true"]')) {
          const outerAuthor = getContainerAuthor(outer);
          if (outerAuthor && outerAuthor === replyAuthor) {
            matchedPost = outer;
            break;
          }
        }
        outer = outer.parentElement;
      }
      if (!matchedPost) {
        const postContainer = findPostContainer(a);
        if (postContainer) {
          const postAuthor = getContainerAuthor(postContainer);
          if (postAuthor && postAuthor === replyAuthor) {
            matchedPost = postContainer;
          }
        }
      }

      inlineCandidates.push({
        href,
        replyAuthor,
        replyContainer: replyContainer ? shortLabel(replyContainer) : null,
        matchedPost: matchedPost ? shortLabel(matchedPost) : null,
        skipped: skipBecauseProcessed,
      });

      if (skipBecauseProcessed) continue;
      if (replyContainer) replyContainer.setAttribute(PROCESSED_ATTR, "1");
      if (!replyAuthor) continue;

      if (matchedPost) {
        matched += 1;
        markPost(
          matchedPost,
          `inline: author @${replyAuthor} linked Shopee`,
          "inline",
        );
      }
    }

    // PART 1.5: re-apply markers from cache (handles virtualized post re-renders)
    const reapplied = reapplyMarkersFromCache();

    // PART 2: feed prefetch — enqueue every outer post container we haven't checked yet
    if (state.prefetch) {
      const posts = document.querySelectorAll(
        '[data-pressable-container="true"]',
      );
      let queued = 0;
      for (const post of posts) {
        if (post.getAttribute(FEED_CHECKED_ATTR) === "1") continue;
        if (post.getAttribute(HIDDEN_ATTR)) continue;
        // Only outermost pressables (a post in feed). Nested pressables = replies on detail page; skip.
        const parentPressable = post.parentElement?.closest?.(
          '[data-pressable-container="true"]',
        );
        if (parentPressable) continue;

        const info = getPermalinkFromContainer(post);
        if (!info) continue;

        post.setAttribute(FEED_CHECKED_ATTR, "1");
        enqueuePrefetch(post, info);
        queued += 1;
      }
      if (queued || reapplied)
        log(`feed: queued ${queued} · re-marked ${reapplied}`);
    }

    state.lastScanFoundShopee = foundShopee;
    state.lastScanMatched = matched;
    state.inlineCandidates = inlineCandidates;
    log("scan complete", {
      scanCount: state.scanCount,
      foundShopee,
      matched,
      hiddenCountTotal: state.hiddenCount,
      queue: state.queue.length,
      cache: state.cache.size,
    });
    g.end();
  }

  function forceRescan() {
    document
      .querySelectorAll(`[${PROCESSED_ATTR}="1"]`)
      .forEach((el) => el.removeAttribute(PROCESSED_ATTR));
    document
      .querySelectorAll(`[${FEED_CHECKED_ATTR}]`)
      .forEach((el) => el.removeAttribute(FEED_CHECKED_ATTR));
    log("force rescan");
    scan();
  }

  let scanTimer = null;
  function scanSoon() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      try {
        scan();
      } catch (e) {
        warn("scan error", e);
      }
    }, 80);
  }

  // ---- GraphQL interception ------------------------------------------------
  // injected.js (MAIN world) hooks fetch/XHR and dispatches a CustomEvent whenever
  // a Threads API response contains a Shopee URL. We piggyback on Threads' own
  // network traffic instead of issuing our own prefetch.
  window.addEventListener("tsf:injected-ready", (e) => {
    state.graphqlReady = true;
    log("page-world hook ready", e.detail);
  });

  window.addEventListener("tsf:graphql", (e) => {
    const detail = e && e.detail;
    if (!detail || !detail.body) return;
    state.graphqlEvents += 1;
    try {
      processGraphqlBody(detail.url, detail.body);
    } catch (err) {
      warn("graphql process error", err);
    }
  });

  function processGraphqlBody(url, body) {
    if (isThreadDetailPage()) {
      // On the thread page the body bundles the whole thread; marking would
      // false-fire on every reply. User asked to read freely once they click in.
      return;
    }
    log("graphql intercepted", url, `${body.length}B`);
    // For each visible (not-yet-marked) post, check if the GraphQL body proves
    // the author has linked Shopee. This avoids any of our own fetches.
    const posts = document.querySelectorAll(
      '[data-pressable-container="true"]',
    );
    let hits = 0;
    for (const post of posts) {
      // Skip nested (reply) containers — we only mark outer feed/thread posts.
      const parentPressable = post.parentElement?.closest?.(
        '[data-pressable-container="true"]',
      );
      if (parentPressable) continue;
      if (post.querySelector(":scope > .tsf-marker")) continue;

      const info = getPermalinkFromContainer(post);
      if (!info) continue;
      if (state.revealed.has(info.shortcode)) continue;
      const cached = state.cache.get(info.shortcode);
      if (cached?.status === "shopee") continue;
      // Skip recently-checked clean posts. If a clean cache entry is older than
      // CLEAN_RECHECK_MS we still re-evaluate, in case the author has since added
      // a Shopee reply.
      if (
        cached?.status === "clean" &&
        Date.now() - (cached.ts || 0) < CLEAN_RECHECK_MS
      )
        continue;

      const result = detectAuthorShopeeInHtml(body, info.author);
      if (!result.hit) continue;

      const kind = result.reason?.includes("loose")
        ? "loose"
        : result.reason?.includes("@handle")
          ? "mention"
          : "strong";
      const entry = {
        status: "shopee",
        ts: Date.now(),
        permalink: info.permalink,
        author: info.author,
        reason: `graphql: ${result.reason}`,
        diag: result.diag,
        source: "graphql",
        ms: 0,
      };
      setCache(info.shortcode, entry);
      state.graphqlHits += 1;
      hits += 1;
      log("GRAPHQL HIT", info.permalink, result.reason);
      markPost(post, `graphql: @${info.author} linked Shopee`, kind);
    }
    if (hits) persistCacheDebounced();
  }

  // Ignore mutations that consist only of our own marker insertions/removals.
  // Without this, every markPost() triggers another scan, which triggers another, etc.
  // The 80ms debounce coalesces the loop but it's still wasted CPU.
  function isOwnNode(node) {
    if (!node || node.nodeType !== 1) return false;
    return node.classList?.contains("tsf-marker");
  }
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (!isOwnNode(n)) {
          scanSoon();
          return;
        }
      }
      // We don't care about removals — we only act on new posts entering DOM.
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      log("SPA nav", { from: lastUrl, to: location.href });
      lastUrl = location.href;
      document
        .querySelectorAll(`[${PROCESSED_ATTR}="1"]`)
        .forEach((el) => el.removeAttribute(PROCESSED_ATTR));
      scanSoon();
    }
  }, 1000);

  // ---- console debug API ----------------------------------------------------
  window.__tsf = {
    get state() {
      return {
        enabled: state.enabled,
        debug: state.debug,
        dryRun: state.dryRun,
        prefetch: state.prefetch,
        looseMatch: state.looseMatch,
        concurrency: state.concurrency,
        hiddenCount: state.hiddenCount,
        scanCount: state.scanCount,
        lastScanAt: state.lastScanAt,
        lastScanFoundShopee: state.lastScanFoundShopee,
        lastScanMatched: state.lastScanMatched,
        fetchedCount: state.fetchedCount,
        prefetchHits: state.prefetchHits,
        queueLength: state.queue.length,
        cacheSize: state.cache.size,
        activeWorkers: state.activeWorkers,
        graphqlEvents: state.graphqlEvents,
        graphqlHits: state.graphqlHits,
        graphqlReady: state.graphqlReady,
      };
    },
    rescan: forceRescan,
    revealAll,
    dump() {
      console.table(state.inlineCandidates);
      return state.inlineCandidates;
    },
    dumpCache() {
      const rows = [];
      for (const [shortcode, v] of state.cache.entries()) {
        rows.push({
          shortcode,
          status: v.status,
          author: v.author,
          reason: v.reason,
          ageMin: Math.round((Date.now() - (v.ts || 0)) / 60000),
          ms: v.ms,
        });
      }
      console.table(rows);
      return rows;
    },
    clearCache() {
      state.cache.clear();
      chrome.storage.local.remove(CACHE_KEY);
      console.log("[TSF] cache cleared");
    },
    setDebug(v) {
      chrome.storage.sync.set({ debug: !!v });
    },
    setDryRun(v) {
      chrome.storage.sync.set({ dryRun: !!v });
    },
    setEnabled(v) {
      chrome.storage.sync.set({ enabled: !!v });
    },
    setPrefetch(v) {
      chrome.storage.sync.set({ prefetch: !!v });
    },
    setLooseMatch(v) {
      chrome.storage.sync.set({ looseMatch: !!v });
    },
    setConcurrency(n) {
      chrome.storage.sync.set({ concurrency: clampConcurrency(n) });
    },
    revealedList() {
      return [...state.revealed];
    },
    clearRevealed() {
      state.revealed.clear();
      log("revealed set cleared");
    },
    // Ad-hoc inspect: fetches a permalink and runs the heuristic, returning a full report.
    // Usage: await __tsf.checkPermalink('/@user/post/SHORTCODE')
    async checkPermalink(permalinkOrUrl, authorOverride) {
      let path = permalinkOrUrl;
      try {
        const u = new URL(permalinkOrUrl, location.origin);
        path = u.pathname;
      } catch {}
      const m = path.match(/^\/@([A-Za-z0-9._]+)\/post\/([A-Za-z0-9_-]+)/);
      if (!m) {
        console.warn(
          "[TSF] checkPermalink: not a /@user/post/code path:",
          path,
        );
        return null;
      }
      const author = (authorOverride || m[1]).toLowerCase();
      const startedAt = Date.now();
      const res = await fetch(path, {
        credentials: "include",
        headers: { Accept: "text/html,*/*;q=0.8" },
      });
      const text = await res.text();
      const result = detectAuthorShopeeInHtml(text, author);
      const report = {
        permalink: path,
        author,
        httpStatus: res.status,
        ms: Date.now() - startedAt,
        hit: result.hit,
        reason: result.reason,
        diag: result.diag,
        // helper: a "find author" snippet for manual inspection
        authorSnippets: text
          .split(
            new RegExp(`"username"\\s*:\\s*"${escapeForRegex(author)}"`, "i"),
          )
          .slice(0, 3)
          .map((chunk, i) => (i === 0 ? null : chunk.slice(0, 200)))
          .filter(Boolean),
      };
      console.log("[TSF] checkPermalink report:", report);
      if (result.diag?.shopeeSamples?.length) {
        console.log("[TSF] shopee samples:");
        console.table(result.diag.shopeeSamples);
      }
      return report;
    },
    inspect(el) {
      if (!el) return null;
      const reply = findReplyContainer(el);
      const post = findPostContainer(el);
      const info = getPermalinkFromContainer(post);
      return {
        replyContainer: reply,
        replyAuthor: getContainerAuthor(reply),
        postContainer: post,
        postAuthor: getContainerAuthor(post),
        permalink: info?.permalink,
        cached: info?.shortcode ? state.cache.get(info.shortcode) : null,
      };
    },
  };

  log(
    "content script loaded. Try __tsf.state, __tsf.dump(), __tsf.dumpCache(), __tsf.rescan()",
  );
})();
