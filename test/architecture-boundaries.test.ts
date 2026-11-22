import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");

function source(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), "utf8").replaceAll("\r\n", "\n");
}

function sourceFiles(relativeRoot: string): string[] {
  const root = path.join(projectRoot, relativeRoot);
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.relative(projectRoot, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
}

function imports(relativePath: string): string[] {
  return [...source(relativePath).matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/gu)]
    .map((match) => match[1]!);
}

function assertNoImports(
  relativePath: string,
  forbidden: RegExp,
): void {
  const offenders = imports(relativePath).filter((specifier) => forbidden.test(specifier));
  assert.deepEqual(offenders, [], `${relativePath} crossed a frozen layer boundary`);
}

test("MCP protocol modules do not own Manager, Store, Worker, Adapter or Executor internals", () => {
  const forbidden = /(^|\/)(manager|store|worker|adapters|executor|host)\//u;
  for (const file of sourceFiles("src/mcp").filter((file) => file !== "src/mcp/main.ts")) {
    assertNoImports(file, forbidden);
  }
  assert.deepEqual(
    imports("src/mcp/main.ts").filter((specifier) => specifier.startsWith(".") && specifier !== "../host/stdio.js"),
    [],
  );
});

test("Thin MCP Host only knows Executor control-client contracts", () => {
  const host = "src/host/stdio.ts";
  assertNoImports(host, /(^|\/)(manager|store|worker|adapters)\//u);
  assertNoImports(host, /(^|\/)executor\/(?:service|control-server|production-composition)\//u);
  assert.match(source(host), /no local SQLite Manager is constructed/u);
});

test("Adapters and Worker do not depend on Host, MCP or Executor layers", () => {
  const forbidden = /(^|\/)(host|mcp|executor)\//u;
  for (const file of sourceFiles("src/adapters")) assertNoImports(file, forbidden);
  assertNoImports("src/worker/worker-main.ts", forbidden);
});

test("production SQLite Authority construction exists only in Executor composition", () => {
  const occurrences = sourceFiles("src")
    .filter((file) => /SqliteAuthority\.create\s*\(/u.test(source(file)));
  assert.deepEqual(occurrences, ["src/executor/production-composition.ts"]);
});
