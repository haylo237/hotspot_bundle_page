// services/offerService.js
// ---------------------------------------------------------------------------
// SQLite-backed offer management for hotspot bundles.
// Each offer is mapped to a MikroTik profile by `profile` field.
// ---------------------------------------------------------------------------

const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.OFFERS_DB_PATH || path.join(__dirname, "../data/offers.sqlite");
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

db.exec(`CREATE TABLE IF NOT EXISTS offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile TEXT NOT NULL,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    duration TEXT,
    speed TEXT,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_offers_profile ON offers(profile);
`);

function getActiveOffers() {
    return db.prepare("SELECT * FROM offers WHERE active = 1").all();
}

function getAllOffers() {
    return db.prepare("SELECT * FROM offers").all();
}

function getOfferByProfile(profile) {
    return db.prepare("SELECT * FROM offers WHERE profile = ?").get(profile);
}

function upsertOffer(offer) {
    const existing = getOfferByProfile(offer.profile);
    if (existing) {
        db.prepare(`UPDATE offers SET name=?, price=?, duration=?, speed=?, description=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE profile=?`).run(
            offer.name, offer.price, offer.duration, offer.speed, offer.description, offer.active ? 1 : 0, offer.profile
        );
    } else {
        db.prepare(`INSERT INTO offers (profile, name, price, duration, speed, description, active) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(
                offer.profile, offer.name, offer.price, offer.duration, offer.speed, offer.description, offer.active ? 1 : 0
            );
    }
}

function deleteOffer(profile) {
    db.prepare("DELETE FROM offers WHERE profile = ?").run(profile);
}

module.exports = {
    getActiveOffers,
    getAllOffers,
    getOfferByProfile,
    upsertOffer,
    deleteOffer
};
