/**
 * The DOOM console: a webview that acts as the machine's front panel.
 *
 * The board is the *display*; this is the *keyboard and switches*. A webview is
 * a real document on its own origin, so unlike the driver it sees genuine
 * keydown **and keyup** for every key — which is what makes weapon digits and
 * precise strafing possible. It sends symbolic key names (never raw numbers:
 * the numeric values live inside the wasm module) and the driver resolves them.
 *
 * Everything is inline — no network, no CDN — and the palette comes from
 * Drawdy's own `ModuleStyling` so the panel matches the board's theme.
 */
import type { ModuleStyling } from "@drawdy/driver-protocol";
import { CONTROL_SCHEME, WEAPON_SLOTS } from "../doom/keys";
import { ASCII_RAMPS } from "../render/ascii-screen";
import { PALETTES, RESOLUTIONS } from "../render/screen";

const escapeHtml = (value: string): string =>
    value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

export function consoleHtml(styling: ModuleStyling): string {
    const resolutionOptions = RESOLUTIONS.map(
        (r) => `<option value="${r.id}">${escapeHtml(r.label)}</option>`
    ).join("");
    const weaponButtons = WEAPON_SLOTS.map(
        (w) => `<button class="weapon" data-slot="${w.slot}" title="${escapeHtml(w.label)}">${w.slot}</button>`
    ).join("");
    const paletteOptions = PALETTES.map(
        (palette) => `<option value="${palette.id}">${escapeHtml(palette.label)}</option>`
    ).join("");
    const rampOptions = [{ id: "auto", label: "Auto — from the measured font" }, ...ASCII_RAMPS].map(
        (ramp) => `<option value="${ramp.id}">${escapeHtml(ramp.label)}</option>`
    ).join("");
    const controlRows = CONTROL_SCHEME.map(
        (c) => `<tr><td class="keycap">${escapeHtml(c.keys)}</td><td>${escapeHtml(c.action)}</td></tr>`
    ).join("");

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>DOOM console</title>
<style>
  :root {
    --bg: ${styling.background};
    --fg: ${styling.foreground};
    --muted: ${styling.mutedForeground};
    --surface: ${styling.surface};
    --surface2: ${styling.surface2};
    --border: ${styling.border};
    --primary: ${styling.primary};
    --primary-fg: ${styling.primaryForeground};
    --accent: ${styling.accent};
    --danger: ${styling.destructive};
    --ok: ${styling.success};
    --warn: ${styling.warning};
    --radius: ${styling.radiusMd};
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 12px; background: var(--bg); color: var(--fg);
    font: 12px/1.45 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    min-width: 260px;
  }
  h1 {
    margin: 0 0 2px; font-size: 21px; letter-spacing: 3px; font-weight: 800;
    display: flex; align-items: center; gap: 8px;
  }
  .sub { color: var(--muted); font-size: 11px; margin-bottom: 10px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: none; }
  .dot.on { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
  .dot.err { background: var(--danger); }

  #focus {
    border: 1px dashed var(--border); border-radius: var(--radius); padding: 10px;
    text-align: center; margin-bottom: 10px; cursor: pointer; background: var(--surface);
    font-weight: 600; user-select: none;
  }
  #focus.live { border-style: solid; border-color: var(--ok); color: var(--ok); background: var(--surface2); }

  section { margin-bottom: 10px; }
  .label { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; }
  button, select, input[type=file] { font: inherit; color: var(--fg); }
  button {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 6px 10px; cursor: pointer; flex: 1 1 auto; min-width: 0;
  }
  button:hover { background: var(--surface2); }
  button:active { transform: translateY(1px); }
  button.primary { background: var(--primary); color: var(--primary-fg); border-color: var(--primary); font-weight: 700; }
  button.danger { border-color: var(--danger); color: var(--danger); }
  .weapons { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
  .weapon { padding: 6px 0; text-align: center; }
  select { width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 5px 6px; }

  .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 10px; font-variant-numeric: tabular-nums; }
  .stats div { display: flex; justify-content: space-between; gap: 8px; }
  .stats span:first-child { color: var(--muted); }

  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  td { padding: 2px 0; vertical-align: top; }
  .keycap { color: var(--accent); white-space: nowrap; padding-right: 10px; font-weight: 600; }

  label.toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px; }
  #log {
    font: 10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted);
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 6px; height: 62px; overflow: auto; white-space: pre-wrap; word-break: break-word;
  }
  details > summary { cursor: pointer; color: var(--muted); font-size: 11px; margin-bottom: 4px; }
  .wad { font-size: 10px; color: var(--muted); }
