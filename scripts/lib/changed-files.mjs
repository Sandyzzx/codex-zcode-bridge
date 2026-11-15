import { spawnSync } from "node:child_process";

export function changedFiles({
  root,
  base,
  head = "HEAD",
  includeWorktree = true,
}) {
  const files = new Set();

  const addNameStatus = (output) => {
    for (const line of output.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const columns = line.split("\t");
      const status = columns[0] ?? "";
      if (status.startsWith("R") || status.startsWith("C")) {
        if (columns[1]) files.add(columns[1]);
        if (columns[2]) files.add(columns[2]);
      } else if (columns[1]) {
        files.add(columns[1]);
      }
    }
  };

  const git = (args, { allowFailure = false } = {}) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status === 0) return result.stdout;
    if (allowFailure) return "";
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${String(result.status)}`}`,
    );
  };

  if (base) {
    addNameStatus(git([
      "diff",
      "--name-status",
      "--find-renames",
      `${base}...${head}`,
    ]));
  } else {
    const upstream = git(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      { allowFailure: true },
    ).trim();
    if (upstream) {
      const mergeBase = git(["merge-base", head, upstream]).trim();
      addNameStatus(git([
        "diff",
        "--name-status",
        "--find-renames",
        `${mergeBase}...${head}`,
      ]));
    }
  }

  if (includeWorktree) {
    addNameStatus(git(["diff", "--name-status", "--find-renames", "HEAD"]));
    for (const file of git(["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/u)) {
      if (file.trim()) files.add(file.trim());
    }
  }

  return [...files].sort((left, right) => left.localeCompare(right, "en"));
}
