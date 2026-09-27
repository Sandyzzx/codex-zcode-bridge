import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { stdin, stdout } from "node:process";

let input = "";
for await (const chunk of stdin) input += chunk;

const parts = [`Node.js ${process.versions.node}`];
const git = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
if (git.status === 0) parts.push("Git detected");
else parts.push("Git is missing");

try {
  const session = JSON.parse(input);
  if (typeof session.cwd === "string" && existsSync(session.cwd)) {
    parts.push(`workspace: ${session.cwd}`);
  }
} catch {
  // Keep the hook advisory if the host adds or changes optional session fields.
}

if (process.env.ZCODE_BRIDGE_ALLOW_UNRESTRICTED_EXECUTION !== "1") {
  parts.push("Bridge execution guard is OFF: zcode_task will be rejected before model startup. Do not change this setting automatically; the user must explicitly accept ZCode running with the current account's permissions.");
} else {
  parts.push("Bridge execution opt-in is ON. ZCode runs with the current account's permissions; Git worktrees do not sandbox it.");
}

stdout.write(`Codex ZCode Bridge setup check: ${parts.join("; ")}\n`);
