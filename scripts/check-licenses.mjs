#!/usr/bin/env node
// License gate: fail CI if any third-party dependency carries a forbidden
// (copyleft / network-copyleft / source-available) license.
//
// Walks the installed (hoisted) node_modules tree — works for both single-package
// repos and npm workspaces, which `license-checker` does not handle reliably.
// Run after `npm ci`. Exits 1 on a violation or on its own error (fail-closed).
//
// Policy: block strong + weak copyleft. Permissive (MIT/Apache/ISC/BSD/etc.) and
// the audit-cleared `lightningcss*` build tool (MPL-2.0, used unmodified) are allowed.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Forbidden SPDX prefixes (case-insensitive). A dual `X OR Y` license passes if
// EITHER side is permissive — so we only fail when every option is forbidden.
const FORBIDDEN = ['GPL', 'AGPL', 'LGPL', 'SSPL', 'BUSL', 'EUPL', 'CC-BY-NC', 'CC-BY-SA', 'OSL', 'EPL', 'MPL'];

// Packages explicitly cleared by the license audit (name → reason). These skip the check.
const ALLOWLIST = new Map([
  ['lightningcss', 'MPL-2.0 build tool, used unmodified (audit-cleared)'],
  ['lightningcss-darwin-arm64', 'MPL-2.0 native binary of lightningcss'],
  ['lightningcss-darwin-x64', 'MPL-2.0 native binary of lightningcss'],
  ['lightningcss-linux-x64-gnu', 'MPL-2.0 native binary of lightningcss'],
  ['lightningcss-linux-arm64-gnu', 'MPL-2.0 native binary of lightningcss'],
  ['lightningcss-linux-x64-musl', 'MPL-2.0 native binary of lightningcss'],
  ['lightningcss-linux-arm64-musl', 'MPL-2.0 native binary of lightningcss'],
  ['lightningcss-win32-x64-msvc', 'MPL-2.0 native binary of lightningcss'],
  ['lightningcss-win32-arm64-msvc', 'MPL-2.0 native binary of lightningcss'],
]);

function licenseOf(pkg) {
  let l = pkg.license ?? pkg.licenses;
  if (Array.isArray(l)) l = l.map((x) => (typeof x === 'object' ? x.type ?? x.name : x)).join(' OR ');
  else if (l && typeof l === 'object') l = l.type ?? l.name;
  return (l ?? 'UNKNOWN').toString();
}

// A license string is forbidden when at least one option is forbidden AND no
// option is clearly permissive (so `MIT OR GPL-3.0` is fine — you take MIT).
function isForbidden(lic) {
  const up = lic.toUpperCase().replace(/[()]/g, '');
  const opts = up.split(/\s+OR\s+/).map((s) => s.trim());
  const anyForbidden = opts.some((o) => FORBIDDEN.some((f) => o.startsWith(f)));
  if (!anyForbidden) return false;
  const anyPermissive = opts.some((o) => !FORBIDDEN.some((f) => o.startsWith(f)) && o !== 'UNKNOWN');
  return !anyPermissive;
}

const violations = [];
const seen = new Set();

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e === '.bin' || e === '.cache') continue;
    const p = join(dir, e);
    if (e.startsWith('@')) { walk(p); continue; }     // scope dir
    inspect(p);
  }
}

function inspect(pkgDir) {
  let st;
  try { st = statSync(pkgDir); } catch { return; }
  if (!st.isDirectory()) return;
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const name = pkg.name ?? pkgDir;
    const key = `${name}@${pkg.version ?? '?'}`;
    if (!seen.has(key)) {
      seen.add(key);
      if (!pkg.private && !ALLOWLIST.has(name)) {
        const lic = licenseOf(pkg);
        if (isForbidden(lic)) violations.push({ name: key, license: lic });
      }
    }
  } catch { /* no/invalid package.json — skip */ }
  const nested = join(pkgDir, 'node_modules');
  try { if (statSync(nested).isDirectory()) walk(nested); } catch { /* none */ }
}

const roots = process.argv.slice(2);
if (roots.length === 0) roots.push('node_modules');
let any = false;
for (const r of roots) {
  try { if (statSync(r).isDirectory()) { any = true; walk(r); } } catch { /* missing root */ }
}
if (!any) {
  console.error(`license-gate: no node_modules found in [${roots.join(', ')}] — run \`npm ci\` first.`);
  process.exit(1); // fail-closed: never pass silently
}

if (violations.length) {
  console.error(`\n❌ license-gate: ${violations.length} forbidden license(s) found:\n`);
  for (const v of violations.sort((a, b) => a.name.localeCompare(b.name))) {
    console.error(`   ${v.license.padEnd(28)} ${v.name}`);
  }
  console.error(`\nBlocked families: ${FORBIDDEN.join(', ')}.`);
  console.error('If a hit is a false positive or audit-cleared, add it to ALLOWLIST in scripts/check-licenses.mjs.\n');
  process.exit(1);
}

console.log(`✅ license-gate: ${seen.size} packages scanned, no forbidden licenses.`);
