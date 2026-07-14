import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coverageMetricNames,
  createCoverageProfile,
  criticalCoverageMinimumPercent,
  findCoverageRegressions,
} from './coverage-baseline-core.mjs';

function summary(covered = 80, total = 100) {
  return Object.fromEntries(coverageMetricNames.map((metricName) => [metricName, {
    covered,
    total,
    pct: (covered / total) * 100,
  }]));
}

test('the wider profile rejects one newly uncovered item', () => {
  const baseline = createCoverageProfile('wider', 'coverage/wider/coverage-summary.json', summary());
  const observed = summary();
  observed.lines = { covered: 79, total: 100, pct: 79 };

  assert.deepEqual(findCoverageRegressions('wider', observed, baseline), [
    'lines: 79/100 (79.0000%) < recorded 80/100 (80.0000%)',
  ]);
});

test('the wider profile compares ratios when the measured source total changes', () => {
  const baseline = createCoverageProfile('wider', 'coverage/wider/coverage-summary.json', summary());
  const observed = summary(160, 200);

  assert.deepEqual(findCoverageRegressions('wider', observed, baseline), []);
});

test('critical profiles continue to enforce their explicit hard thresholds', () => {
  const baseline = createCoverageProfile(
    'critical-runtime',
    'coverage/critical-runtime/coverage-summary.json',
    summary(95, 100),
  );

  assert.deepEqual(findCoverageRegressions('critical-runtime', summary(86, 100), baseline), []);
  const failures = findCoverageRegressions('critical-runtime', summary(84, 100), baseline);
  assert.equal(failures.length, 3);
  assert.equal(failures.some((failure) => failure.startsWith('branches:')), false);
  assert.deepEqual(baseline.minimumPercent, criticalCoverageMinimumPercent);
});
