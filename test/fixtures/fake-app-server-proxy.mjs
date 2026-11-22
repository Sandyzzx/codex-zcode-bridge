import process from "node:process";

const workspace = process.env.WAKE_FIXTURE_WORKSPACE;
const threadId = process.env.WAKE_FIXTURE_THREAD_ID;
if (!workspace || !threadId) process.exit(2);

let turnsReads = 0;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});

function handle(message) {
  if (typeof message.id !== "number") return;
  let result;
  switch (message.method) {
    case "initialize":
      result = {};
      break;
    case "thread/loaded/list":
      result = { data: [threadId], nextCursor: null };
      break;
    case "thread/read":
      result = {
        thread: {
          id: threadId,
          status: { type: "idle" },
          canAcceptDirectInput: true,
          cwd: workspace,
          model: "deepseek-v4.1-flash",
          modelProvider: "deepseek",
          reasoningEffort: "low",
        },
      };
      break;
    case "thread/turns/list":
      turnsReads += 1;
      result = {
        data: turnsReads === 1
          ? [{ id: "turn-old", status: "completed" }]
          : [{ id: "turn-wake", status: "inProgress" }, { id: "turn-old", status: "completed" }],
      };
      break;
    default:
      process.stdout.write(`${JSON.stringify({
        id: message.id,
        error: { code: -32601, message: "unsupported" },
      })}\n`);
      return;
  }
  process.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
}
