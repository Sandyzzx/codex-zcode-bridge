// Short Node bootstrap for the Bridge (frozen architecture behavior): loads
// the ZCode CLI entry script with `--prompt` read from a temporary UTF-8 file
// so the full prompt text never appears in the operating-system argv.
//
// Usage: node zcode-loader.cjs <zcode-entrypoint> <prompt-file> [forwarded CLI args...]
"use strict";
const { readFileSync } = require("node:fs");

const entrypoint = process.argv[2];
const promptFile = process.argv[3];
if (!entrypoint || !promptFile) {
  console.error(
    "zcode-loader: usage: node zcode-loader.cjs <zcode-entrypoint> <prompt-file> [args...]",
  );
  process.exit(2);
}
let promptText;
try {
  promptText = readFileSync(promptFile, "utf8");
} catch (error) {
  const message = error && error.message ? error.message : String(error);
  console.error(`zcode-loader: cannot read prompt file: ${message}`);
  process.exit(2);
}
process.argv = [process.argv[0], entrypoint, "--prompt", promptText].concat(
  process.argv.slice(4),
);
require(entrypoint);
