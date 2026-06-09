// ─── Easter egg: sachi-wallpaper starfield ──────────────────────────────────
//
// Canvas is a full-viewport overlay with `pointer-events: none` and
// `mix-blend-mode: lighten`. Lighten keeps the page underneath pixel-for-pixel
// wherever its colour is brighter than the canvas, so:
//   • on dark gutters / sidebars / page background → white stars show through
//   • on post cards (usually lighter than #fff white stars) → stars vanish
// Result: stars look like they're sitting in the empty space behind the UI,
// without us needing to fight Threads' opaque body / wrapper backgrounds.
//
// State is driven by chrome.storage.sync.starfield so the popup toggle, the
// Konami code, and DevTools (`__tsf_starfield.toggle()`) all share one switch
// and stay in sync across tabs.
//
// Starfield logic adapted from https://github.com/eryet/sachi-wallpaper
(() => {
  const STAR_COUNT = 1000;
  const SHOOTING_COUNT = 5;
  const STAR_SIZE = 3;
  const SHOOTING_SIZE = 3.5;
  const SHOOTING_LEN = 90;

  let host = null;
  let canvas = null;
  let ctx = null;
  let rafId = null;
  let entities = [];
  let maskInterval = null;
  let active = false;

  // Feed columns are ARIA regions. Match on role alone, NOT
  // aria-label="Column body": that label is localized by Threads (e.g.
  // "直欄內文" on ?hl=zh-tw), so qualifying by the English text made the mask
  // match zero columns on every non-English locale. role="region" is
  // locale-independent and Threads only uses it for column bodies.
  const COLUMN_SELECTOR = '[role="region"]';

  const rand = (a, b) => Math.random() * (b - a) + a;

  function Star() {
    this.size = rand(0.6, STAR_SIZE);
    this.speed = rand(0.05, 0.1);
    this.x = rand(0, canvas.width);
    this.y = rand(0, canvas.height);
  }
  Star.prototype.reset = function () {
    this.size = rand(0.6, STAR_SIZE);
    this.speed = rand(0.05, 0.1);
    this.x = canvas.width;
    this.y = rand(0, canvas.height);
  };
  Star.prototype.update = function () {
    this.x -= this.speed;
    if (this.x < 0) this.reset();
    else ctx.fillRect(this.x, this.y, this.size, this.size);
  };

  function ShootingStar() {
    this.reset();
  }
  ShootingStar.prototype.reset = function () {
    this.x = rand(0, canvas.width * 1.5);
    this.y = 0;
    this.len = rand(10, SHOOTING_LEN);
    this.speed = rand(6, 16);
    this.size = rand(0.5, SHOOTING_SIZE);
    this.waitTime = Date.now() + rand(500, 3500);
    this.active = false;
  };
  ShootingStar.prototype.update = function () {
    if (this.active) {
      this.x -= this.speed;
      this.y += this.speed;
      if (this.x < 0 || this.y >= canvas.height) this.reset();
      else {
        ctx.lineWidth = this.size;
        ctx.beginPath();
        ctx.moveTo(this.x, this.y);
        ctx.lineTo(this.x + this.len, this.y - this.len);
        ctx.stroke();
      }
    } else if (this.waitTime < Date.now()) {
      this.active = true;
    }
  };

  function spawn() {
    entities = [];
    for (let i = 0; i < STAR_COUNT; i++) entities.push(new Star());
    for (let i = 0; i < SHOOTING_COUNT; i++) entities.push(new ShootingStar());
  }

  function resize() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function frame() {
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#ffffff";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const e of entities) e.update();
    rafId = requestAnimationFrame(frame);
  }

  // Cut every Threads feed column out of the canvas. The clip-path is the
  // viewport rectangle (outer) plus one rectangle per column (inner), all
  // traced clockwise — with evenodd fill each inner rectangle cancels the
  // outer in its area, so the canvas paints only as a frame around the
  // columns. Since the canvas literally doesn't paint inside any column, its
  // lighten-blend can't reach the posts/images inside, no matter how many
  // columns are open or what stacking contexts their ancestors create.
  function updateMask() {
    if (!active || !canvas) return;
    const cols = document.querySelectorAll(COLUMN_SELECTOR);
    const W = window.innerWidth;
    const H = window.innerHeight;
    let path =
      "M 0 0 L " + W + " 0 L " + W + " " + H + " L 0 " + H + " Z";
    let holes = 0;
    for (const col of cols) {
      const r = col.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      path +=
        " M " + r.left + " " + r.top +
        " L " + r.right + " " + r.top +
        " L " + r.right + " " + r.bottom +
        " L " + r.left + " " + r.bottom + " Z";
      holes++;
    }
    canvas.style.clipPath = holes
      ? "path(evenodd, '" + path + "')"
      : "";
  }

  function install(silent) {
    if (active) return;
    active = true;

    host = document.createElement("div");
    host.id = "tsf-starfield-host";
    host.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;pointer-events:none;";

    canvas = document.createElement("canvas");
    canvas.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;" +
      "mix-blend-mode:lighten;";
    host.appendChild(canvas);
    // Attach to <html> so Threads' SPA reconciler can't drop it on body swaps.
    document.documentElement.appendChild(host);

    ctx = canvas.getContext("2d");
    resize();
    spawn();
    frame();
    updateMask();
    window.addEventListener("resize", resize);
    window.addEventListener("resize", updateMask);
    // Re-cut on SPA navigation, sidebar collapse, etc. 500ms is plenty.
    maskInterval = setInterval(updateMask, 500);
    if (!silent) showToast("✨ Sachi 星空 ON");
  }

  function uninstall(silent) {
    if (!active) return;
    active = false;
    cancelAnimationFrame(rafId);
    rafId = null;
    if (maskInterval !== null) {
      clearInterval(maskInterval);
      maskInterval = null;
    }
    window.removeEventListener("resize", resize);
    window.removeEventListener("resize", updateMask);
    host?.remove();
    host = null;
    canvas = null;
    ctx = null;
    entities = [];
    if (!silent) showToast("✨ Sachi 星空 OFF");
  }

  function apply(want, silent) {
    if (want && !active) install(silent);
    else if (!want && active) uninstall(silent);
  }

  function toggle() {
    chrome.storage.sync.set({ starfield: !active });
  }

  function showToast(text) {
    const t = document.createElement("div");
    t.textContent = text;
    t.style.cssText =
      "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);" +
      "background:rgba(5,0,76,0.9);color:#fff;padding:10px 20px;" +
      "border-radius:999px;font:600 13px/1 -apple-system,system-ui,sans-serif;" +
      "z-index:2147483647;pointer-events:none;letter-spacing:0.08em;" +
      "box-shadow:0 6px 24px rgba(0,0,0,0.35);opacity:0;" +
      "transition:opacity 0.2s ease-out;";
    document.documentElement.appendChild(t);
    requestAnimationFrame(() => (t.style.opacity = "1"));
    setTimeout(() => {
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 250);
    }, 1500);
  }

  // Initial state — silent so it doesn't toast on every page load.
  chrome.storage.sync.get({ starfield: false }, (v) => {
    if (v.starfield) apply(true, true);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.starfield) return;
    apply(!!changes.starfield.newValue, false);
  });

  // ─── Konami code listener ─────────────────────────────────────────────────
  const KONAMI = [
    "ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
    "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight",
    "b", "a",
  ];
  let progress = 0;
  window.addEventListener("keydown", (e) => {
    const el = document.activeElement;
    if (
      el &&
      (el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable)
    ) {
      progress = 0;
      return;
    }
    const expected = KONAMI[progress];
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === expected) {
      progress++;
      if (progress === KONAMI.length) {
        progress = 0;
        toggle();
      }
    } else {
      progress = key === KONAMI[0] ? 1 : 0;
    }
  });

  window.__tsf_starfield = {
    toggle,
    isActive: () => active,
  };
})();
