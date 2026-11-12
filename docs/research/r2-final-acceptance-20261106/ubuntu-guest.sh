#!/bin/bash
# Manual R2 acceptance, only inside the disposable Ubuntu guest disk.
set -eu
export PATH=/opt/r2-node/bin:$PATH
cd /home/ubuntu/r2
echo R2_UBUNTU_ENVIRONMENT
cat /etc/os-release
uname -a
id
node -p 'JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,versions:process.versions})'
echo SOURCE_ARCHIVE_SHA256
sha256sum /tmp/source-904f457.tar
echo '1a4a30ff666675967f16bd29d589f8137ecc50a59786b0010c767f55414b9deb  /tmp/source-904f457.tar' | sha256sum -c -
# Compare raw committed Git blobs, not a Windows archive's CRLF worktree conversion.
cat > /tmp/r2-bundles-before.sha256 <<'R2_EXPECTED_BLOBS'
98544299f56e1df0ecf552decb3b5f9860155714322e67604920527406336bcc  plugins/codex-zcode-bridge/dist/bridge.mjs
8398202f70943d90f391160892c5c75d543dcec26df88f1631df8ccb07ef0ac1  plugins/codex-zcode-bridge/worker/worker-main.mjs
54bb667b8776256c14f3386365166c6506a5998868c0a8abd87f54410c2af54d  plugins/codex-zcode-bridge/dist/upgrade-sqlite-v14.mjs
34948f258eb6c0ff0c28f6a877ec4f1a340745351ab4bd5e51998d374308b4be  plugins/codex-zcode-bridge/dist/wait-task.mjs
R2_EXPECTED_BLOBS
npm run typecheck
npm run build
sha256sum -c /tmp/r2-bundles-before.sha256
npm run validate:plugin
npm run build:test
# The unchanged production test runner supplies a disposable Home and fixture roots.
# No Windows-only tests, manual Host E2E, or fixture entrypoints are forced in.
node scripts/test-isolated.mjs --test-concurrency=1 \
  test/sqlite-result-v14.test.mjs \
  test/sqlite-v14-upgrade.test.mjs \
  test/mcp-result-v14.test.mjs \
  test/sqlite-candidate/wp6c/result-recovery.test.mjs \
  test/sqlite-candidate/wp6b2b1/lifecycle-port.test.mjs \
  test/sqlite-candidate/wp6c/admin-abandonment.test.mjs \
  dist-test/test/spawn-worker-stderr.test.js \
  dist-test/test/sqlite-candidate/wp6b-wiring/lifecycle-gate.test.js
echo R2_UBUNTU_ALL_REQUESTED_COMMANDS_PASSED
