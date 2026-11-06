#!/bin/bash
# Continue the unchanged source after collecting the failed reproducible-build gate.
# The first failure stays recorded; this does not relabel bundle parity as PASS.
set -eu
export PATH=/opt/r2-node/bin:$PATH
cd /home/ubuntu/r2
echo R2_UBUNTU_RESUME_AFTER_BUILD_PARITY_FAILURE
cat /etc/os-release
id
if [ "${R2_ACCEPTANCE_TESTS_ONLY:-0}" != 1 ]; then
  npm run validate:plugin
  npm run build:test
fi
node scripts/test-isolated.mjs --test-concurrency=1 \
  test/sqlite-result-v14.test.mjs \
  test/sqlite-v14-upgrade.test.mjs \
  test/mcp-result-v14.test.mjs \
  test/sqlite-candidate/wp6c/result-recovery.test.mjs \
  test/sqlite-candidate/wp6b2b1/lifecycle-port.test.mjs \
  test/sqlite-candidate/wp6c/admin-abandonment.test.mjs \
  dist-test/test/spawn-worker-stderr.test.js \
  dist-test/test/sqlite-candidate/wp6b-wiring/lifecycle-gate.test.js
echo R2_UBUNTU_REQUESTED_REGRESSION_COMMANDS_PASSED
