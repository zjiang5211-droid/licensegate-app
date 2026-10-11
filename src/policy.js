"use strict";

// Pure license-policy logic: no I/O, no side effects, fully unit-testable.
//
// Severity model:
//   allow   - permissive / public-domain-like license, no action needed
//   warn    - weak copyleft, allowed by default but flagged for human review
//   deny    - strong copyleft / network copyleft / source-available, blocks the PR
//   unknown - no usable license information (NOASSERTION, empty, unrecognized)
//
// For SPDX compound expressions:
//   "A OR B"  -> "allow" if ANY alternative is allow (dual-licensing lets the
//                 user pick the permissive option); otherwise the worst of the
//                 alternatives.
//   "A AND B" -> the worst of the parts.
// Worst ordering: deny > warn > unknown > allow.

// --- Raw SPDX lists (exported so other tools can reuse them) ----------------

const DENY_IDS = [
  // GPL family: every version, -only/-or-later variants, and bare "GPL"
  "GPL-1.0-only", "GPL-1.0-or-later", "GPL-1.0", "GPL",
  "GPL-2.0-only", "GPL-2.0-or-later", "GPL-2.0",
  "GPL-3.0-only", "GPL-3.0-or-later", "GPL-3.0",
  // AGPL family
  "AGPL-1.0-only", "AGPL-1.0-or-later", "AGPL-1.0", "AGPL",
  "AGPL-3.0-only", "AGPL-3.0-or-later", "AGPL-3.0",
  // SSPL: source-available, not OSI-approved
  "SSPL-1.0",
  // EUPL
  "EUPL-1.0", "EUPL-1.1", "EUPL-1.2",
  // OSL
  "OSL-1.0", "OSL-1.1", "OSL-2.0", "OSL-2.1", "OSL-3.0",
];

// Weak copyleft: allowed by default, but surfaced as warnings.
const WARN_IDS = [
  "LGPL-2.0-only", "LGPL-2.0-or-later", "LGPL-2.0",
  "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-2.1",
  "LGPL-3.0-only", "LGPL-3.0-or-later", "LGPL-3.0",
  "MPL-1.0", "MPL-1.1", "MPL-2.0",
  "EPL-1.0", "EPL-2.0",
  "CDDL-1.0", "CDDL-1.1",
];

// Permissive / public-domain-like.
const ALLOW_IDS = [
  "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC",
  "CC0-1.0", "Unlicense", "WTFPL", "0BSD",
  "Python-2.0", "PSF-2.0", "PSF", "Zlib", "Artistic-2.0", "BSL-1.0",
  "OFL-1.1",
  // CC-BY-* is matched by prefix rule below (any version is permissive)
];

const DENY = new Set(DENY_IDS.map((s) => s.toUpperCase()));
const WARN = new Set(WARN_IDS.map((s) => s.toUpperCase()));
const ALLOW = new Set(ALLOW_IDS.map((s) => s.toUpperCase()));

// Family prefixes caught even for ids not enumerated above
// (e.g. a future "GPL-4.0-only" or a plain "AGPL").
const DENY_PREFIXES = ["GPL", "AGPL", "SSPL", "EUPL", "OSL"];
const WARN_PREFIXES = ["LGPL", "MPL", "EPL", "CDDL"];

// --- Classification ----------------------------------------------------------

const SEVERITY_RANK = { allow: 0, unknown: 1, warn: 2, deny: 3 };

function worst(classes) {
  let result = "allow";
  for (const c of classes) {
    if ((SEVERITY_RANK[c] || 0) > (SEVERITY_RANK[result] || 0)) result = c;
  }
  return result;
}

function splitExpr(text, keyword) {
  return text.split(new RegExp(`\\s+${keyword}\\s+`, "i")).filter(Boolean);
}

// Classify one atomic license token (no AND/OR at the top level).
function classifyToken(token) {
  // Strip surrounding parentheses and a trailing "+" ("or later").
  const cleaned = token.trim().replace(/^\(+/, "").replace(/\)+$/, "").trim();
  const upper = cleaned.toUpperCase();
  const base = upper.replace(/\+$/, "");

  if (DENY.has(upper) || DENY.has(base)) return "deny";
  if (WARN.has(upper) || WARN.has(base)) return "warn";
  if (ALLOW.has(upper) || ALLOW.has(base)) return "allow";

  for (const p of DENY_PREFIXES) {
    if (base === p || base.startsWith(p + "-")) return "deny";
  }
  for (const p of WARN_PREFIXES) {
    if (base === p || base.startsWith(p + "-")) return "warn";
  }
  // CC-BY-* (any version) is permissive.
  if (base === "CC-BY" || base.startsWith("CC-BY-")) return "allow";

  return "unknown";
}

