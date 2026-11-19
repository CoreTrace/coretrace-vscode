#!/usr/bin/env node
// Mesure la dette technique et de sécurité de l'extension et la compare à debt-baseline.json.
//   node scripts/debt-report.cjs            affiche les mesures face à la baseline
//   node scripts/debt-report.cjs --check    échoue si une mesure dépasse la baseline (quality gate)
//   node scripts/debt-report.cjs --write    enregistre les mesures actuelles comme nouvelle baseline
//   --no-audit                              saute npm audit (hors ligne, hook pre-commit)
//   --self-test                             vérifie la logique de comparaison
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(ROOT, 'debt-baseline.json');
const LARGE_FILE_LINES = 500;
const SOURCES = () => [
  ...fs.readdirSync(path.join(ROOT, 'src'), { recursive: true })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join('src', f)),
  'media/main.js',
  'media/stackTree.js',
];

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  } catch (e) {
    // tsc et npm audit sortent en erreur dès qu'ils trouvent quelque chose : la sortie reste exploitable.
    if (e.stdout) { return e.stdout; }
    throw e;
  }
}

function deadCode() {
  const tsc = require.resolve('typescript/bin/tsc', { paths: [ROOT] });
  const out = run(process.execPath, [tsc, '--noEmit', '-p', ROOT,
    '--noUnusedLocals', '--noUnusedParameters', '--noImplicitReturns', '--noFallthroughCasesInSwitch']);
  return out.split('\n').filter((l) => / error TS(6133|6192|6196|6198|7030|7029)/.test(l));
}

function audit() {
  const report = JSON.parse(run('npm', ['audit', '--json']));
  const v = report.metadata.vulnerabilities;
  return { vulnCritical: v.critical, vulnHigh: v.high, vulnModerate: v.moderate, vulnLow: v.low };
}

function measure({ withAudit }) {
  const files = SOURCES();
  const lines = files.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n'));
  const dead = deadCode();
  return {
    deadCode: dead.length,
    satd: lines.flat().filter((l) => /\b(TODO|FIXME|HACK|XXX)\b/.test(l)).length,
    largeFiles: lines.filter((l) => l.length > LARGE_FILE_LINES).length,
    ...(withAudit ? audit() : {}),
    _details: { deadCode: dead, largeFiles: files.filter((_, i) => lines[i].length > LARGE_FILE_LINES) },
  };
}

// Une mesure absente de la baseline n'est pas comparée ; une mesure absente du relevé (--no-audit) non plus.
function compare(baseline, current) {
  return Object.keys(baseline)
    .filter((k) => typeof current[k] === 'number')
    .map((k) => ({ metric: k, baseline: baseline[k], current: current[k], delta: current[k] - baseline[k] }));
}

function selfTest() {
  const rows = compare({ a: 2, b: 5, c: 1 }, { a: 3, b: 4 });
  assert.deepStrictEqual(rows.map((r) => r.delta), [1, -1]);
  assert.strictEqual(rows.filter((r) => r.delta > 0).length, 1);
  assert.deepStrictEqual(compare({ a: 0 }, { a: 0 }), [{ metric: 'a', baseline: 0, current: 0, delta: 0 }]);
  console.log('self-test OK');
}

function main(argv) {
  if (argv.includes('--self-test')) { return selfTest(); }
  const current = measure({ withAudit: !argv.includes('--no-audit') });
  const { _details, ...metrics } = current;

  if (argv.includes('--write')) {
    fs.writeFileSync(BASELINE, JSON.stringify(metrics, null, 2) + '\n');
    console.log(`Baseline enregistrée dans ${path.basename(BASELINE)} :`, metrics);
    return;
  }

  const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {};
  const rows = compare(baseline, metrics);
  console.table(rows);
  if (_details.deadCode.length) { console.log('Code mort :\n  ' + _details.deadCode.join('\n  ')); }
  if (_details.largeFiles.length) { console.log(`Fichiers > ${LARGE_FILE_LINES} lignes : ${_details.largeFiles.join(', ')}`); }

  const worse = rows.filter((r) => r.delta > 0);
  if (worse.length) {
    console.error(`\nDette en hausse : ${worse.map((r) => `${r.metric} ${r.baseline} -> ${r.current}`).join(', ')}`);
    if (argv.includes('--check')) { process.exitCode = 1; }
  } else if (rows.some((r) => r.delta < 0)) {
    console.log('\nDette en baisse : lancez `npm run debt:baseline` pour verrouiller ce progrès.');
  }
}

main(process.argv.slice(2));
