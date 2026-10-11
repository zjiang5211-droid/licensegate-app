"use strict";

// better-sqlite3 persistence layer. The database file and tables are created
// automatically on first use (lazy init — requiring this module never throws).

const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const config = require("./config");

let db = null;

function getDb() {
  if (db) return db;
  const file = config.DATABASE_PATH;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      installation_id INTEGER,
      org TEXT NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      head_sha TEXT,
      base_sha TEXT,
      conclusion TEXT,
      violation_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS violations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      name TEXT,
      version TEXT,
      ecosystem TEXT,
      license TEXT,
      manifest TEXT,
      severity TEXT,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scans_org ON scans(org);
    CREATE INDEX IF NOT EXISTS idx_scans_installation ON scans(installation_id);
    CREATE INDEX IF NOT EXISTS idx_violations_scan ON violations(scan_id);
  `);
  return db;
}

/**
 * Record one PR scan plus its violations. Returns the scan id.
 */
function recordScan(scan, violations) {
  const database = getDb();
  const insertScan = database.prepare(`
    INSERT INTO scans
      (installation_id, org, repo, pr_number, head_sha, base_sha,
       conclusion, violation_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertViolation = database.prepare(`
    INSERT INTO violations
      (scan_id, name, version, ecosystem, license, manifest, severity, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  const tx = database.transaction((s, vs) => {
    const info = insertScan.run(
      s.installation_id ?? null,
      s.org,
      s.repo,
      s.pr_number,
      s.head_sha ?? null,
      s.base_sha ?? null,
      s.conclusion ?? null,
      s.violation_count ?? 0,
      s.created_at || now
    );
    for (const v of vs || []) {
      insertViolation.run(
        info.lastInsertRowid,
        v.name ?? null,
        v.version ?? null,
        v.ecosystem ?? null,
        v.license ?? null,
        v.manifest ?? null,
        v.severity ?? null,
        v.reason ?? null
      );
    }
    return info.lastInsertRowid;
  });
  return tx(scan, violations);
}

function getRecentScans(org, limit) {
  return getDb()
    .prepare(
      "SELECT * FROM scans WHERE org = ? ORDER BY id DESC LIMIT ?"
    )
    .all(org, limit || 50);
}

function getViolations(org, limit) {
  return getDb()
    .prepare(
      `SELECT v.*, s.repo, s.pr_number, s.created_at AS scanned_at
       FROM violations v
       JOIN scans s ON v.scan_id = s.id
       WHERE s.org = ?
       ORDER BY v.id DESC
       LIMIT ?`
    )
    .all(org, limit || 200);
}

function getOrgs() {
  return getDb()
    .prepare("SELECT DISTINCT org FROM scans ORDER BY org")
    .all()
    .map((r) => r.org);
}

/** Number of distinct repos scanned under one installation (billing). */
function countDistinctRepos(installationId) {
  const row = getDb()
    .prepare(
      "SELECT COUNT(DISTINCT repo) AS n FROM scans WHERE installation_id = ?"
    )
    .get(installationId);
  return row ? row.n : 0;
}

function hasRepo(installationId, repo) {
  const row = getDb()
    .prepare(
      "SELECT 1 AS ok FROM scans WHERE installation_id = ? AND repo = ? LIMIT 1"
    )
    .get(installationId, repo);
  return Boolean(row);
}

/** Top violated licenses for an org (dashboard). */
function getTopLicenses(org, limit) {
  return getDb()
    .prepare(
      `SELECT v.license AS license, COUNT(*) AS count
       FROM violations v
       JOIN scans s ON v.scan_id = s.id
       WHERE s.org = ?
       GROUP BY v.license
       ORDER BY count DESC
       LIMIT ?`
    )
    .all(org, limit || 10);
}

/** Test/ops helper: drop the cached handle so a new file can be used. */
function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  getDb,
  recordScan,
  getRecentScans,
  getViolations,
  getOrgs,
  countDistinctRepos,
  hasRepo,
  getTopLicenses,
  close,
};
