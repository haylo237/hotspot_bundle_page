/**
 * routes/admin.js
 * ---------------------------------------------------------------------------
 * Tiny password-protected admin UI for editing bundle metadata that lives
 * in each MikroTik hotspot profile's `comment` field.
 *
 *   GET  /admin/                  → HTML page
 *   GET  /admin/api/profiles      → JSON list of profiles + parsed meta
 *   POST /admin/api/profiles/:name {meta: {...} | null}   → write JSON
 *                                                          (null = clear comment,
 *                                                           hides the offer)
 *
 * Auth: HTTP Basic, single password from env `ADMIN_PASSWORD`.
 *       Username may be anything; password must match. If `ADMIN_PASSWORD`
 *       is unset the entire /admin namespace is disabled (returns 503).
 * ---------------------------------------------------------------------------
 */

const express  = require("express");
const router   = express.Router();
const mikrotik = require("../services/mikrotikService");

/* ---------- auth ---------- */

function basicAuth(req, res, next) {
    const pass = process.env.ADMIN_PASSWORD;
    if (!pass) {
        return res.status(503).type("text/plain").send(
            "Admin disabled. Set ADMIN_PASSWORD in .env and restart the backend."
        );
    }
    const hdr = req.headers.authorization || "";
    if (hdr.indexOf("Basic ") === 0) {
        try {
            const decoded = Buffer.from(hdr.slice(6), "base64").toString("utf8");
            const idx = decoded.indexOf(":");
            const supplied = idx === -1 ? decoded : decoded.slice(idx + 1);
            if (supplied === pass) return next();
        } catch (_) { /* fall through */ }
    }
    res.set("WWW-Authenticate", 'Basic realm="HAYLO Admin"');
    res.status(401).type("text/plain").send("Authentication required.");
}

router.use(basicAuth);

/* ---------- API: list profiles + parsed metadata ---------- */
router.get("/api/profiles", async (_req, res) => {
    const rows = await mikrotik.getRawProfiles({ force: true });
    const data = rows.map(r => {
        const meta = mikrotik.parseProfileMeta(r.comment);
        return {
            name:            r.name,
            "rate-limit":    r["rate-limit"]     || "",
            "session-timeout": r["session-timeout"] || "",
            default_speed:   mikrotik.formatRate(r["rate-limit"]) || "",
            default_duration: r["session-timeout"] || "",
            raw_comment:     r.comment || "",
            meta:            meta,
            saleable:        !!meta && Number.isFinite(Number(meta && meta.price))
        };
    });
    res.json({ status: "success", profiles: data });
});

/* ---------- API: save metadata for a profile ---------- */
router.post("/api/profiles/:name", express.json(), async (req, res) => {
    const name = req.params.name;
    const meta = (req.body && req.body.meta);

    // Clearing the comment hides the offer entirely.
    if (meta === null) {
        const out = await mikrotik.setProfileComment(name, "");
        if (!out.ok) return res.status(500).json({ status: "error", message: out.error });
        return res.json({ status: "success", cleared: true });
    }

    if (!meta || typeof meta !== "object") {
        return res.status(400).json({ status: "error", message: "Body must be {meta: {...} | null}." });
    }
    const price = Number(meta.price);
    if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({ status: "error", message: "meta.price must be a number >= 0." });
    }

    // Build a clean, minimal JSON blob (drop empty / undefined values).
    const clean = { price };
    ["id", "name", "description", "speed", "duration"].forEach(k => {
        if (meta[k] !== undefined && meta[k] !== null && String(meta[k]).trim() !== "") {
            clean[k] = String(meta[k]);
        }
    });
    if (meta.order !== undefined && meta.order !== "" && Number.isFinite(Number(meta.order))) {
        clean.order = Number(meta.order);
    }
    if (meta.hidden === true) clean.hidden = true;

    const out = await mikrotik.setProfileComment(name, JSON.stringify(clean));
    if (!out.ok) return res.status(500).json({ status: "error", message: out.error });
    res.json({ status: "success", written: clean });
});

