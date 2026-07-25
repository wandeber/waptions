import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(packageRoot, "dist");
const manifest = JSON.parse(
  await readFile(resolve(distRoot, "build-manifest.json"), "utf8"),
);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (
      entry.isFile() &&
      path !== resolve(distRoot, "build-manifest.json")
    ) {
      files.push(relative(distRoot, path).replaceAll("\\", "/"));
    }
  }
  return files;
}

const actualFiles = (await listFiles(distRoot)).sort();
const manifestedFiles = manifest.files.map(({ path }) => path).sort();
if (JSON.stringify(actualFiles) !== JSON.stringify(manifestedFiles)) {
  throw new Error("Build output contains missing or unmanifested files.");
}

for (const entry of manifest.files) {
  if (
    typeof entry.path !== "string" ||
    entry.path.startsWith("/") ||
    entry.path.split("/").includes("..")
  ) {
    throw new Error("Build manifest contains an invalid file path.");
  }
  const bytes = await readFile(resolve(distRoot, entry.path));
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (bytes.byteLength !== entry.bytes || digest !== entry.sha256) {
    throw new Error(`Build manifest mismatch for ${entry.path}.`);
  }
}
if (
  !/^ui:\/\/waptions\/editor\/v1\/[0-9a-f]{64}\/index\.html$/.test(
    manifest.appResource.uri,
  )
) {
  throw new Error("Build manifest MCP App URI is not content-addressed.");
}
if (!/^[0-9a-f]{40,64}$/.test(manifest.sourceCommit)) {
  throw new Error("Build manifest source commit is invalid.");
}
const appModule = await import(
  new URL("../dist/mcp/app-resource.js", import.meta.url)
);
const packagedAppHtml = await readFile(
  resolve(distRoot, "mcp-app/index.html"),
  "utf8",
);
const expectedApp = appModule.createMcpAppResource(packagedAppHtml);
if (
  manifest.appResource.uri !== expectedApp.uri ||
  manifest.appResource.mimeType !== expectedApp.mimeType ||
  manifest.appResource.sha256 !== expectedApp.htmlSha256
) {
  throw new Error("Build manifest MCP App bytes do not match.");
}
const canonicalAssets = manifest.appResource.canonicalAssets;
if (
  !Array.isArray(canonicalAssets) ||
  canonicalAssets.length !== 1 ||
  canonicalAssets[0].path !== "index.html" ||
  canonicalAssets[0].bytes !== Buffer.byteLength(packagedAppHtml, "utf8") ||
  canonicalAssets[0].sha256 !== expectedApp.htmlSha256
) {
  throw new Error("Build manifest canonical MCP App assets do not match.");
}
const payloadManifestSha256 = `sha256:${createHash("sha256")
  .update(JSON.stringify(canonicalAssets), "utf8")
  .digest("hex")}`;
if (payloadManifestSha256 !== manifest.appResource.payloadManifestSha256) {
  throw new Error("Build manifest MCP App payload hash does not match.");
}
const serverFiles = manifest.files.filter(({ path }) => path.endsWith(".js"));
const serverBundleSha256 = `sha256:${createHash("sha256")
  .update(JSON.stringify(serverFiles), "utf8")
  .digest("hex")}`;
if (serverBundleSha256 !== manifest.serverBundleSha256) {
  throw new Error("Build manifest server bundle hash does not match.");
}
if (
  !/^sha256:[0-9a-f]{64}$/.test(
    manifest.schemaHashes.publicToolInventory,
  ) ||
  (manifest.schemaHashes.coreSemantic !== null &&
    !/^sha256:[0-9a-f]{64}$/.test(manifest.schemaHashes.coreSemantic))
) {
  throw new Error("Build manifest schema hash is invalid.");
}
if (
  manifest.fullRuntimeRequired &&
  ((manifest.missingSurfaces?.length ?? 0) > 0 ||
    manifest.appResource.integrationPlaceholder ||
    manifest.schemaHashes.coreSemantic === null)
) {
  throw new Error("Full runtime build is missing integration inputs.");
}
