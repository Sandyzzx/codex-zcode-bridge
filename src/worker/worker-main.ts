// Worker process shell (ARCHITECTURE component 6): one detached Bridge worker
// per active task. Uses the app-server adapter and persists progress/results
// so MCP server restarts do not erase task evidence.
//
// Usage: node worker-main.js <dataRoot> <taskId>
import { runWorkerTask } from "./run-task.js";

const [dataRoot, taskId] = process.argv.slice(2);
if (!dataRoot || !taskId) {
  console.error("usage: node worker-main.js <dataRoot> <taskId>");
  process.exit(2);
}

try {
  // Let runWorkerTask construct the app-server adapter with its progress
  // persistence callback. Passing an adapter here would bypass that callback.
  const { status } = await runWorkerTask({ dataRoot, taskId });
  process.exitCode = 0;
  void status;
} catch (error) {
  // Store-level or unexpected failure: leave the record for the manager to
  // reconcile to worker_lost on restart.
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
