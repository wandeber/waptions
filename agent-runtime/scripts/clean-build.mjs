import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(packageRoot, "dist");

if (basename(distRoot) !== "dist" || dirname(distRoot) !== packageRoot) {
  throw new Error("Refusing to clean an unexpected build directory.");
}

await rm(distRoot, { recursive: true, force: true });
