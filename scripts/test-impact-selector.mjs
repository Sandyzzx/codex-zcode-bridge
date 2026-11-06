/**
 * Pure Test Impact Selector.  Keeping matching separate from Git and process
 * execution makes policy deterministic and directly unit-testable.
 */

import { isAutomaticTest } from "./lib/test-files.mjs";

const POSIX_SEPARATOR = /\//u;

function toPosixPath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//u, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function matchesPattern(inputPath, pattern) {
  const value = toPosixPath(inputPath);
  const glob = toPosixPath(pattern);
  if (value === glob) return true;
  const parts = glob.split(POSIX_SEPARATOR);
  const regexSource = parts.map((part) => {
    if (part === "**") return "(?:[^/]+(?:/[^/]+)*)?";
    if (part === "*") return "[^/]+";
    return escapeRegExp(part);
  }).join("/");
  return new RegExp(`^${regexSource}$`, "u").test(value);
}

function pathMatchesAny(inputPath, patterns) {
  return patterns.some((pattern) => matchesPattern(inputPath, pattern));
}

function affectedDomains(changedFiles, map) {
  const domains = new Set();
  const reasonsByDomain = new Map();
  const addReason = (domain, reason) => {
    domains.add(domain);
    if (!reasonsByDomain.has(domain)) reasonsByDomain.set(domain, []);
    const reasons = reasonsByDomain.get(domain);
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  for (const domain of map.domains) {
    for (const file of changedFiles) {
      if (pathMatchesAny(file, domain.paths)) addReason(domain.id, `path:${file}`);
    }
  }

  const testByFile = new Map(map.tests.map((entry) => [entry.file, entry]));
  const stressByFile = new Map(map.stress_tests.map((entry) => [entry.file, entry]));
  for (const file of changedFiles) {
    const test = testByFile.get(file);
    if (test) for (const domain of test.domains) addReason(domain, `changed-test:${file}`);
    const stress = stressByFile.get(file);
    if (stress) for (const domain of stress.trigger_domains) addReason(domain, `changed-stress-test:${file}`);
  }
  return { domains: [...domains].sort(), reasonsByDomain };
}

export function selectAffectedTests({ changedFiles, map, includeStress = true, platform = process.platform }) {
  const normalizedFiles = [...new Set(changedFiles.map(toPosixPath))].sort((left, right) => left.localeCompare(right, "en"));
  const { domains, reasonsByDomain } = affectedDomains(normalizedFiles, map);
  const fullSuiteReasons = [];
  for (const file of normalizedFiles) {
    if (pathMatchesAny(file, map.full_suite_paths)) fullSuiteReasons.push(`full-suite-path:${file}`);
  }

  const mappedSourceFiles = new Set();
  for (const domain of map.domains) {
    for (const file of normalizedFiles) {
      if (file.startsWith("src/") && pathMatchesAny(file, domain.paths)) mappedSourceFiles.add(file);
    }
  }
  const mappedFiles = new Set(map.tests.map((entry) => entry.file));
  const sourceCandidatePatterns = ["src/**"];
  for (const file of normalizedFiles) {
    const isSource = pathMatchesAny(file, sourceCandidatePatterns);
    if (isSource && !mappedSourceFiles.has(file)) fullSuiteReasons.push(`unknown-source:${file}`);
  }

  // A file under test/ that is neither a mapped executable test nor a named
  // support fixture may still be new infrastructure. Refuse to infer safety.
  for (const file of normalizedFiles) {
    if (!file.startsWith("test/")) continue;
    if (mappedFiles.has(file)) continue;
    if (!/\.(?:test\.)?(?:ts|mts|mjs|js|cjs)$/u.test(file)) continue;
    fullSuiteReasons.push(`unknown-test-infrastructure:${file}`);
  }

  const testByFile = new Map(map.tests.map((entry) => [entry.file, entry]));
  const stressByFile = new Map(map.stress_tests.map((entry) => [entry.file, entry]));
  const selected = new Map();
  const addSelected = (entry, reason, stressInfo = undefined) => {
    if (!entry || !isAutomaticTest(entry, platform)) return;
    const registeredStress = stressInfo ?? stressByFile.get(entry.file);
    if (!selected.has(entry.file)) {
      selected.set(entry.file, { ...entry, reasons: [], stress: registeredStress });
    }
    const record = selected.get(entry.file);
    if (stressInfo) record.stress = stressInfo;
    if (!record.reasons.includes(reason)) record.reasons.push(reason);
  };

  if (fullSuiteReasons.length > 0) {
    for (const entry of map.tests) {
      // The wrapper represents this case with npm test, so don't duplicate the
      // suite into a fragment. Preserve individual stress metadata for output.
      if (entry.stress) continue;
      const stressInfo = stressByFile.get(entry.file);
      addSelected(entry, `full-suite:${fullSuiteReasons[0]}`, stressInfo);
    }
    return {
      mode: "FULL_SUITE",
      changed_files: normalizedFiles,
      affected_domains: domains,
      domain_reasons: Object.fromEntries([...reasonsByDomain].map(([key, value]) => [key, value])),
      full_suite_reasons: fullSuiteReasons.sort(),
      selected_tests: [...selected.values()],
      stress_tests: [],
      stress_mode: "SEPARATE_STRESS_GATE",
    };
  }

  for (const file of normalizedFiles) {
    const direct = testByFile.get(file);
    if (direct) addSelected(direct, `changed-test:${file}`);
  }
  for (const domain of domains) {
    for (const entry of map.tests) {
      if (!entry.domains.includes(domain)) continue;
      if (!includeStress && entry.stress) continue;
      addSelected(entry, `domain:${domain}`);
    }
  }

  const selectedTests = [...selected.values()].sort((left, right) => left.file.localeCompare(right.file, "en"));
  const selectedStress = selectedTests.filter((entry) => entry.stress).map((entry) => entry.stress);
  return {
    mode: selectedTests.length === 0 ? "NO_TESTS_APPLICABLE" : "TARGETED",
    changed_files: normalizedFiles,
    affected_domains: domains,
    domain_reasons: Object.fromEntries([...reasonsByDomain].map(([key, value]) => [key, value])),
    full_suite_reasons: [],
    selected_tests: selectedTests,
    stress_tests: includeStress ? selectedStress : [],
    stress_mode: selectedStress.length > 0 ? "STRESS_TEST_REQUIRED" : "STRESS_TESTS_NOT_APPLICABLE",
  };
}
