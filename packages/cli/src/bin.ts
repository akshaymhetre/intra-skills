#!/usr/bin/env node
import { main } from "./cli.js";

const code = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  cwd: process.cwd(),
});
process.exitCode = code;
