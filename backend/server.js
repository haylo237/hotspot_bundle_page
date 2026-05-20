/**
 * server.js
 * ---------------------------------------------------------------------------
 * HAYLO INTERNET — backend entry point.
 *
 *   npm install
 *   cp .env.example .env   # then edit values
 *   npm start
 * ---------------------------------------------------------------------------
 */

require("dotenv").config();

const express = require("express");
const cors    = require("cors");

const hotspotRoutes = require("./routes/hotspot");

const app  = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

/* ---------- middleware ---------- */
app.use(cors());                          // captive portal is on a different origin
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

// Basic request log
app.use((req, _res, next) => {
    console.log(new Date().toISOString(), req.method, req.originalUrl);
    next();
});

/* ---------- health ---------- */
app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "haylo-hotspot-backend", time: new Date().toISOString() });
});

/* ---------- routes ---------- */
app.use("/api/hotspot", hotspotRoutes);

/* ---------- 404 / error handlers ---------- */
app.use((req, res) => {
    res.status(404).json({ status: "error", code: "ER404", message: "Not found." });
});
app.use((err, _req, res, _next) => {
    console.error("[unhandled]", err);
    res.status(500).json({ status: "error", code: "ER500", message: "Internal server error." });
});

/* ---------- start ---------- */
app.listen(PORT, () => {
    console.log("HAYLO backend listening on port " + PORT);
    console.log("CamPay base:", process.env.CAMPAY_BASE_URL || "https://demo.campay.net");
    console.log("MikroTik:",   (process.env.MIKROTIK_HOST || "192.168.88.1") + ":" + (process.env.MIKROTIK_PORT || "8728"));
});
