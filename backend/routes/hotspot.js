/**
 * routes/hotspot.js
 * ---------------------------------------------------------------------------
 *  POST  /api/hotspot/pay                  → start CamPay collection
 *  GET   /api/hotspot/payment-status/:ref  → poll status; create MT user on success
 *  GET   /api/hotspot/success              → redirect helper for portal page
 *  GET   /api/hotspot/bundles              → public bundle catalog (display)
 *
 * Transactions are kept in a simple in-memory Map. For production, replace
 * `store` with a real DB (SQLite/Postgres/Redis) — the surface area is small.
 * ---------------------------------------------------------------------------
 */

const express = require("express");
const router  = express.Router();

const { getBundle, listBundles } = require("../data/bundles");
const campay   = require("../services/campayService");
const mikrotik = require("../services/mikrotikService");
const receipts = require("../services/receiptService");

/* -------------------------------------------------------------------------
 * In-memory transaction store. Schema:
 *   {
 *     reference, externalReference, phone, bundleId, amount,
 *     status: "pending"|"success"|"failed",
 *     createdAt, completedAt,
 *     username, password, receipt,
 *     mac, ip,
 *     provisioned: bool
 *   }
 * ------------------------------------------------------------------------- */
const store = new Map();

/* ---------- helpers ---------- */

function validatePhoneServer(phone) {
    if (typeof phone !== "string") return false;
    if (!/^\d{12}$/.test(phone))   return false;
    if (!phone.startsWith("237"))  return false;
    return /^6\d{8}$/.test(phone.slice(3));
}

function sendError(res, httpStatus, code, message) {
    return res.status(httpStatus).json({ status: "error", code, message });
}

/* -------------------------------------------------------------------------
 * GET /api/hotspot/bundles   (optional — handy for clients)
 * ------------------------------------------------------------------------- */
router.get("/bundles", (req, res) => {
    res.json({ bundles: listBundles() });
});

/* -------------------------------------------------------------------------
 * POST /api/hotspot/pay
 *  body: { bundle_id, phone, mac?, ip?, link_login?, link_login_only?, link_orig? }
 * ------------------------------------------------------------------------- */
router.post("/pay", async (req, res) => {
    const {
        bundle_id, phone,
        mac, ip,
        link_login, link_login_only, link_orig
    } = req.body || {};

    // ----- validation -----
    const bundle = getBundle(bundle_id);
    if (!bundle)                       return sendError(res, 400, "ER201", "Unknown bundle.");
    if (!validatePhoneServer(phone))   return sendError(res, 400, "ER101", "Invalid phone number. Use 237XXXXXXXXX.");

    // ----- optional carrier check -----
    try {
        const info = await campay.getHolderInfo(phone);
        if (info && info.operator) {
            const op = String(info.operator).toLowerCase();
            if (op.indexOf("mtn") === -1 && op.indexOf("orange") === -1) {
                return sendError(res, 400, "ER102", "Unsupported carrier. Only MTN and Orange Cameroon are supported.");
            }
        }
    } catch (_) { /* non-fatal */ }

    // ----- create our reference & call CamPay -----
    const externalRef = "HAYLO-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();

    let campayRes;
    try {
        campayRes = await campay.createCollect({
            amount:            bundle.price,
            from:              phone,
            description:       (process.env.ISP_NAME || "HAYLO INTERNET") + " — " + bundle.name,
            externalReference: externalRef
        });
    } catch (err) {
        const data = (err.response && err.response.data) || {};
        console.error("[pay] campay collect failed:", err.response && err.response.status, data);
        if (data && data.code && /balance/i.test(JSON.stringify(data))) {
            return sendError(res, 402, "ER301", "Insufficient balance on your mobile money account.");
        }
        return sendError(res, 502, "ER201", data.message || "Could not start payment. Please try again.");
    }

    const reference = campayRes && campayRes.reference;
    if (!reference) {
        return sendError(res, 502, "ER201", "Payment provider did not return a reference.");
    }

    // ----- persist -----
    store.set(reference, {
        reference,
        externalReference: externalRef,
        phone,
        bundleId:    bundle.id,
        amount:      bundle.price,
        status:      "pending",
        createdAt:   new Date().toISOString(),
        completedAt: null,
        username:    null,
        password:    null,
        receipt:     null,
        mac:         mac || null,
        ip:          ip  || null,
        links:       { link_login, link_login_only, link_orig },
        provisioned: false
    });

    return res.json({
        status:    "pending",
        reference,
        message:   "Confirm the prompt on your phone to complete payment.",
        ussd_code: campayRes.ussd_code || null,
        operator:  campayRes.operator  || null
    });
});

