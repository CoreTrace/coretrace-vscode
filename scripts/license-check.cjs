// Checks npm dependency licenses against license-policy.json and flags any
// license that changed since license-baseline.json.
// Usage: node scripts/license-check.cjs [--update]
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const POLICY = path.join(ROOT, 'license-policy.json');
const BASELINE = path.join(ROOT, 'license-baseline.json');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// The lockfile often omits "license": fall back to the installed package.json.
function readLicense(root, key, entry) {
  if (entry.license) return entry.license;
  try {
    const pkg = readJson(path.join(root, key, 'package.json'));
    if (typeof pkg.license === 'string') return pkg.license;
    if (pkg.license && pkg.license.type) return pkg.license.type;
    if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type || l).join(' OR ');
  } catch { /* not installed */ }
  return 'UNKNOWN';
}

function collect(root) {
  const lock = readJson(path.join(root, 'package-lock.json'));
  const deps = {};
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (!key || entry.link) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const dep = deps[name] || (deps[name] = { licenses: new Set(), versions: new Set(), dev: true });
    dep.licenses.add(readLicense(root, key, entry));
    dep.versions.add(entry.version);
    if (!entry.dev) dep.dev = false; // shipped with the extension
  }
  return deps;
}

// shortcut: drops parentheses, so "(A OR B) AND C" reads as "A OR (B AND C)"; fine for npm metadata, use an SPDX parser if that case appears.
function satisfies(expr, ok) {
  const e = expr.replace(/[()]/g, '').trim();
  if (/\sOR\s/.test(e)) return e.split(/\s+OR\s+/).some((x) => satisfies(x, ok));
  if (/\sAND\s/.test(e)) return e.split(/\s+AND\s+/).every((x) => satisfies(x, ok));
  return ok(e);
}

const licenseOf = (dep) => [...dep.licenses].sort().join(' | ');

function check(deps, policy, baseline) {
  const violations = [];
  const changes = [];
  for (const [name, dep] of Object.entries(deps)) {
    const at = `${name}@${[...dep.versions].join(',')}`;
    for (const license of dep.licenses) {
      if (!dep.dev && !satisfies(license, (id) => policy.allowed.includes(id))) {
        violations.push(`${at}: ${license} is not allowed in shipped code`);
      }
      if (dep.dev && !satisfies(license, (id) => !policy.denied.includes(id))) {
        violations.push(`${at}: ${license} is denied`);
      }
    }
    const license = licenseOf(dep);
    if (baseline && name in baseline && baseline[name] !== license) {
      changes.push(`${at}: license changed ${baseline[name]} -> ${license}`);
    }
  }
  return { violations, changes };
}

function main() {
  const deps = collect(ROOT);
  const policy = readJson(POLICY);
  const baseline = fs.existsSync(BASELINE) ? readJson(BASELINE) : null;
  const { violations, changes } = check(deps, policy, baseline);

  const counts = {};
  for (const dep of Object.values(deps)) counts[licenseOf(dep)] = (counts[licenseOf(dep)] || 0) + 1;
  const shipped = Object.values(deps).filter((d) => !d.dev).length;
  console.log(`${Object.keys(deps).length} packages (${shipped} shipped, ${Object.keys(deps).length - shipped} dev-only)`);
  for (const [license, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${license}`);

  for (const v of violations) console.error(`POLICY  ${v}`);
  if (process.argv.includes('--update')) {
    if (violations.length) return 1;
    const next = {};
    for (const name of Object.keys(deps).sort()) next[name] = licenseOf(deps[name]);
    fs.writeFileSync(BASELINE, JSON.stringify(next, null, 2) + '\n');
    console.log(`Baseline written: ${path.relative(ROOT, BASELINE)}`);
    return 0;
  }
  for (const c of changes) console.error(`CHANGED ${c}`);
  if (!baseline) console.error('No baseline: run `npm run licenses:baseline`.');
  if (changes.length) console.error('Review the new license, then accept it with `npm run licenses:baseline`.');
  return violations.length || changes.length || !baseline ? 1 : 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { collect, satisfies, check };
