import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(packageRoot, "dist");
const manifestPath = resolve(distRoot, "build-manifest.json");
const fullRuntimeRequired = process.env.WAPTIONS_REQUIRE_FULL_RUNTIME === "1";
const packageContract = JSON.parse(
  await readFile(resolve(packageRoot, "runtime-package.json"), "utf8"),
);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile() && path !== manifestPath) {
      files.push(path);
    }
  }
  return files;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sourceCommit() {
  const configured = process.env.WAPTIONS_SOURCE_COMMIT;
  const commit =
    configured ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: packageRoot,
      encoding: "utf8",
    }).trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new Error("WAPTIONS source commit is invalid.");
  }
  return commit;
}

const appModule = await import(
  new URL("../dist/mcp/app-resource.js", import.meta.url)
);
const appHtmlPath = process.env.WAPTIONS_MCP_APP_HTML;
const appResource = appHtmlPath
  ? appModule.createMcpAppResource(
      await readFile(resolve(appHtmlPath), "utf8"),
    )
  : appModule.CONTRACT_APP_RESOURCE;
const packagedAppDirectory = resolve(distRoot, "mcp-app");
await mkdir(packagedAppDirectory, { recursive: true });
await writeFile(
  resolve(packagedAppDirectory, "index.html"),
  appResource.html,
  "utf8",
);

const requiredSurfaces = packageContract.requiredSurfaces;
const files = (await listFiles(distRoot)).sort();
const fileEntries = [];
for (const file of files) {
  const bytes = await readFile(file);
  fileEntries.push({
    path: relative(distRoot, file).replaceAll("\\", "/"),
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
}
const includedSurfaces = requiredSurfaces.filter((surface) =>
  fileEntries.some(({ path }) => path.startsWith(`${surface}/`)),
);
const missingSurfaces = requiredSurfaces.filter(
  (surface) => !includedSurfaces.includes(surface),
);
if (fullRuntimeRequired && missingSurfaces.length > 0) {
  throw new Error(
    `Full runtime packaging is missing required surfaces: ${missingSurfaces.join(", ")}`,
  );
}

const canonicalAssets = appResource.canonicalAssets;
const payloadManifestSha256 = appResource.payloadManifestSha256;
const serverFiles = fileEntries.filter(({ path }) => path.endsWith(".js"));
const serverBundleSha256 = sha256(
  Buffer.from(JSON.stringify(serverFiles), "utf8"),
);
const constantsModule = await import(
  new URL("../dist/mcp/constants.js", import.meta.url)
);
const toolInventorySha256 = sha256(
  Buffer.from(
    JSON.stringify(constantsModule.TOOL_NAMES),
    "utf8",
  ),
);
const coreSemanticSchemaSha256 =
  process.env.WAPTIONS_CORE_SEMANTIC_SCHEMA_SHA256 ?? null;
if (
  coreSemanticSchemaSha256 !== null &&
  !/^sha256:[0-9a-f]{64}$/.test(coreSemanticSchemaSha256)
) {
  throw new Error("Core semantic schema hash is invalid.");
}
if (
  fullRuntimeRequired &&
  (!appHtmlPath || coreSemanticSchemaSha256 === null)
) {
  throw new Error(
    "Full runtime packaging requires the integrated MCP App HTML and Core semantic schema hash.",
  );
}
const manifest = {
  manifestVersion: 1,
  packageName: "@waptions/agent-runtime",
  apiVersion: "2026-07-25",
  sourceCommit: sourceCommit(),
  entrypoints: packageContract.entrypoints,
  transports: packageContract.transports,
  appResource: {
    uri: appResource.uri,
    mimeType: appResource.mimeType,
    sha256: appResource.htmlSha256,
    canonicalAssets,
    payloadManifestSha256,
    integrationPlaceholder: !appHtmlPath,
  },
  serverBundleSha256,
  schemaHashes: {
    coreSemantic: coreSemanticSchemaSha256,
    publicToolInventory: toolInventorySha256,
  },
  requiredSurfaces,
  includedSurfaces,
  missingSurfaces,
  fullRuntimeRequired,
  files: fileEntries,
};
await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
await import("node:fs/promises").then(({ rename }) =>
  rename(`${manifestPath}.tmp`, manifestPath),
);
