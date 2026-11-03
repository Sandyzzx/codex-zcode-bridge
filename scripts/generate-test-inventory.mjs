#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(repositoryRoot, "docs", "testing");
const sourceFileExtensions = [".ts", ".mts", ".mjs", ".js", ".cjs"];

function readImpactMap() {
  return JSON.parse(readFileSync(path.join(repositoryRoot, "test/test-impact-map.json"), "utf8"));
}

function collectTestFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
    } else if (sourceFileExtensions.includes(path.extname(entry.name))) {
      files.push(path.relative(repositoryRoot, fullPath).replaceAll("\\", "/"));
    }
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function normalizeRelativeImport(specifier, testFile) {
  if (!specifier.startsWith(".")) return null;
  const withoutExtension = specifier.replace(/\.(?:js|cjs|mjs)$/u, "");
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(testFile), withoutExtension));
  if (!resolved.startsWith("src/")) return null;
  return `${resolved}.ts`;
}

function importedSourceModules(source, testFile) {
  const parsed = ts.createSourceFile(testFile, source, ts.ScriptTarget.Latest, true);
  const imports = new Set();
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const normalized = normalizeRelativeImport(node.moduleSpecifier.text, testFile);
      if (normalized) imports.add(normalized);
    }
    if (ts.isCallExpression(node) && node.expression.getText() === "import" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      const normalized = normalizeRelativeImport(node.arguments[0].text, testFile);
      if (normalized) imports.add(normalized);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return [...imports].sort();
}

function literalName(argument, source, testFile) {
  if (argument && ts.isStringLiteralLike(argument) && !ts.isTemplateLiteral(argument)) {
    return argument.text;
  }
  return `<dynamic-name>${source.slice(argument?.getStart() ?? 0, argument?.getEnd() ?? 0)}@${testFile}`;
}

function timeoutMilliseconds(argument, parsed) {
  if (!argument || !ts.isObjectLiteralExpression(argument)) return null;
  for (const property of argument.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "timeout") {
      const expression = property.initializer.getText(parsed).replaceAll("_", "");
      const value = Number(expression);
      return Number.isFinite(value) ? value : null;
    }
  }
  return null;
}

function extractDeclarations(source, testFile) {
  const parsed = ts.createSourceFile(testFile, source, ts.ScriptTarget.Latest, true);
  const declarations = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === "test" || node.expression.text === "it")) {
      declarations.push({
        name: literalName(node.arguments[0], source, testFile),
        line: parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        timeout_milliseconds: timeoutMilliseconds(node.arguments[1], parsed),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return declarations;
}

function resourceCategories(file, type) {
  const categories = new Set(["CPU", "Memory"]);
  if (type === "Stress" || file.includes("performance")) categories.add("Disk");
  if (/(?:process|worker|manager|adapter|host|stdio|browser|runtime|windows|lock|quiescence|bootstrap|composition|lifecycle)/u.test(file)) {
    categories.add("Process");
    categories.add("Disk");
  }
  if (file.includes("sqlite") || file.includes("schema")) categories.add("Disk");
  return [...categories].sort();
}

function testId(file, name, line) {
  return `TII-${createHash("sha256").update(`${file}\0${name}\0${line}`).digest("hex").slice(0, 16).toUpperCase()}`;
}

const map = readImpactMap();
const metadataByFile = new Map(map.tests.map((entry) => [entry.file, entry]));
const stressByFile = new Map(map.stress_tests.map((entry) => [entry.file, entry]));
const domainById = new Map(map.domains.map((entry) => [entry.id, entry]));
const inventoryTests = [];

for (const file of collectTestFiles(path.join(repositoryRoot, "test"))) {
  const source = readFileSync(path.join(repositoryRoot, file), "utf8");
  const metadata = metadataByFile.get(file);
  const stress = stressByFile.get(file);
  const imports = importedSourceModules(source, file);
  for (const declaration of extractDeclarations(source, file)) {
    const metadataType = metadata?.type ?? "Unclassified";
    inventoryTests.push({
      test_id: testId(file, declaration.name, declaration.line),
      test_name: declaration.name,
      test_file: file,
      test_line: declaration.line,
      test_type: metadataType,
      gate: metadata?.gate ?? "CONSERVATIVE_REVIEW_REQUIRED",
      runtime: stress ? "HISTORICAL_BASELINE_ONLY" : "NOT_MEASURED",
      runtime_evidence: {
        actual_runtime_milliseconds: null,
        timeout_milliseconds: declaration.timeout_milliseconds,
        historical_baseline: stress?.historical_baseline ?? null,
      },
      resource: resourceCategories(file, metadataType),
      dependency: {
        static_source_imports: imports,
        impact_domains: metadata?.domains ?? [],
      },
      trigger_source_paths: (metadata?.domains ?? []).flatMap((domain) => domainById.get(domain)?.paths ?? []),
      trigger_test_files: [file],
      stress_boundary: stress?.boundary ?? null,
    });
  }
}

const inventory = {
  schema_version: 1,
  generated_at: "2026-11-03",
  generator: "npm run test:inventory",
  summary: {
    executable_or_manual_files: map.tests.length,
    declarations: inventoryTests.length,
    by_type: inventoryTests.reduce((counts, entry) => {
      counts[entry.test_type] = (counts[entry.test_type] ?? 0) + 1;
      return counts;
    }, {}),
    by_gate: inventoryTests.reduce((counts, entry) => {
      counts[entry.gate] = (counts[entry.gate] ?? 0) + 1;
      return counts;
    }, {}),
    stress_tests: map.stress_tests.length,
    runtime_measurement_coverage: "Only historical B3-05 setup evidence is attached; current per-test runtime is NOT MEASURED.",
  },
  tests: inventoryTests,
};

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(path.join(outputDirectory, "test-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`Wrote docs/testing/test-inventory.json with ${String(inventoryTests.length)} declarations from ${String(map.tests.length)} mapped files.`);
