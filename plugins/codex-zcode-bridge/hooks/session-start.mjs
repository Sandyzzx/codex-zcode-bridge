import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { stdin, stdout } from "node:process";

let input = "";
for await (const chunk of stdin) input += chunk;

const nodeVersion = process.versions.node.split(".").map(Number);
const nodeSupported = nodeVersion[0] > 22 || (nodeVersion[0] === 22 && (nodeVersion[1] > 18 || (nodeVersion[1] === 18 && nodeVersion[2] >= 0)));
const parts = [`Node.js ${process.versions.node}${nodeSupported ? " (supported)" : " (requires 22.18+)"}`];
const git = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
if (git.status === 0) parts.push("Git detected");
else parts.push("Git is missing");

if (process.platform === "win32") {
  const pluginRoot = process.env.PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT;
  const setupScript = pluginRoot ? path.join(pluginRoot, "hooks", "configure-runtime.ps1") : null;
  if (!setupScript || !existsSync(setupScript)) {
    parts.push("ZCode runtime setup script is unavailable; reinstall the plugin");
  } else {
    const setup = spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", setupScript],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
    const setupText = [setup.stdout, setup.stderr]
      .filter((value) => typeof value === "string" && value.trim())
      .join("\n")
      .trim();
    if (setup.status === 0) parts.push(setupText || "ZCode runtime and provider configs validated");
    else parts.push(`ZCode setup needs attention${setupText ? `: ${setupText}` : ""}`);
  }
} else {
  parts.push("Automatic runtime path validation currently supports Windows; Bridge will use its built-in discovery on this platform");
}

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