</style>
</head>
<body>
  <h1><span class="dot" id="dot"></span>DOOM</h1>
  <div class="sub" id="status">booting…</div>

  <div id="focus" tabindex="0">Click here to capture the keyboard</div>

  <section class="row">
    <button class="primary" id="toggle">Start</button>
    <button id="fit">Fit screen</button>
    <button id="full">Fullscreen</button>
  </section>

  <section>
    <div class="label">Weapons</div>
    <div class="weapons">${weaponButtons}</div>
  </section>

  <section>
    <div class="label">Actions</div>
    <div class="row">
      <button data-hold="FIRE">Fire</button>
      <button data-hold="USE">Use</button>
      <button data-tap="TAB">Map</button>
      <button data-tap="ESCAPE">Menu</button>
      <button data-tap="ENTER">Enter</button>
    </div>
  </section>

  <section>
    <div class="label">Display</div>
    <select id="mode">
      <option value="shapes">Shape grid — one rectangle per pixel</option>
      <option value="ascii">ASCII — one text element per row</option>
      <option value="image">Full resolution — 640 x 400</option>
    </select>
    <div id="imageOnly" style="margin-top:6px">
      <label class="toggle" style="justify-content:space-between">
        <span>Image quality <b id="qval">82</b></span>
        <input type="range" id="quality" min="40" max="100" step="2" value="82" style="flex:1 1 90px" />
      </label>
    </div>
    <div id="asciiOnly" hidden>
      <select id="ramp" style="margin-top:6px">${rampOptions}</select>
      <label class="toggle" style="justify-content:space-between;margin-top:6px">
        <span>Columns <b id="cval">160</b></span>
        <input type="range" id="cols" min="40" max="640" step="8" value="160" style="flex:1 1 90px" />
      </label>
      <label class="toggle" style="justify-content:space-between;margin-top:4px">
        <span>Brightness <b id="gval">0.62</b></span>
        <input type="range" id="gamma" min="30" max="150" step="2" value="62" style="flex:1 1 90px" />
      </label>
      <label class="toggle" style="justify-content:space-between;margin-top:4px">
        <span>Contrast <b id="ctval">1.35</b></span>
        <input type="range" id="contrast" min="50" max="300" step="5" value="135" style="flex:1 1 90px" />
      </label>
      <label class="toggle" style="justify-content:space-between;margin-top:4px">
        <span>Glyph width <b id="adval">auto</b></span>
        <input type="range" id="advance" min="0" max="120" step="1" value="0" style="flex:1 1 90px" />
      </label>
      <label class="toggle" style="margin-top:6px"><input type="checkbox" id="fillDark" /> Fill dark areas (slower)</label>
      <div class="wad" id="fontNote"></div>
    </div>
    <div id="gridOnly">
      <select id="res" style="margin-top:6px">${resolutionOptions}</select>
      <select id="palette" style="margin-top:6px">${paletteOptions}</select>
      <label class="toggle" id="shadesRow" style="justify-content:space-between;margin-top:6px" hidden>
        <span>Shades <b id="sval">24</b></span>
        <input type="range" id="shades" min="2" max="48" step="1" value="24" style="flex:1 1 90px" />
      </label>
    </div>
    <div class="row" style="margin-top:6px">
      <button id="probe">Diagnose display</button>
      <button id="probeClear">Clear probes</button>
    </div>
    <div class="row" style="margin-top:6px">
      <label class="toggle"><input type="checkbox" id="wasd" checked /> WASD</label>
      <label class="toggle"><input type="checkbox" id="mouse" /> Mouse steer</label>
      <label class="toggle"><input type="checkbox" id="auto" checked /> Auto quality</label>
    </div>
  </section>

  <section class="stats" id="stats">
    <div><span>fps</span><span id="s-fps">–</span></div>
    <div><span>tics</span><span id="s-tics">–</span></div>
    <div><span id="s-cells-label">cells/frame</span><span id="s-cells">–</span></div>
    <div><span>grid</span><span id="s-grid">–</span></div>
    <div><span>draw</span><span id="s-budget">–</span></div>
    <div><span>encode</span><span id="s-encode">–</span></div>
    <div><span>keys held</span><span id="s-keys">–</span></div>
  </section>

  <details>
    <summary>Controls (board keyboard)</summary>
    <table>${controlRows}</table>
    <div class="wad" style="margin-top:6px">
      With the console focused: <b>WASD</b> move and strafe, <b>Space</b> or <b>Ctrl</b> shoot,
      <b>E</b> or <b>F</b> opens doors, <b>1</b>–<b>7</b> pick weapons, <b>,</b> <b>.</b> strafe.
    </div>
  </details>

  <details>
    <summary>Load a different WAD</summary>
    <input type="file" id="wad" accept=".wad,.WAD" />
    <div class="wad">Shareware DOOM is built in. Point this at DOOM.WAD, DOOM2.WAD or freedoom.wad to play that instead — the game restarts.</div>
  </details>

  <details open>
    <summary>Engine log</summary>
    <div id="log"></div>
  </details>

