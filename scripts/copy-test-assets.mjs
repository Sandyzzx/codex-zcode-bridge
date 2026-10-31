import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repoRoot, "src", "sqlite-candidate", "wp6b2b1", "schema.sql");
const destination = path.join(repoRoot, "dist-test", "src", "sqlite-candidate", "wp6b2b1", "schema.sql");

await mkdir(path.dirname(destination), { recursive: true });
await copyFile(source, destination);
console.log("Copied SQLite candidate schema into the compiled test layout.");
