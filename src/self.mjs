import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Two facts about "am I a bundled executable" have to live in one place:
// package.json is not on disk inside the injected blob, and bin/halfsize.mjs
// does not exist there either.
//
// `__HALFSIZE_VERSION__` is a literal that scripts/build-exe.mjs substitutes at
// bundle time. `typeof` on a name that was never declared is safe, so the same
// source runs in a normal npm install, where the define was never applied.
const BUNDLED_VERSION = typeof __HALFSIZE_VERSION__ === "string" ? __HALFSIZE_VERSION__ : "";

export const VERSION = BUNDLED_VERSION || readPackageVersion();

// Node points argv[1] at the script it was asked to run. In a single executable
// application there is no script, so it points at the executable itself.
export const IS_SEA = Boolean(process.argv[1]) && process.argv[1] === process.execPath;

// The command a user should type to fix or inspect this installation. Inside the
// executable that is just `halfsize`; from the npm package it is the npx form,
// because `halfsize` may not be on their PATH.
export function selfCommand(flag = "") {
  const base = IS_SEA ? "halfsize" : "npx halfsize@latest";
  return flag ? `${base} ${flag}` : base;
}

function readPackageVersion() {
  try {
    const file = fileURLToPath(new URL("../package.json", import.meta.url));
    return JSON.parse(fs.readFileSync(file, "utf8")).version;
  } catch {
    // A bundle built without the define, or a package.json stripped by a packer.
    // Never guess a version number: "unknown" is honest and does not lie to bug
    // reports.
    return "unknown";
  }
}