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
const offerService = require("../services/offerService");

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
    const profiles = await mikrotik.getHotspotProfiles({ force: true });
    const offers = offerService.getAllOffers();
    const mapped = profiles.map(profile => {
        const offer = offers.find(o => o.profile === profile);
        if (offer) {
            return { profile, mapped: true, offer };
        } else {
            return { profile, mapped: false };
        }
    });
    res.json({ status: "success", profiles: mapped });
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

/* ---------- CRUD endpoints for offers ---------- */
// GET all offers
router.get("/api/offers", (_req, res) => {
    res.json({ status: "success", offers: offerService.getAllOffers() });
});
// POST create or update offer
router.post("/api/offers/:profile", express.json(), (req, res) => {
    const profile = req.params.profile;
    const offer = req.body && req.body.offer;
    if (!offer || typeof offer !== "object") {
        return res.status(400).json({ status: "error", message: "Body must be {offer: {...}}." });
    }
    offer.profile = profile;
    offerService.upsertOffer(offer);
    res.json({ status: "success", offer: offerService.getOfferByProfile(profile) });
});
// DELETE offer
router.delete("/api/offers/:profile", (req, res) => {
    const profile = req.params.profile;
    offerService.deleteOffer(profile);
    res.json({ status: "success", deleted: profile });
});

/* ---------- HTML page ---------- */
router.get("/", (_req, res) => {
    res.type("html").send(ADMIN_HTML);
});

// Ensure a request to /admin (no slash) reaches the page rather than 404ing.
router.get("", (_req, res) => res.redirect("/admin/"));

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
  tr.mapped td:first-child::before { content: "● "; color: #2f9e44; }
  tr.unmapped td:first-child::before { content: "● "; color: #adb5bd; }
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
  <div class="sub">Edit price/name/description for each MikroTik hotspot profile. Saving updates the offer in the database.</div>
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
        <th>Active</th>
        <th class="actions">Actions</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
  <div class="legend">
    Green dot = mapped (has an active offer). Grey dot = unmapped (no offer for this profile).<br>
    Save to create/update an offer. Hide to remove the offer for this profile.
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
        return ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c];
    });
}
async function load() {
    status.textContent = "Loading…";
    tbody.innerHTML = "";
    let data;
    try {
        const r = await fetch("/admin/api/profiles", { headers: { "Accept": "application/json" } });
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
    const o  = p.offer || {};
    const tr = document.createElement("tr");
    tr.className = p.mapped ? "mapped" : "unmapped";
    tr.innerHTML =
        '<td><strong>' + escapeHtml(p.profile) + '</strong></td>' +
        '<td><input type="text"   data-k="name"        value="' + escapeHtml(o.name || "") + '" placeholder="' + escapeHtml(p.profile) + '"></td>' +
        '<td><input type="number" data-k="price" class="price" value="' + (o.price != null ? Number(o.price) : "") + '" min="0" step="1" placeholder="(hidden)"></td>' +
        '<td><input type="text"   data-k="description" value="' + escapeHtml(o.description || "") + '" placeholder="optional"></td>' +
        '<td><input type="text"   data-k="speed"    class="short" value="' + escapeHtml(o.speed || "")    + '" placeholder="Mbps"></td>' +
        '<td><input type="text"   data-k="duration" class="short" value="' + escapeHtml(o.duration || "") + '" placeholder="e.g. 1d"></td>' +
        '<td><input type="checkbox" data-k="active" ' + (o.active ? 'checked' : '') + '></td>' +
        '<td class="actions">' +
            '<button class="primary" data-act="save">Save</button> ' +
            '<button class="danger"  data-act="hide">Hide</button>' +
        '</td>';
    tr.querySelector('[data-act="save"]').addEventListener("click", function () { save(tr, p.profile); });
    tr.querySelector('[data-act="hide"]').addEventListener("click", function () { hide(tr, p.profile); });
    return tr;
}
function collect(tr) {
    const obj = {};
    tr.querySelectorAll("[data-k]").forEach(function (el) {
        const k = el.getAttribute("data-k");
        if (el.type === "checkbox") {
            obj[k] = el.checked ? 1 : 0;
        } else {
            const v = el.value.trim();
            if (v !== "") obj[k] = v;
        }
    });
    return obj;
}
async function save(tr, profile) {
    const offer = collect(tr);
    if (!offer.price) {
        showToast("Set a price, or click Hide.", "err");
        return;
    }
    try {
        const r = await fetch("/admin/api/offers/" + encodeURIComponent(profile), {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ offer })
        });
        const j = await r.json().catch(function () { return {}; });
        if (!r.ok || j.status !== "success") throw new Error(j.message || ("HTTP " + r.status));
        showToast("Saved " + profile, "ok");
        await load();
    } catch (e) {
        showToast("Save failed: " + e.message, "err");
    }
}
async function hide(tr, profile) {
    if (!confirm("Hide offer for '" + profile + "'? This will remove it from sale.")) return;
    try {
        const r = await fetch("/admin/api/offers/" + encodeURIComponent(profile), {
            method:  "DELETE"
        });
        const j = await r.json().catch(function () { return {}; });
        if (!r.ok || j.status !== "success") throw new Error(j.message || ("HTTP " + r.status));
        showToast("Hidden " + profile, "ok");
        await load();
    } catch (e) {
        showToast("Hide failed: " + e.message, "err");
    }
}
load();
</script>
</body>
</html>
`;

module.exports = router;