<script>
(function () {
  var api = typeof acquireDrawdyApi === "function" ? acquireDrawdyApi() : null;
  var post = function (message) { if (api) api.postMessage(message); };

  var byId = function (id) { return document.getElementById(id); };
  var focusBox = byId("focus");
  var logBox = byId("log");
  var captured = false;
  // Space and the arrows scroll a page; while we hold the keyboard, they must not.
  window.addEventListener("keydown", function (event) {
    if (!captured) return;
    if (event.key === " " || event.key.indexOf("Arrow") === 0 || event.key === "Tab") event.preventDefault();
  }, { capture: true, passive: false });
  var running = false;

  // ---- keyboard -----------------------------------------------------------
  // Symbolic names only; the driver owns the numeric DOOM key values.
  var NAMED = {
    ArrowLeft: "LEFTARROW", ArrowRight: "RIGHTARROW", ArrowUp: "UPARROW", ArrowDown: "DOWNARROW",
    // Space shoots. Vanilla DOOM opens doors with it, but every shooter since
    // has shot with it, and the board's own scheme already does — one key
    // should not mean two things depending on where the focus is.
    Control: "FIRE", " ": "FIRE", Shift: "SHIFT", Tab: "TAB", Escape: "ESCAPE",
    Enter: "ENTER", Backspace: "BACKSPACE", Alt: "ALT", ",": "STRAFE_L", ".": "STRAFE_R"
  };
  // Use moves to E and F, where a modern player will reach for it anyway.
  var WASD = { w: "UPARROW", s: "DOWNARROW", a: "STRAFE_L", d: "STRAFE_R", e: "USE", f: "USE" };

  function translate(event) {
    if (byId("wasd").checked) {
      var lower = event.key.length === 1 ? event.key.toLowerCase() : "";
      if (WASD[lower]) return { name: WASD[lower] };
    }
    if (NAMED[event.key]) return { name: NAMED[event.key] };
    if (event.key.length === 1) return { ascii: event.key.toLowerCase().charCodeAt(0) };
    return null;
  }

  function onKey(event, down) {
    if (!captured) return;
    var key = translate(event);
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat && down) return; // DOOM tracks the hold itself
    key.t = down ? "kd" : "ku";
    post(key);
  }

  window.addEventListener("keydown", function (e) { onKey(e, true); }, true);
  window.addEventListener("keyup", function (e) { onKey(e, false); }, true);

  function setCaptured(next) {
    if (captured === next) return;
    captured = next;
    focusBox.classList.toggle("live", captured);
    focusBox.textContent = captured
      ? "Keyboard captured — click the board to release"
      : "Click here to capture the keyboard";
    post({ t: "focus", on: captured });
  }

  focusBox.addEventListener("click", function () { focusBox.focus(); setCaptured(true); });
  focusBox.addEventListener("focus", function () { setCaptured(true); });
  focusBox.addEventListener("blur", function () { setCaptured(false); });
  window.addEventListener("blur", function () { setCaptured(false); });

  // ---- buttons ------------------------------------------------------------
  byId("toggle").addEventListener("click", function () { post({ t: "cmd", id: running ? "stop" : "start" }); });
  byId("fit").addEventListener("click", function () { post({ t: "cmd", id: "fit" }); });
  byId("full").addEventListener("click", function () { post({ t: "cmd", id: "fullscreen" }); });

  Array.prototype.forEach.call(document.querySelectorAll(".weapon"), function (button) {
    button.addEventListener("click", function () {
      post({ t: "weapon", slot: Number(button.dataset.slot) });
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll("[data-hold]"), function (button) {
    var name = button.dataset.hold;
    var down = function (e) { e.preventDefault(); post({ t: "kd", name: name }); };
    var up = function () { post({ t: "ku", name: name }); };
    button.addEventListener("pointerdown", down);
    button.addEventListener("pointerup", up);
    button.addEventListener("pointerleave", up);
    button.addEventListener("pointercancel", up);
  });

  Array.prototype.forEach.call(document.querySelectorAll("[data-tap]"), function (button) {
    button.addEventListener("click", function () { post({ t: "tap", name: button.dataset.tap }); });
  });

  byId("res").addEventListener("change", function (e) { post({ t: "set", key: "resolution", value: e.target.value }); });
  byId("mode").addEventListener("change", function (e) { post({ t: "set", key: "displayMode", value: e.target.value }); });
  byId("palette").addEventListener("change", function (e) { post({ t: "set", key: "palette", value: e.target.value }); });
  byId("ramp").addEventListener("change", function (e) { post({ t: "set", key: "asciiRamp", value: e.target.value }); });
  byId("fillDark").addEventListener("change", function (e) { post({ t: "set", key: "fillDark", value: e.target.checked }); });
  byId("contrast").addEventListener("change", function (e) { post({ t: "set", key: "asciiContrast", value: Number(e.target.value) / 100 }); });
  byId("contrast").addEventListener("input", function (e) { byId("ctval").textContent = (Number(e.target.value) / 100).toFixed(2); });
  byId("advance").addEventListener("change", function (e) { post({ t: "set", key: "asciiAdvance", value: Number(e.target.value) / 100 }); });
  byId("advance").addEventListener("input", function (e) {
    byId("adval").textContent = Number(e.target.value) === 0 ? "auto" : (Number(e.target.value) / 100).toFixed(2);
  });
  byId("cols").addEventListener("change", function (e) { post({ t: "set", key: "asciiCols", value: Number(e.target.value) }); });
  byId("cols").addEventListener("input", function (e) { byId("cval").textContent = e.target.value; });
  byId("gamma").addEventListener("change", function (e) { post({ t: "set", key: "asciiGamma", value: Number(e.target.value) / 100 }); });
  byId("gamma").addEventListener("input", function (e) { byId("gval").textContent = (Number(e.target.value) / 100).toFixed(2); });
  byId("shades").addEventListener("change", function (e) { post({ t: "set", key: "shades", value: Number(e.target.value) }); });
  byId("shades").addEventListener("input", function (e) { byId("sval").textContent = e.target.value; });
  byId("probe").addEventListener("click", function () { post({ t: "cmd", id: "probe" }); });
  byId("probeClear").addEventListener("click", function () { post({ t: "cmd", id: "probe-clear" }); });
  byId("quality").addEventListener("change", function (e) {
    post({ t: "set", key: "imageQuality", value: Number(e.target.value) / 100 });
  });
  byId("quality").addEventListener("input", function (e) { byId("qval").textContent = e.target.value; });
  byId("mouse").addEventListener("change", function (e) { post({ t: "set", key: "mouseLook", value: e.target.checked }); });
  byId("auto").addEventListener("change", function (e) { post({ t: "set", key: "autoQuality", value: e.target.checked }); });

  byId("wad").addEventListener("change", function (event) {
    var file = event.target.files && event.target.files[0];
    if (!file) return;
    file.arrayBuffer().then(function (buffer) {
      post({ t: "wad", name: file.name, bytes: buffer }, [buffer]);
    });
  });

  // ---- incoming state -----------------------------------------------------
  function appendLog(line) {
    logBox.textContent += line + "\\n";
    if (logBox.textContent.length > 8000) logBox.textContent = logBox.textContent.slice(-6000);
    logBox.scrollTop = logBox.scrollHeight;
  }

  if (api) {
    api.onMessage(function (message) {
      if (!message || typeof message !== "object") return;
      if (message.t === "log") { appendLog(message.line); return; }
      if (message.t !== "state") return;

      running = !!message.running;
      byId("toggle").textContent = running ? "Stop" : "Start";
      byId("dot").className = "dot" + (message.crashed ? " err" : running ? " on" : "");
      byId("status").textContent = message.status || "";
      byId("s-fps").textContent = message.fps != null ? message.fps.toFixed(1) : "–";
      byId("s-tics").textContent = message.tics != null ? String(message.tics) : "–";
      byId("s-cells").textContent = message.cells != null ? String(message.cells) : "–";
      byId("s-grid").textContent = message.grid || "–";
      byId("s-budget").textContent = message.budgetMs != null ? message.budgetMs.toFixed(1) + " ms" : "–";
      byId("s-encode").textContent = message.encodeMs ? message.encodeMs.toFixed(1) + " ms" : "–";
      byId("s-cells-label").textContent = message.displayMode === "ascii" ? "rows/frame" : "cells/frame";
      if (message.displayMode && byId("mode").value !== message.displayMode) byId("mode").value = message.displayMode;
      var isImage = message.displayMode === "image";
      var isAscii = message.displayMode === "ascii";
      byId("imageOnly").hidden = !isImage;
      byId("asciiOnly").hidden = !isAscii;
      byId("gridOnly").hidden = isImage || isAscii;
      if (message.asciiRamp && byId("ramp").value !== message.asciiRamp) byId("ramp").value = message.asciiRamp;
      if (message.asciiCols && Number(byId("cols").value) !== message.asciiCols) {
        byId("cols").value = String(message.asciiCols);
        byId("cval").textContent = String(message.asciiCols);
      }
      byId("fontNote").textContent = message.measurable
        ? "font " + (message.font || "?") + "  ·  ramp " + (message.ramp || "?")
        : "this board will not measure text — set Glyph width by eye if rows change length";
      if (typeof message.fillDark === "boolean") byId("fillDark").checked = message.fillDark;
      if (message.asciiContrast && Number(byId("contrast").value) !== Math.round(message.asciiContrast * 100)) {
        byId("contrast").value = String(Math.round(message.asciiContrast * 100));
        byId("ctval").textContent = message.asciiContrast.toFixed(2);
      }
      if (message.palette && byId("palette").value !== message.palette) byId("palette").value = message.palette;
      byId("shadesRow").hidden = !message.palette || message.palette === "color";
      if (message.shades && Number(byId("shades").value) !== message.shades) {
        byId("shades").value = String(message.shades);
        byId("sval").textContent = String(message.shades);
      }
      byId("s-keys").textContent = message.keys != null ? String(message.keys) : "–";
      if (message.resolution && byId("res").value !== message.resolution) byId("res").value = message.resolution;
      if (typeof message.mouseLook === "boolean") byId("mouse").checked = message.mouseLook;
      if (typeof message.autoQuality === "boolean") byId("auto").checked = message.autoQuality;
    });
  }

  post({ t: "ready" });
})();
</script>
</body>
</html>`;
}
