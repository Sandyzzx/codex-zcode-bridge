// The impact map is the single executable-test manifest for every automatic entry.
export const WINDOWS_ONLY_TESTS = new Set([
  "test/runtime/sqlite-fresh-install.test.ts",
  "test/runtime/trusted-local-policy-config.test.ts",
  "test/sqlite-candidate/wp6b-wiring/admission-to-claim.test.ts",
  "test/sqlite-candidate/wp6b-wiring/bootstrap.test.ts",
  "test/sqlite-candidate/wp6b-wiring/composition.test.ts",
  "test/sqlite-candidate/wp6b-wiring/json-authority-cutover.test.ts",
  "test/sqlite-candidate/wp6b-wiring/mvp-real-adapter.test.ts",
  "test/sqlite-candidate/wp6b-wiring/trusted-local-policy.test.ts",
]);

export function isAutomaticTest(entry, platform = process.platform) {
  return entry.gate !== "MANUAL_E2E" && entry.type !== "Fixture"
    && (platform === "win32" || !WINDOWS_ONLY_TESTS.has(entry.file));
}

export function compiledTestPath(file) {
  return file.endsWith(".ts") ? `dist-test/${file.slice(0, -3)}.js` : file;
}

export function automaticTestEntries(map, platform = process.platform) {
  return map.tests.filter((entry) => isAutomaticTest(entry, platform));
}
