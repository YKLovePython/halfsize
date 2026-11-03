#!/usr/bin/env node
import { main } from "../src/cli.mjs";

main(process.argv.slice(2)).catch((err) => {
  console.error(`\n  x ${err?.message || err}`);
  if (process.env.HALFSIZE_DEBUG) console.error(err?.stack);
  process.exit(1);
});