/* ---------- HTML page ---------- */
router.get("/", (_req, res) => {
    res.type("html").send(ADMIN_HTML);
});

const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HAYLO — Bundle Admin</title>
<style>
  * { box-sizing: border-box; }
  body { font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         margin: 0; background: #f4f6f8; color: #1f2933; }
  header { background: #1f2933; color: #fff; padding: 16px 24px; }
  header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  header .sub { font-size: 12px; opacity: .7; margin-top: 4px; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px; }
  .toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; }
  button { font: inherit; padding: 8px 14px; border: 1px solid #1f2933;
           background: #fff; border-radius: 6px; cursor: pointer; }
  button.primary { background: #1f2933; color: #fff; }
  button:disabled { opacity: .5; cursor: wait; }
  .status { font-size: 12px; color: #52606d; }
  table { width: 100%; border-collapse: collapse; background: #fff;
          box-shadow: 0 1px 2px rgba(0,0,0,.06); border-radius: 8px; overflow: hidden; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #e4e7eb;
           vertical-align: middle; font-size: 13px; }
  th { background: #f0f3f6; font-weight: 600; font-size: 12px;
       text-transform: uppercase; letter-spacing: .04em; color: #52606d; }
  tr.saleable td:first-child::before { content: "● "; color: #2f9e44; }
  tr.hidden td:first-child::before    { content: "● "; color: #adb5bd; }
  input[type=text], input[type=number] {
        font: inherit; padding: 6px 8px; border: 1px solid #cbd2d9;
        border-radius: 4px; background: #fff; width: 100%; }
  input.price { width: 90px; }
  input.short { width: 90px; }
  td.actions { white-space: nowrap; }
  td.actions button { padding: 6px 10px; font-size: 12px; }
  .danger { color: #b91c1c; border-color: #b91c1c; background: #fff; }
  .legend { font-size: 12px; color: #52606d; margin-top: 12px; }
  .legend code { background: #e4e7eb; padding: 1px 4px; border-radius: 3px; }
  .toast { position: fixed; bottom: 24px; right: 24px; padding: 12px 18px;
           border-radius: 6px; color: #fff; font-size: 13px; box-shadow: 0 4px 12px rgba(0,0,0,.15);
           transition: opacity .3s; opacity: 0; pointer-events: none; }
  .toast.show { opacity: 1; }
  .toast.ok    { background: #2f9e44; }
  .toast.err   { background: #c92a2a; }
  .placeholder { color: #9aa5b1; font-style: italic; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>HAYLO — Bundle Admin</h1>
  <div class="sub">Edit price/name/description for each MikroTik hotspot profile. Saving writes JSON into the profile's <code>comment</code>.</div>
</header>
<main>
  <div class="toolbar">
    <button id="reload" class="primary">Reload from MikroTik</button>
    <span id="status" class="status">Loading…</span>
  </div>
  <table>
    <thead>
      <tr>
        <th>Profile</th>
        <th>Display name</th>
        <th>Price (XAF)</th>
        <th>Description</th>
        <th>Speed</th>
        <th>Duration</th>
        <th>Order</th>
        <th class="actions">Actions</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
  <div class="legend">
    Green dot = saleable (has a valid JSON metadata comment).
    Grey dot = hidden from the captive portal (no metadata).
    Save with empty Price → <strong>Hide</strong> button to remove the metadata entirely.
    Defaults shown in light text come from the profile's <code>rate-limit</code> / <code>session-timeout</code>.
  </div>
</main>
<div id="toast" class="toast"></div>

<script>
const tbody  = document.getElementById("tbody");
const status = document.getElementById("status");
const toast  = document.getElementById("toast");
document.getElementById("reload").addEventListener("click", load);

function showToast(msg, kind) {
    toast.textContent = msg;
    toast.className   = "toast show " + (kind || "ok");
    setTimeout(function () { toast.className = "toast " + (kind || "ok"); }, 2500);
}

function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"})[c];
    });
}

async function load() {
    status.textContent = "Loading…";
    tbody.innerHTML = "";
    let data;
    try {
        const r = await fetch("./api/profiles", { headers: { "Accept": "application/json" } });
        if (!r.ok) throw new Error("HTTP " + r.status);
        data = await r.json();
    } catch (e) {
        status.textContent = "Failed: " + e.message;
        showToast("Failed to load profiles", "err");
        return;
    }
    const profiles = (data && data.profiles) || [];
    status.textContent = profiles.length + " profile(s) found.";
    if (!profiles.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:#7b8794">No profiles. Check MikroTik connectivity.</td></tr>';
        return;
    }
    profiles.forEach(function (p) { tbody.appendChild(renderRow(p)); });
}

function renderRow(p) {
    const m  = p.meta || {};
    const tr = document.createElement("tr");
    tr.className = p.saleable ? "saleable" : "hidden";
    tr.innerHTML =
        '<td><strong>' + escapeHtml(p.name) + '</strong>' +
            '<div class="placeholder">' + escapeHtml(p["rate-limit"] || "") +
            (p["session-timeout"] ? " · " + escapeHtml(p["session-timeout"]) : "") + '</div></td>' +
        '<td><input type="text"   data-k="name"        value="' + escapeHtml(m.name || "") + '" placeholder="' + escapeHtml(p.name) + '"></td>' +
        '<td><input type="number" data-k="price" class="price" value="' + (m.price != null ? Number(m.price) : "") + '" min="0" step="1" placeholder="(hidden)"></td>' +
        '<td><input type="text"   data-k="description" value="' + escapeHtml(m.description || "") + '" placeholder="optional"></td>' +
        '<td><input type="text"   data-k="speed"    class="short" value="' + escapeHtml(m.speed || "")    + '" placeholder="' + escapeHtml(p.default_speed) + '"></td>' +
        '<td><input type="text"   data-k="duration" class="short" value="' + escapeHtml(m.duration || "") + '" placeholder="' + escapeHtml(p.default_duration) + '"></td>' +
        '<td><input type="number" data-k="order"    class="short" value="' + (m.order != null ? Number(m.order) : "") + '" min="0" step="1" placeholder="auto"></td>' +
        '<td class="actions">' +
            '<button class="primary" data-act="save">Save</button> ' +
            '<button class="danger"  data-act="hide">Hide</button>' +
        '</td>';

    tr.querySelector('[data-act="save"]').addEventListener("click", function () { save(tr, p.name); });
    tr.querySelector('[data-act="hide"]').addEventListener("click", function () { hide(tr, p.name); });
    return tr;
}

function collect(tr) {
    const obj = {};
    tr.querySelectorAll("[data-k]").forEach(function (el) {
        const k = el.getAttribute("data-k");
        const v = el.value.trim();
        if (v !== "") obj[k] = v;
    });
    return obj;
}

async function send(tr, name, body, okMsg) {
    const btns = tr.querySelectorAll("button");
    btns.forEach(function (b) { b.disabled = true; });
    try {
        const r = await fetch("./api/profiles/" + encodeURIComponent(name), {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(body)
        });
        const j = await r.json().catch(function () { return {}; });
        if (!r.ok || j.status !== "success") throw new Error(j.message || ("HTTP " + r.status));
        showToast(okMsg, "ok");
        await load();
    } catch (e) {
        showToast("Save failed: " + e.message, "err");
    } finally {
        btns.forEach(function (b) { b.disabled = false; });
    }
}

function save(tr, name) {
    const meta = collect(tr);
    if (meta.price === undefined) {
        showToast("Set a price, or click Hide.", "err");
        return;
    }
    send(tr, name, { meta: meta }, "Saved " + name);
}

function hide(tr, name) {
    if (!confirm("Hide bundle '" + name + "'? This clears its comment.")) return;
    send(tr, name, { meta: null }, "Hidden " + name);
}

load();
</script>
</body>
</html>
`;

module.exports = router;
