import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = path.join(ROOT, "bin", "halfsize.mjs");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

test("--version comes from package.json, not a second literal", () => {
  const out = execFileSync(process.execPath, [BIN, "--version"], { encoding: "utf8", windowsHide: true }).trim();
  assert.equal(out, pkg.version);

  const cli = fs.readFileSync(path.join(ROOT, "src", "cli.mjs"), "utf8");
  assert.doesNotMatch(cli, /const VERSION\s*=\s*["']\d+\.\d+\.\d+["']/, "src/cli.mjs must not hardcode a version");
});

test("the README sample output uses the current version", () => {
  for (const file of ["README.md", "README.zh-CN.md"]) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    const found = [...text.matchAll(/halfsize\s+(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    for (const version of found) {
      assert.equal(version, pkg.version, `${file} still shows halfsize ${version}`);
    }
  }
});

test("the published site shows the current version", () => {
  const site = path.join(ROOT, "site");
  const files = fs.readdirSync(site, { recursive: true }).filter((f) => f.endsWith(".html"));
  const stale = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(site, rel), "utf8");
    for (const match of text.matchAll(/halfsize\s+(\d+\.\d+\.\d+)/g)) {
      if (match[1] !== pkg.version) stale.push(`site/${rel.replace(/\\/g, "/")}: halfsize ${match[1]}`);
    }
    for (const match of text.matchAll(/"softwareVersion":\s*"(\d+\.\d+\.\d+)"/g)) {
      if (match[1] !== pkg.version) stale.push(`site/${rel.replace(/\\/g, "/")}: softwareVersion ${match[1]}`);
    }
  }
  assert.deepEqual(stale, [], `run: node scripts/bump-site.mjs\n${stale.join("\n")}`);
});
