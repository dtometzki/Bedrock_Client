#!/usr/bin/env node

import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(scriptDir, "dist");

await rm(distDir, { recursive: true, force: true });

console.log(`Bereinigt: ${distDir}`);
