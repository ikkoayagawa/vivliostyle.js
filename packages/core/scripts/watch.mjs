import path from "node:path";
import { fileURLToPath } from "node:url";
import { context } from "esbuild";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const once = process.argv.includes("--once");
const contexts = [];
let typesWatcher;
let closing = false;
const formatHost = {
  getCanonicalFileName: (file) => file,
  getCurrentDirectory: () => root,
  getNewLine: () => "\n",
};
const reportDiagnostic = (diagnostic) =>
  console.error(ts.formatDiagnosticsWithColorAndContext([diagnostic], formatHost));

async function close() {
  if (closing) return;
  closing = true;
  typesWatcher?.close();
  await Promise.all(contexts.map((build) => build.dispose()));
}

try {
  for (const [format, file, platform] of [
    ["esm", "vivliostyle.mjs", "node"],
    ["cjs", "vivliostyle.cjs", "node"],
    ["iife", "vivliostyle.iife.js", "browser"],
  ]) {
    const build = await context({
      absWorkingDir: root,
      entryPoints: ["src/vivliostyle.ts"],
      outfile: path.join("lib", file),
      bundle: true,
      format,
      platform,
      ...(format === "iife"
        ? { globalName: "VivliostyleCore" }
        : { external: ["fast-diff"] }),
      define: { VIVLIOSTYLE_DEBUG: "false" },
      minify: true,
      sourcemap: true,
      target: "es2022",
      plugins: [{
        name: "report-output",
        setup(build) {
          build.onEnd((result) => {
            if (!result.errors.length) console.log(`[core] updated ${file}`);
          });
        },
      }],
    });
    contexts.push(build);
  }

  const config = path.join(root, "tsconfig.json");
  const options = {
    emitDeclarationOnly: true,
    declaration: true,
    declarationMap: true,
    outDir: path.join(root, "lib"),
  };
  if (once) {
    await Promise.all(contexts.map((build) => build.rebuild()));
    const parsed = ts.getParsedCommandLineOfConfigFile(config, options, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: reportDiagnostic,
    });
    if (!parsed) throw new Error("Cannot read TypeScript configuration");
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const result = program.emit();
    const diagnostics = [
      ...parsed.errors,
      ...ts.getPreEmitDiagnostics(program),
      ...result.diagnostics,
    ];
    diagnostics.forEach(reportDiagnostic);
    if (result.emitSkipped || diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error)) {
      throw new Error("Core type declarations failed");
    }
    await close();
  } else {
    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
    await Promise.all(contexts.map((build) => build.watch()));
    typesWatcher = ts.createWatchProgram(ts.createWatchCompilerHost(
      config,
      options,
      ts.sys,
      ts.createSemanticDiagnosticsBuilderProgram,
      reportDiagnostic,
      (diagnostic) => console.log(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    ));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  await close();
}
