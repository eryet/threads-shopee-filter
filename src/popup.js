const enabledEl = document.getElementById("enabled");
const prefetchEl = document.getElementById("prefetch");
const looseMatchEl = document.getElementById("looseMatch");
const concurrencyEl = document.getElementById("concurrency");
const dryRunEl = document.getElementById("dryRun");
const debugEl = document.getElementById("debug");
const statHidden = document.getElementById("statHidden");
const statScan = document.getElementById("statScan");
const statPrefetch = document.getElementById("statPrefetch");
const statGraphql = document.getElementById("statGraphql");
const revealBtn = document.getElementById("reveal");
const rescanBtn = document.getElementById("rescan");
const clearCacheBtn = document.getElementById("clearCache");

chrome.storage.sync.get(
  {
    enabled: true,
    debug: true,
    dryRun: false,
    prefetch: true,
    looseMatch: true,
    concurrency: 6,
  },
  (v) => {
    enabledEl.checked = v.enabled !== false;
    prefetchEl.checked = v.prefetch !== false;
    looseMatchEl.checked = v.looseMatch !== false;
    dryRunEl.checked = !!v.dryRun;
    debugEl.checked = v.debug !== false;
    // Snap to nearest known value (popup has 3 fixed options; storage may have any int)
    const n = Number(v.concurrency) || 6;
    concurrencyEl.value = n <= 3 ? "2" : n >= 8 ? "10" : "6";
  }
);

enabledEl.addEventListener("change", () => {
  chrome.storage.sync.set({ enabled: enabledEl.checked });
});
prefetchEl.addEventListener("change", () => {
  chrome.storage.sync.set({ prefetch: prefetchEl.checked });
});
looseMatchEl.addEventListener("change", () => {
  chrome.storage.sync.set({ looseMatch: looseMatchEl.checked });
});
concurrencyEl.addEventListener("change", () => {
  const n = Number(concurrencyEl.value) || 6;
  chrome.storage.sync.set({ concurrency: n });
});
dryRunEl.addEventListener("change", () => {
  chrome.storage.sync.set({ dryRun: dryRunEl.checked });
});
debugEl.addEventListener("change", () => {
  chrome.storage.sync.set({ debug: debugEl.checked });
});

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function sendToActiveTab(msg) {
  return new Promise(async (resolve) => {
    const tabId = await getActiveTabId();
    if (!tabId) return resolve(null);
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(resp);
      });
    } catch {
      resolve(null);
    }
  });
}

async function refreshStats() {
  const resp = await sendToActiveTab({ type: "tsf:getStats" });
  if (!resp) {
    statHidden.textContent = "本頁已斃命：— (非 Threads 分頁？)";
    statScan.textContent = "掃描：— · 蝦皮藥：— · 命中：—";
    statPrefetch.textContent = "預掃：— · 命中：— · 排隊：— · 庫存：—";
    statGraphql.textContent = "GraphQL 訊號：— · 命中：— · 鉤子：—";
    return;
  }
  statHidden.textContent = `本頁已斃命：${resp.hiddenCount ?? 0}`;
  statScan.textContent =
    `掃描：${resp.scanCount ?? 0} · ` +
    `蝦皮藥：${resp.lastScanFoundShopee ?? 0} · ` +
    `命中：${resp.lastScanMatched ?? 0}`;
  statPrefetch.textContent =
    `預掃：${resp.fetchedCount ?? 0} · ` +
    `命中：${resp.prefetchHits ?? 0} · ` +
    `排隊：${resp.queueLength ?? 0} · ` +
    `庫存：${resp.cacheSize ?? 0}`;
  statGraphql.textContent =
    `GraphQL 訊號：${resp.graphqlEvents ?? 0} · ` +
    `命中：${resp.graphqlHits ?? 0} · ` +
    `鉤子：${resp.graphqlReady ? "上膛" : "未上膛"}`;
}

revealBtn.addEventListener("click", async () => {
  await sendToActiveTab({ type: "tsf:revealAll" });
  refreshStats();
});

rescanBtn.addEventListener("click", async () => {
  await sendToActiveTab({ type: "tsf:rescan" });
  refreshStats();
});

clearCacheBtn.addEventListener("click", async () => {
  await sendToActiveTab({ type: "tsf:clearCache" });
  refreshStats();
});

refreshStats();
setInterval(refreshStats, 1500);