/* -------------------------------------------------------------------------
 * GET /api/hotspot/payment-status/:reference
 *
 * Polls CamPay; on first SUCCESSFUL response, provisions a MikroTik user
 * (idempotently) and returns full credentials + bundle details.
 * ------------------------------------------------------------------------- */
router.get("/payment-status/:reference", async (req, res) => {
    const reference = req.params.reference;
    const tx = store.get(reference);
    if (!tx) return sendError(res, 404, "ER201", "Unknown transaction reference.");

    // If we've already finalized this transaction, return the cached result.
    if (tx.status === "success" && tx.provisioned) {
        return res.json(buildSuccessPayload(tx));
    }
    if (tx.status === "failed") {
        return res.json({ status: "failed", reference, message: "Payment was not completed." });
    }

    // Query CamPay
    let status;
    try {
        const data = await campay.getTransactionStatus(reference);
        status = (data && data.status) || "PENDING";
    } catch (err) {
        console.warn("[status] campay status failed:", err.response && err.response.status);
        return res.json({ status: "pending", reference });
    }

    const norm = String(status).toUpperCase();

    if (norm === "SUCCESSFUL") {
        // Provision once.
        if (!tx.provisioned) {
            const bundle   = getBundle(tx.bundleId);
            const username = mikrotik.generateUsername();
            const password = mikrotik.generatePassword();
            const comment  = "phone:" + tx.phone + " ref:" + tx.reference;

            const mt = await mikrotik.createHotspotUser({
                username, password,
                profile: bundle.profile,
                comment
            });

            if (!mt.ok) {
                // Don't lose the payment — mark success but flag for support.
                tx.status      = "success";
                tx.completedAt = new Date().toISOString();
                tx.username    = username;
                tx.password    = password;
                tx.receipt     = receipts.generateReceiptNumber();
                tx.provisioned = false;
                console.error("[status] MikroTik provisioning failed for ref", reference, mt.error);
                return res.status(500).json({
                    status:  "error",
                    code:    "ER999",
                    message: "Payment succeeded but account creation failed. Contact support with reference: " + reference,
                    reference
                });
            }

            tx.status      = "success";
            tx.completedAt = new Date().toISOString();
            tx.username    = username;
            tx.password    = password;
            tx.receipt     = receipts.generateReceiptNumber();
            tx.provisioned = true;
        }
        return res.json(buildSuccessPayload(tx));
    }

    if (norm === "FAILED" || norm === "CANCELLED") {
        tx.status      = "failed";
        tx.completedAt = new Date().toISOString();
        return res.json({ status: "failed", reference, message: "Payment was not completed." });
    }

    // PENDING / anything else
    return res.json({ status: "pending", reference });
});

/* -------------------------------------------------------------------------
 * GET /api/hotspot/success?reference=...
 * Optional helper: redirects user back to the MikroTik hotspot login page
 * with credentials in the query string (useful for SMS / external callers).
 * ------------------------------------------------------------------------- */
router.get("/success", (req, res) => {
    const reference = req.query.reference;
    const tx = reference && store.get(reference);
    if (!tx || tx.status !== "success" || !tx.username) {
        return res.status(404).send("Transaction not found or not yet successful.");
    }
    const hotspotUrl = process.env.HOTSPOT_LOGIN_URL || "http://10.5.50.1/login";
    const bundle     = getBundle(tx.bundleId) || {};
    const params = new URLSearchParams({
        paid:      "true",
        username:  tx.username,
        password:  tx.password,
        bundle:    bundle.name     || "",
        amount:    String(tx.amount || ""),
        duration:  bundle.duration || "",
        speed:     bundle.speed    || "",
        reference: tx.reference,
        receipt:   tx.receipt      || "",
        mac:       tx.mac || "",
        ip:        tx.ip  || ""
    });
    return res.redirect(hotspotUrl + "?" + params.toString());
});

/* -------------------------------------------------------------------------
 * helpers
 * ------------------------------------------------------------------------- */
function buildSuccessPayload(tx) {
    const bundle = getBundle(tx.bundleId) || {};
    return {
        status:    "success",
        reference: tx.reference,
        receipt:   tx.receipt,
        username:  tx.username,
        password:  tx.password,
        bundle:    bundle.name,
        amount:    tx.amount,
        duration:  bundle.duration,
        speed:     bundle.speed,
        mac:       tx.mac,
        ip:        tx.ip,
        date:      tx.completedAt
    };
}

module.exports = router;
