// package.json owns the version. This rewrites every place that shows it.
// Run after `npm version patch` and before publishing; test/version.test.mjs
// fails if the two drift apart.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

const targets = [
  ...fs
    .readdirSync(path.join(ROOT, "site"), { recursive: true })
    .filter((file) => file.endsWith(".html"))
    .map((file) => path.join("site", file)),
  "site/llms.txt",
  "README.md",
  "README.zh-CN.md",
];

let changed = 0;
for (const rel of targets) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const before = fs.readFileSync(file, "utf8");
  const after = before
    .replace(/halfsize\s+\d+\.\d+\.\d+/g, `halfsize ${version}`)
    .replace(/("softwareVersion":\s*")\d+\.\d+\.\d+(")/g, `$1${version}$2`);
  if (after !== before) {
    fs.writeFileSync(file, after);
    changed++;
    console.log(`updated ${rel}`);
  }
}
console.log(changed ? `${changed} files updated to ${version}` : `already at ${version}`);
