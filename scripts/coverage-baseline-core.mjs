export const coverageMetricNames = Object.freeze(['lines', 'statements', 'functions', 'branches']);
export const criticalCoverageMinimumPercent = Object.freeze({
  lines: 85,
  statements: 85,
  functions: 85,
  branches: 80,
});

function coverageRatio(metric) {
  if (!metric || !Number.isFinite(metric.total) || !Number.isFinite(metric.covered)
    || metric.total <= 0 || metric.covered < 0 || metric.covered > metric.total) {
    throw new Error('Coverage metrics must contain valid positive totals and covered counts.');
  }
  return metric.covered / metric.total;
}

export function normalizeCoverageSummary(globalSummary) {
  return Object.fromEntries(coverageMetricNames.map((metricName) => {
    const value = globalSummary[metricName];
    coverageRatio(value);
    if (!Number.isFinite(value.pct)) {
      throw new Error(`Coverage summary is missing the ${metricName} percentage.`);
    }
    return [metricName, {
      total: value.total,
      covered: value.covered,
      pct: value.pct,
    }];
  }));
}

export function createCoverageProfile(profile, summaryPath, observed) {
  if (profile === 'wider') {
    return {
      summaryPath,
      // Counts, rather than Istanbul's two-decimal percentage, preserve enough precision to
      // reject even one newly uncovered item when the measured source set remains unchanged.
      enforcement: 'recorded-ratio',
      observed,
    };
  }

  if (profile !== 'critical-runtime') {
    throw new Error(`Unknown coverage profile ${profile}.`);
  }

  return {
    summaryPath,
    observed,
    // These are architectural hard floors, not a snapshot of whichever run last updated counts.
    // Keep them aligned with vitest.critical.config.ts when the critical module list changes.
    minimumPercent: { ...criticalCoverageMinimumPercent },
  };
}

function formatRatio(metric) {
  return `${metric.covered}/${metric.total} (${(coverageRatio(metric) * 100).toFixed(4)}%)`;
}

export function findCoverageRegressions(profile, observed, expected) {
  if (profile === 'wider') {
    if (expected.enforcement !== 'recorded-ratio' || !expected.observed) {
      throw new Error('The wider coverage baseline must use recorded-ratio enforcement.');
    }
    return coverageMetricNames.flatMap((metricName) => {
      const currentMetric = observed[metricName];
      const baselineMetric = expected.observed[metricName];
      return coverageRatio(currentMetric) + Number.EPSILON < coverageRatio(baselineMetric)
        ? [`${metricName}: ${formatRatio(currentMetric)} < recorded ${formatRatio(baselineMetric)}`]
        : [];
    });
  }

  if (!expected.minimumPercent) {
    throw new Error(`Coverage profile ${profile} must define minimumPercent thresholds.`);
  }
  return coverageMetricNames.flatMap((metricName) => (
    observed[metricName].pct + Number.EPSILON < expected.minimumPercent[metricName]
      ? [`${metricName}: ${observed[metricName].pct}% < ${expected.minimumPercent[metricName]}%`]
      : []
  ));
}
