// Evidence for the pending Result decision. No migration or production root.
// Run after npm run build:test: node docs/research/sqlite-result-contract-20261105/probe.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repository = path.resolve(import.meta.dirname, '../../..');
const load = file => import(pathToFileURL(path.join(repository, file)).href);
const { IsolatedAdmissionStore, canonical } = await load('src/sqlite-candidate/wp6b2b1/store.mjs');
const { parseAgentReport } = await load('dist-test/src/adapters/agent-report.js');
const { buildTaskResult } = await load('dist-test/src/manager/normalize.js');
const base = path.join(repository, '.run', 'execution'); fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, 'result-contract-'));
const task = { task_id: 'result-probe', workspace: root, objective: 'owned Result contract probe', requirements: [], allowed_paths: [], forbidden_paths: [], acceptance_criteria: [], test_commands: [] };
const report = { summary: 'valid report', files_changed: [], tests: [], issues: [], needs_master_decision: false };
function normalized(agentReport = report, suffix = '') {
  const response = JSON.stringify(agentReport) + suffix;
  const parsed = parseAgentReport(response);
  assert.ok(parsed.report, 'the real Adapter parser must accept the source report');
  return buildTaskResult({ task, attempt: 1, startedAt: '2026-11-05T00:00:00.000Z', finishedAt: '2026-11-05T00:00:01.000Z',
    outcome: { agentReport: parsed.report, response, exitCode: 0, sessionId: null, errorCode: null, reportError: null } });
}
function exactBytes(target, unit) {
  const empty = normalized();
  const remaining = target - Buffer.byteLength(canonical(empty));
  const cost = Buffer.byteLength(JSON.stringify(unit)) - 2;
  const result = normalized(report, unit.repeat(Math.floor(remaining / cost)) + 'x'.repeat(remaining % cost));
  assert.equal(Buffer.byteLength(canonical(result)), target);
  return result;
}
const cases = [];
for (const [label, unit] of [['ascii','x'], ['cjk','中'], ['emoji','🙂'], ['escaped-quote','"'], ['escaped-control','\0']]) {
  for (const size of [65535,65536,65537]) cases.push({ label: `${label}-${size}`, result: exactBytes(size, unit), expected: size <= 65536 ? null : 'result_too_large' });
}
cases.push({ label: 'multiline-issue', result: normalized({ ...report, issues: ['first line\nsecond line'] }), expected: 'invalid_result_payload' });
cases.push({ label: '257-files', result: normalized({ ...report, files_changed: Array.from({length:257}, (_,i) => `file-${i}.txt`) }), expected: 'invalid_result_payload' });
cases.push({ label: '2M-character-capture', result: normalized(report, 'x'.repeat(2_000_000 - JSON.stringify(report).length)), expected: 'result_too_large' });
cases.push({ label: '2M-character-control-capture', result: normalized(report, '\0'.repeat(2_000_000 - JSON.stringify(report).length)), expected: 'result_too_large' });
const rows = [];
for (const {label,result,expected} of cases) {
  const directory = path.join(root,label); fs.mkdirSync(directory);
  const store = IsolatedAdmissionStore.initialize(directory, { managedDataDirectory: true });
  try {
    store.createTask(task);
    store.provisionCapacity({operation_id:'policy',capacity_limit:1,expected_generation:0,maintenance:{dispatch_blocked:true,writers_drained:true}});
    const allow = () => ({ state:'allow',fixture:true });
    const admitted = store.admitOperation({operation_id:'operation',task_id:task.task_id,attempt:1,workspace_ref:root},{workspaceValidator:allow,executionPermissionCheck:allow});
    const launch = {operation_id:'operation',task_id:task.task_id,attempt:1,generation:admitted.generation,revision:admitted.revision,launch_id:'launch',launch_epoch:1,launch_token:'synthetic-contract-token-0123456789'};
    const intent = store.createLaunchIntent(launch);
    const receipt = store.recordLaunchReceipt({...launch,revision:intent.revision,receipt_id:'receipt',launch_identity:{source:'synthetic_fixture',fixture:true,process_id:41001,start_fingerprint:'owned-synthetic-start'}});
    store.commitPermanentClaim({...launch,revision:receipt.revision,claim_id:'claim',worker_identity:{source:'synthetic_fixture',fixture:true,worker_id:'worker',incarnation:'incarnation',process_id:41001,start_fingerprint:'owned-synthetic-start'}});
    const operation = store.readOperation('operation');
    let error = null;
    try { store.commitResult({operation_id:'operation',task_id:task.task_id,attempt:1,generation:operation.generation,revision:operation.revision,claim_id:operation.claim_id,claim_worker_identity_digest:operation.claim_worker_identity_digest,result_status:result.status,result}); }
    catch (e) { error = e.code; }
    assert.equal(error,expected,label);
    const json = canonical(result);
    const snapshot = store.readTaskLifecycle(task.task_id);
    if (!error) {
      const committed = store.readCommittedResult('operation');
      assert.equal(canonical(committed.result),json,'no truncation or normalization at persistence');
      const database = new DatabaseSync(path.join(directory,'operations.sqlite3'),{readOnly:true});
      try {
        const persisted = database.prepare('SELECT length(CAST(result_json AS BLOB)) AS bytes,result_json FROM manager_operations WHERE operation_id=?').get('operation');
        assert.equal(persisted.bytes,Buffer.byteLength(json)); assert.equal(persisted.result_json,json);
      } finally { database.close(); }
    }
    rows.push({label,raw_output_characters:result.zcode_output.length,raw_output_utf8_bytes:Buffer.byteLength(result.zcode_output),canonical_characters:json.length,canonical_utf8_bytes:Buffer.byteLength(json),error,status:snapshot.projection.status,phase:snapshot.operation.phase});
  } finally { store.close(); }
}
const output = { node:process.version,platform:process.platform,fixture_root:root,cases:rows };
fs.writeFileSync(path.join(base,'result-contract-evidence.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(output,null,2));
