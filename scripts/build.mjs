// One file for Node: src/main.ts with the core bundled in. `cloudflare:workers`
// resolves to a stub, so the OAuth provider that imports it is bundled too;
// the other npm packages stay external and load from node_modules.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: "dist/main.js",
  external: ["agents", "agents/*", "@modelcontextprotocol/*", "zod", "zod/*"],
  alias: { "cloudflare:workers": "./src/stubs/cloudflare-workers.ts" },
  sourcemap: true,
  logLevel: "warning",
});
console.log("dist/main.js");
