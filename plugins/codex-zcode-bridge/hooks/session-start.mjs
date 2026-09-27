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

parts.push("ZCode tasks run in yolo mode with the current account's permissions. Git worktrees and allowed/forbidden path instructions are not an OS sandbox.");

stdout.write(`Codex ZCode Bridge setup check: ${parts.join("; ")}\n`);
