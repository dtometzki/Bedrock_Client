#!/usr/bin/env node

import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = scriptDir;
const distDir = path.join(scriptDir, "dist");
const entryFile = path.join(scriptDir, "app_aws.js");
const outFile = path.join(distDir, "bedrock-chat");
const modelsFile = path.join(scriptDir, "models.json");
const bundledModelsFile = path.join(distDir, "models.json");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

await build({
  bundle: true,
  entryPoints: [entryFile],
  format: "esm",
  outfile: outFile,
  platform: "node",
  sourcemap: true,
  target: "node20",
  absWorkingDir: projectDir,
  external: ["@aws-sdk/client-bedrock-runtime"]
});

await copyFile(modelsFile, bundledModelsFile);
await chmod(outFile, 0o755);

console.log(`Build erstellt: ${outFile}`);
