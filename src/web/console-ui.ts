import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderTaskConsoleHtml } from "./task-console-ui.js";

/**
 * Read the shipped brand artwork instead of embedding a second copy.  The
 * plugin bundle lives in `<plugin>/dist`, while source and test builds resolve
 * through the repository root; both layouts are checked explicitly.
 */
function resolveBrandIconPath(moduleUrl: string): string {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const candidates: string[] = [];
  if (
    path.basename(moduleDirectory) === "dist"
    && existsSync(path.join(path.dirname(moduleDirectory), "worker", "worker-main.mjs"))
  ) {
    candidates.push(path.join(path.dirname(moduleDirectory), "assets", "icon.png"));
  }
  let current = moduleDirectory;
  for (;;) {
    const pluginRoot = path.join(current, "plugins", "codex-zcode-bridge");
    if (existsSync(path.join(pluginRoot, "worker", "worker-main.mjs"))) {
      candidates.push(path.join(pluginRoot, "assets", "icon.png"));
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("brand_icon_unavailable");
}

const brandIconPath = resolveBrandIconPath(import.meta.url);

export const BRAND_ICON_DATA_URI =
  `data:image/png;base64,${readFileSync(brandIconPath).toString("base64")}`;

export const OPERATIONS_CONSOLE_HTML = renderTaskConsoleHtml(BRAND_ICON_DATA_URI);
