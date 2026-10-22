// Bundle the CLI into one file with no runtime dependencies, for `curl .../install.sh | sh`.
// Output: dist-bundle/intra.mjs (ESM, Node 20+, executable). @intra-skills/shared and yaml are inlined.
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist-bundle", "intra.mjs");

await build({
  entryPoints: [join(root, "src", "bin.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  packages: "bundle",
  legalComments: "none",
  logLevel: "warning",
  // A CommonJS dependency that calls require() needs it inside an ES module.
  banner: { js: 'import { createRequire as __intraCreateRequire } from "node:module";\nconst require = __intraCreateRequire(import.meta.url);' },
});

// esbuild keeps the entry's own "#!/usr/bin/env node" line at the top; make sure it is there.
const head = readFileSync(outfile, "utf8").slice(0, 32);
if (!head.startsWith("#!/usr/bin/env node")) throw new Error(`${outfile} does not start with a #!/usr/bin/env node line`);
chmodSync(outfile, 0o755);
console.log(`bundled ${outfile}`);
