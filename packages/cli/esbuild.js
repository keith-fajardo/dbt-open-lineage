import esbuild from "esbuild";
const watch = process.argv.includes("--watch");
const ctx = {
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "out/cli.js",
  banner: { js: "#!/usr/bin/env node" },
  target: "node18",
  sourcemap: true,
};
(async () => {
  if (watch) { const c = await esbuild.context(ctx); await c.watch(); }
  else { await esbuild.build(ctx); }
})();
