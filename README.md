# Threads 蝦皮分潤蟑螂剋星

**一噴斃命 · ROACH OUT!** — a Chrome (Manifest V3) extension that hides Threads posts where the **post author** has dropped a Shopee shared link in their own reply. That is the "**蝦皮分潤蟑螂**" pattern: someone seeds a viral-looking post and then drops the affiliate link in their own self-reply once it picks up traction.

> 一鍵 💨🪳 — 讓自串塞蝦皮聯盟連結的分潤蟑螂從你的 feed 蒸發。

A post is hidden only when the **same handle** that authored the post also authored a reply containing a Shopee link. Replies by other people are not penalised.

## What it matches

- Hosts: `shopee.tw`, `shopee.com`, `shopee.com.my`, `shopee.ph`, `shopee.co.id`, `shopee.sg`, `shopee.vn`, `shopee.co.th`, `shopee.com.br`
- Short links: `shp.ee`, `s.shopee.*`
- Detected as `<a href>`, as plain text in replies, and inside Threads' own GraphQL responses

## Install (developer mode)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. **Load unpacked** → select the **`src/`** folder of this repo
4. Visit https://www.threads.net or https://www.threads.com

## Popup controls

| Label | English | What it does |
| --- | --- | --- |
| 啟動藥噴 | Spray ON | Master toggle. Off = nothing is filtered. |
| 預先掃描 | Pre-scan | Pre-fetches feed posts' permalinks so spam can be caught before you scroll into it. |
| 寬鬆比對 | Wider net | Marks a post when *any* Shopee URL appears in its server-rendered HTML alongside the author handle, even without strict proximity. Catches more, with a small false-positive risk. |
| 噴霧火力 | Spray power | Concurrency of the pre-fetch queue. 小噴 (2) / 標準 (6) / 超大瓶 (10). |
| 演習模式 | Dry-run | Outlines what would be hidden instead of hiding it. |
| Debug 日誌 | Debug log | Verbose `[TSF]` logs in the page's DevTools console. |

Buttons: **重噴一輪** rescans the current page · **全部抓回** reveals every filtered post on this page (and remembers your choice for this session) · **清空藥罐** wipes the persisted permalink cache.

## The filtered card

Each filtered post is collapsed into a small card with the kill notice and a **抓回來看** button to recover false positives. The card stays inside the original post container, so it survives Threads' DOM virtualisation on scroll.

## How it works

`content.js` runs at `document_idle` and works in three overlapping layers:

1. **Inline DOM scan.** Every `<a>` on the page is checked for Shopee URLs. The script walks up to the nearest pressable container — Threads' per-post wrapper (`[data-pressable-container="true"]`) — reads its author handle (the first `/@username` link inside), walks one more level up to the outer post container, and reads *its* author. If both authors match, the outer post is collapsed and a marker is inserted in place.
2. **Permalink pre-fetch.** For posts in the feed whose replies aren't expanded, a small worker queue fetches the post's permalink HTML in the background, regex-scans the SSR'd response for the author's handle near a Shopee URL, and caches the verdict for 24 hours in `chrome.storage.local` under `tsf_cache_v1`. Cache hits are re-applied on every scan, so a virtualised re-render or a SPA navigation back to the feed restores the marker without re-fetching.
3. **GraphQL piggyback.** `injected.js` runs in the page's MAIN world (declared in the manifest) and wraps `fetch` / `XMLHttpRequest`. When a Threads API response body contains a Shopee URL, it dispatches a `tsf:graphql` `CustomEvent` that the ISOLATED-world content script listens for. This catches spam that would otherwise need a manual permalink fetch.

A `MutationObserver` plus a 1-second URL poll handles infinite-scroll and SPA navigation. Selectors stay heuristic on purpose — Threads ships obfuscated class names, so the script anchors on stable signals (`data-pressable-container`, `/@handle` link shape) rather than CSS classes.

Filtering is feed-only. On a permalink page (`/@user/post/CODE`), markers are cleared so you can read the thread — and importantly, those posts are **not** added to the "user revealed" set, so navigating back to the feed re-applies their markers from the cache.

## Debug API

Open DevTools (F12) → Console on a Threads tab:

```js
__tsf.state              // current settings + counters
__tsf.dump()             // dump per-post diagnostic info
__tsf.dumpCache()        // dump the permalink cache
__tsf.rescan()           // force a rescan
await __tsf.checkPermalink('/@user/post/CODE')  // diagnose one post
```

## Known limitations

- If Threads stops emitting `data-pressable-container`, the fallback uses `div[role="article"]`. Both can break with a redesign.
- A post whose author *only* shared the Shopee link as a separate post (not as a reply under another of their posts) is not filtered — by design, that isn't the spam pattern this targets.
- Replies lazy-loaded behind a "View replies" click won't be inspected until they're rendered. Pre-fetch + GraphQL layers usually catch these earlier, but not always.
- Pre-fetch issues real HTTP requests to Threads permalinks. The default concurrency (6) is conservative; bump 噴霧火力 to 10 if you're a heavy scroller, or down to 2 if you're worried about rate-limiting.
