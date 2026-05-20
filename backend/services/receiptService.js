/**
 * services/receiptService.js
 * ---------------------------------------------------------------------------
 * Tiny helper that produces a human-readable receipt number.
 * Format: RCPT-YYYYMMDD-XXXXXX  (e.g. RCPT-20251104-7F3A2C)
 * ---------------------------------------------------------------------------
 */

function pad(n) { return n < 10 ? "0" + n : "" + n; }

function generateReceiptNumber() {
    const d = new Date();
    const datePart = "" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
    let rand = "";
    const chars = "ABCDEF0123456789";
    for (let i = 0; i < 6; i++) rand += chars[Math.floor(Math.random() * chars.length)];
    return "RCPT-" + datePart + "-" + rand;
}

module.exports = { generateReceiptNumber };
