const esbuild = require("esbuild");
const watch = process.argv.includes("--watch");
const ctx = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "out/extension.js",
  external: ["vscode"],
  sourcemap: true,
  target: "node18",
};
(async () => {
  if (watch) { const c = await esbuild.context(ctx); await c.watch(); }
  else { await esbuild.build(ctx); }
})();
