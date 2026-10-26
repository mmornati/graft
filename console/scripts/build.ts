// Builds the console: the BFF as one Node bundle (dist/server.js) and the web app into dist/web with
// content-hashed assets. `--watch` rebuilds both on change and restarts the server.
import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const webOut = join(dist, "web");
const watch = process.argv.includes("--watch");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
  dependencies: Record<string, string>;
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(webOut, { recursive: true });

function writeIndex(meta: esbuild.Metafile): void {
  const outputs = Object.keys(meta.outputs).map((p) => p.replace(/\\/g, "/"));
  const pick = (re: RegExp) => {
    const hit = outputs.find((p) => re.test(p));
    if (!hit) throw new Error(`web build produced no ${re}`);
    return `/${hit.slice(hit.indexOf("assets/"))}`;
  };
  const js = pick(/assets\/app-[^/]+\.js$/);
  const css = pick(/assets\/app-[^/]+\.css$/);
  const html = readFileSync(join(root, "web/index.html"), "utf8")
    .replace("%APP_CSS%", css)
    .replace("%APP_JS%", js);
  writeFileSync(join(webOut, "index.html"), html);
  writeFileSync(join(webOut, "manifest.json"), JSON.stringify({ css, js }));
  copyFileSync(join(root, "web/favicon.svg"), join(webOut, "favicon.svg"));
}

const indexPlugin: esbuild.Plugin = {
  name: "index",
  setup(b) {
    b.onEnd((r) => {
      if (r.errors.length === 0 && r.metafile) writeIndex(r.metafile);
    });
  },
};

const web: esbuild.BuildOptions = {
  entryPoints: { app: join(root, "web/src/main.tsx") },
  bundle: true,
  format: "esm",
  target: "es2022",
  outdir: join(webOut, "assets"),
  entryNames: "[name]-[hash]",
  assetNames: "[name]-[hash]",
  loader: { ".woff2": "file", ".woff": "file" },
  jsx: "automatic",
  jsxImportSource: "preact",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  metafile: true,
  legalComments: "none",
  tsconfig: join(root, "web/tsconfig.json"),
  plugins: [indexPlugin],
  logLevel: "info",
};

let child: ChildProcess | undefined;
const restartPlugin: esbuild.Plugin = {
  name: "restart",
  setup(b) {
    b.onEnd((r) => {
      if (!watch || r.errors.length > 0) return;
      child?.kill("SIGTERM");
      child = spawn(process.execPath, ["--enable-source-maps", join(dist, "server.js")], {
        stdio: "inherit",
      });
    });
  },
};

const server: esbuild.BuildOptions = {
  entryPoints: [join(root, "server/src/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: join(dist, "server.js"),
  // Runtime dependencies stay in node_modules; everything else (our code) is bundled.
  external: Object.keys(pkg.dependencies),
  define: { __CONSOLE_VERSION__: JSON.stringify(pkg.version) },
  sourcemap: true,
  legalComments: "none",
  plugins: [restartPlugin],
  logLevel: "info",
};

if (watch) {
  const w = await esbuild.context(web);
  await w.watch();
  const s = await esbuild.context(server);
  await s.watch();
} else {
  await esbuild.build(web);
  await esbuild.build(server);
}