/**
 * Classify an SPDX license id or expression.
 * @param {string|null|undefined} spdx
 * @returns {"allow"|"warn"|"deny"|"unknown"}
 */
function classifyLicense(spdx) {
  if (spdx === null || spdx === undefined) return "unknown";
  const text = String(spdx).trim();
  if (text === "") return "unknown";
  const upper = text.toUpperCase();
  if (upper === "NOASSERTION" || upper === "NONE") return "unknown";

  // OR: dual licensing — allow if ANY alternative is allow.
  const orParts = splitExpr(text, "OR");
  if (orParts.length > 1) {
    const results = orParts.map((p) => classifyLicense(p));
    if (results.includes("allow")) return "allow";
    return worst(results);
  }

  // AND: combined work must satisfy every part — take the worst.
  const andParts = splitExpr(text, "AND");
  if (andParts.length > 1) {
    return worst(andParts.map((p) => classifyLicense(p)));
  }

  return classifyToken(text);
}

// --- Policy evaluation -------------------------------------------------------

const DEFAULT_POLICY = {
  deny: [], // extra SPDX ids to deny, on top of the built-in list
  allow: [], // SPDX ids to allow, overriding the built-in classification
  fail_on_unknown: true, // unknown license => violation (else warning)
  fail_on_warning: false, // weak copyleft => violation (else warning)
  ignore_scopes: ["development"], // dependency scopes to skip entirely
};

function normalizeId(s) {
  return String(s || "").trim().toUpperCase();
}

/**
 * Evaluate a dependency list against a policy.
 * @param {Array<{name,version,license,ecosystem,manifest,scope}>} deps
 * @param {{deny,allow,fail_on_unknown,fail_on_warning,ignore_scopes}} policy
 * @returns {{verdict:"pass"|"fail"|"warn", violations:[], warnings:[]}}
 */
function evaluateDependencies(deps, policy) {
  const p = Object.assign({}, DEFAULT_POLICY, policy || {});
  const policyDeny = new Set((p.deny || []).map(normalizeId));
  const policyAllow = new Set((p.allow || []).map(normalizeId));
  const ignoreScopes = new Set(
    (p.ignore_scopes || []).map((s) => String(s).toLowerCase())
  );

  const violations = [];
  const warnings = [];

  for (const dep of deps || []) {
    const scope = String(dep.scope || "").toLowerCase();
    if (scope && ignoreScopes.has(scope)) continue;

    const licenseId = dep.license == null ? "" : String(dep.license).trim();
    const norm = normalizeId(licenseId);

    // Explicit policy lists take precedence over built-in classification.
    let classification;
    if (norm && policyDeny.has(norm)) classification = "deny";
    else if (norm && policyAllow.has(norm)) classification = "allow";
    else classification = classifyLicense(licenseId);

    const base = {
      name: dep.name || null,
      version: dep.version || null,
      license: licenseId || null,
      ecosystem: dep.ecosystem || null,
      manifest: dep.manifest || null,
    };
    const display = licenseId || "not declared";

    if (classification === "deny") {
      violations.push(Object.assign({}, base, {
        severity: "deny",
        reason: `License "${display}" is denied (strong copyleft / source-available).`,
        suggestion: "Replace with an MIT/Apache-2.0 licensed alternative.",
      }));
    } else if (classification === "warn") {
      const entry = Object.assign({}, base, {
        severity: "warn",
        reason: `License "${display}" is weak copyleft — allowed but flagged for review.`,
        suggestion:
          "Review the license terms (e.g. dynamic-linking requirements) before shipping.",
      });
      if (p.fail_on_warning) violations.push(entry);
      else warnings.push(entry);
    } else if (classification === "unknown") {
      const entry = Object.assign({}, base, {
        severity: "unknown",
        reason: `License "${display}" could not be determined (missing or unrecognized SPDX id).`,
        suggestion:
          "Ask the maintainer to declare an SPDX license or replace the dependency.",
      });
      if (p.fail_on_unknown) violations.push(entry);
      else warnings.push(entry);
    }
    // "allow" produces no entry.
  }

  const verdict =
    violations.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "pass";
  return { verdict, violations, warnings };
}

module.exports = {
  classifyLicense,
  evaluateDependencies,
  DEFAULT_POLICY,
  DENY,
  WARN,
  ALLOW,
  DENY_IDS,
  WARN_IDS,
  ALLOW_IDS,
};
