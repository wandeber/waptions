#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import autoprefixer from "autoprefixer";
import containerQueries from "@tailwindcss/container-queries";
import { build, transform } from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_MANAGER = "pnpm@11.17.0";
const BUILD_SCRIPT = "build:agent-plugin";
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const RESOURCE_URI_TOKEN = "{{WAPTIONS_RESOURCE_URI}}";
const FULL_GIT_OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const NODE_ENTRY = "agent-runtime/runtime/plugin-server.ts";
const NODE_FIRST_PARTY_ALLOWLIST =
  "agent-runtime/runtime/node-first-party-allowlist.json";
const APP_ENTRY = "agent-runtime/app/index.tsx";
const APP_PAYLOAD_NAMES = ["app.css", "app.js"];
const SCHEMA_DIRECTORY = "agent-runtime/schemas/2026-07-25";
const THIRD_PARTY_LICENSES = "THIRD_PARTY_LICENSES.txt";

const outputRoot = validateOutputRoot(
  process.env.WAPTIONS_AGENT_PLUGIN_OUTPUT_DIR,
);
const sourceCommit = validateGitOid(
  "WAPTIONS_AGENT_SOURCE_COMMIT",
  process.env.WAPTIONS_AGENT_SOURCE_COMMIT,
);
const sourceTree = validateGitOid(
  "WAPTIONS_AGENT_SOURCE_TREE",
  process.env.WAPTIONS_AGENT_SOURCE_TREE,
);
validateSourceDateEpoch(process.env.SOURCE_DATE_EPOCH);

await assertEmptyOutputRoot(outputRoot);
await assertBuildInputsExist();
const nodeFirstPartyAllowlist = await loadNodeFirstPartyAllowlist();

const [nodeBundle, appBundle, cssBundle] = await Promise.all([
  buildNodeBundle(),
  buildAppBundle(),
  buildAppCss(),
]);
assertNodeBundleGraph(nodeBundle.metafile, nodeFirstPartyAllowlist);
assertBrowserBundleGraph(appBundle.metafile);

const serverBytes = singleOutput(nodeBundle, ".mjs");
assertStaticNodeRuntime(serverBytes);
const appJavaScript = escapeInlineElement(
  singleOutput(appBundle, ".js").toString("utf8"),
  "script",
);
const appCss = escapeInlineElement(cssBundle, "style");
const appPayload = new Map([
  ["app.css", Buffer.from(appCss, "utf8")],
  ["app.js", Buffer.from(appJavaScript, "utf8")],
]);
const app = createAppArtifact(appPayload);

await writeArtifact("mcp/server.mjs", serverBytes, 0o755);
for (const [name, bytes] of appPayload) {
  await writeArtifact(`mcp/app/${app.buildHash}/${name}`, bytes);
}
await writeArtifact(
  `mcp/app/${app.buildHash}/index.html`,
  Buffer.from(app.indexHtml, "utf8"),
);

const schemaInputPaths = await copySchemas();
const thirdParty = await collectThirdPartyPackages([
  nodeBundle.metafile,
  appBundle.metafile,
]);
await writeArtifact(
  THIRD_PARTY_LICENSES,
  Buffer.from(renderThirdPartyLicenses(thirdParty.packages), "utf8"),
);

const outputPaths = await listRegularFiles(outputRoot);
const files = await createFileRecords(outputRoot, outputPaths);
const buildInputPaths = await collectBuildInputPaths(
  [nodeBundle.metafile, appBundle.metafile],
  schemaInputPaths,
  thirdParty.inputPaths,
);
const buildInputs = await createFileRecords(SOURCE_ROOT, buildInputPaths);
const manifest = {
  schemaVersion: 1,
  sourceCommit,
  sourceTree,
  packageManager: PACKAGE_MANAGER,
  buildScript: BUILD_SCRIPT,
  app: {
    resourceUri: app.resourceUri,
    buildHash: app.buildHash,
    mimeType: RESOURCE_MIME_TYPE,
    indexTemplateSha256: sha256(app.indexTemplate),
    payloadFiles: APP_PAYLOAD_NAMES.map(
      (name) => `mcp/app/${app.buildHash}/${name}`,
    ).sort(),
  },
  buildInputs,
  files,
  licenses: [THIRD_PARTY_LICENSES],
};
await assertSourceBuildManifestContract(manifest);
await writeFile(
  resolve(outputRoot, "build-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { encoding: "utf8", mode: 0o644 },
);
await assertNoMachineLocalPaths(outputRoot);

function validateOutputRoot(value) {
  if (!value || !isAbsolute(value)) {
    throw new Error(
      "WAPTIONS_AGENT_PLUGIN_OUTPUT_DIR must be an absolute path.",
    );
  }
  const resolved = resolve(value);
  if (
    resolved === resolve("/") ||
    resolved === SOURCE_ROOT ||
    isPathInside(resolved, SOURCE_ROOT) ||
    isPathInside(SOURCE_ROOT, resolved)
  ) {
    throw new Error(
      "WAPTIONS_AGENT_PLUGIN_OUTPUT_DIR must be outside the source checkout.",
    );
  }
  return resolved;
}

async function assertEmptyOutputRoot(root) {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      "WAPTIONS_AGENT_PLUGIN_OUTPUT_DIR must be an existing regular directory.",
    );
  }
  if ((await readdir(root)).length !== 0) {
    throw new Error(
      "WAPTIONS_AGENT_PLUGIN_OUTPUT_DIR must be empty before the build.",
    );
  }
}

function validateGitOid(name, value) {
  if (!FULL_GIT_OID.test(value ?? "")) {
    throw new Error(`${name} must be a full lowercase Git object ID.`);
  }
  return value;
}

function validateSourceDateEpoch(value) {
  if (
    value === undefined ||
    !/^[1-9][0-9]*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  ) {
    throw new Error("SOURCE_DATE_EPOCH must be a positive safe integer.");
  }
}

function isPathInside(parent, child) {
  const path = relative(parent, child);
  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

async function assertBuildInputsExist() {
  const packageJson = JSON.parse(
    await readFile(resolve(SOURCE_ROOT, "package.json"), "utf8"),
  );
  if (
    packageJson.packageManager !== PACKAGE_MANAGER ||
    packageJson.scripts?.[BUILD_SCRIPT] !== "node scripts/build-agent-plugin.mjs"
  ) {
    throw new Error("The root package does not match the agent build contract.");
  }
  for (const path of [
    NODE_ENTRY,
    NODE_FIRST_PARTY_ALLOWLIST,
    APP_ENTRY,
    `${SCHEMA_DIRECTORY}/common.schema.json`,
    `${SCHEMA_DIRECTORY}/operations.schema.json`,
    `${SCHEMA_DIRECTORY}/tools.schema.json`,
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "src/app/globals.css",
  ]) {
    await access(resolve(SOURCE_ROOT, path));
  }
}

async function buildNodeBundle() {
  return build({
    absWorkingDir: SOURCE_ROOT,
    entryPoints: [NODE_ENTRY],
    outfile: "mcp/server.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    write: false,
    splitting: false,
    sourcemap: false,
    minify: false,
    treeShaking: true,
    legalComments: "none",
    charset: "utf8",
    metafile: true,
    tsconfig: resolve(SOURCE_ROOT, "tsconfig.json"),
    external: ["node:*"],
    banner: { js: "#!/usr/bin/env node" },
    logLevel: "warning",
  });
}

async function buildAppBundle() {
  return build({
    absWorkingDir: SOURCE_ROOT,
    entryPoints: [APP_ENTRY],
    outfile: "app.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    target: ["es2022"],
    write: false,
    splitting: false,
    sourcemap: false,
    minify: true,
    treeShaking: true,
    legalComments: "none",
    charset: "utf8",
    metafile: true,
    tsconfig: resolve(SOURCE_ROOT, "tsconfig.json"),
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    logLevel: "warning",
  });
}

async function buildAppCss() {
  const source = await readFile(
    resolve(SOURCE_ROOT, "src/app/globals.css"),
    "utf8",
  );
  const contentPaths = await listSourceFiles([
    "agent-runtime/app",
    "src/components/editor-surface",
    "src/lib/editor-ui",
  ]);
  const content = await Promise.all(
    contentPaths.map(async (path) => ({
      raw: await readFile(resolve(SOURCE_ROOT, path), "utf8"),
      extension: extname(path).slice(1),
    })),
  );
  const processed = await postcss([
    tailwindcss({
      content,
      theme: {
        extend: {
          colors: {
            background: "var(--background)",
            foreground: "var(--foreground)",
          },
        },
      },
      plugins: [containerQueries],
    }),
    autoprefixer(),
  ]).process(source, { from: undefined });
  if (
    !processed.css.includes("container-type: inline-size") ||
    !processed.css.includes("@container")
  ) {
    throw new Error(
      "The editor app CSS is missing its required container-query rules.",
    );
  }
  const minified = await transform(processed.css, {
    loader: "css",
    minify: true,
    legalComments: "none",
  });
  return minified.code;
}

function singleOutput(result, suffix) {
  const outputs = result.outputFiles.filter((file) => file.path.endsWith(suffix));
  if (outputs.length !== 1) {
    throw new Error(`Expected one ${suffix} bundle output, received ${outputs.length}.`);
  }
  return Buffer.from(outputs[0].contents);
}

async function loadNodeFirstPartyAllowlist() {
  const value = JSON.parse(
    await readFile(resolve(SOURCE_ROOT, NODE_FIRST_PARTY_ALLOWLIST), "utf8"),
  );
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (path) =>
        typeof path !== "string" ||
        !/^(?:agent-runtime|src)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|json)$/u.test(path),
    ) ||
    new Set(value).size !== value.length ||
    JSON.stringify(value) !== JSON.stringify([...value].sort())
  ) {
    throw new Error(
      "The Node first-party module allowlist must be a sorted unique path array.",
    );
  }
  return new Set(value);
}

function assertNodeBundleGraph(metafile, allowedFirstParty) {
  const actualFirstParty = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const normalized = normalizeMetafileInput(input);
    if (
      normalized.startsWith("<") ||
      normalized.startsWith("node_modules/") ||
      normalized.includes("/node_modules/")
    ) {
      continue;
    }
    actualFirstParty.add(normalized);
  }
  const unexpected = [...actualFirstParty]
    .filter((path) => !allowedFirstParty.has(path))
    .sort();
  const missing = [...allowedFirstParty]
    .filter((path) => !actualFirstParty.has(path))
    .sort();
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      [
        "The Node runtime first-party module graph differs from its explicit allowlist.",
        ...(unexpected.length > 0
          ? [`Unexpected: ${unexpected.join(", ")}`]
          : []),
        ...(missing.length > 0
          ? [`Missing: ${missing.join(", ")}`]
          : []),
      ].join(" "),
    );
  }
  assertOnlyExpectedExternals(metafile, (path) => path.startsWith("node:"));
}

function assertBrowserBundleGraph(metafile) {
  const allowedFirstParty = [
    /^agent-runtime\/app\//,
    /^src\/components\/editor-surface\//,
    /^src\/lib\/editor-ui\//,
    /^src\/lib\/keyboard-target\.ts$/,
  ];
  for (const input of Object.keys(metafile.inputs)) {
    const normalized = normalizeMetafileInput(input);
    if (
      normalized.startsWith("<") ||
      normalized.startsWith("node_modules/") ||
      normalized.includes("/node_modules/")
    ) {
      continue;
    }
    if (!allowedFirstParty.some((pattern) => pattern.test(normalized))) {
      throw new Error(
        `The MCP App bundle includes non-allowlisted first-party input ${input}.`,
      );
    }
  }
  assertOnlyExpectedExternals(metafile, () => false);
}

function normalizeMetafileInput(input) {
  const normalized = input.replaceAll("\\", "/");
  const sourcePrefix = `${SOURCE_ROOT.replaceAll("\\", "/")}/`;
  return normalized.startsWith(sourcePrefix)
    ? normalized.slice(sourcePrefix.length)
    : normalized;
}

function assertOnlyExpectedExternals(metafile, isAllowed) {
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports ?? []) {
      if (imported.external && !isAllowed(imported.path)) {
        throw new Error(
          `The agent bundle contains unexpected external import ${imported.path}.`,
        );
      }
    }
  }
}

function assertStaticNodeRuntime(serverBytes) {
  const source = serverBytes.toString("utf8");
  for (const forbidden of [
    "WAPTIONS_RUNTIME_ADAPTER_MODULE",
    "agent-runtime/server/stdio.ts",
    "CONTRACT_APP_RESOURCE",
    "The Waptions editor UI package is not integrated",
  ]) {
    if (source.includes(forbidden)) {
      throw new Error(
        `The packaged Node runtime contains forbidden dynamic-adapter surface ${forbidden}.`,
      );
    }
  }
  if (/\bimport\s*\(/u.test(source)) {
    throw new Error(
      "The packaged Node runtime must not retain dynamic import expressions.",
    );
  }
}

function escapeInlineElement(value, element) {
  const closing = new RegExp(`</${element}`, "gi");
  return value.replace(closing, `<\\/${element}`);
}

function createAppArtifact(payload) {
  const payloadRecords = [...payload.entries()]
    .map(([path, bytes]) => ({
      path,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    }))
    .sort(comparePathRecords);
  const scriptBytes = payload.get("app.js");
  const cssBytes = payload.get("app.css");
  if (!scriptBytes || !cssBytes) {
    throw new Error("The MCP App payload is incomplete.");
  }
  const script = scriptBytes.toString("utf8");
  const css = cssBytes.toString("utf8");
  const scriptCspHash = sha256Base64(scriptBytes);
  const styleCspHash = sha256Base64(cssBytes);
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${scriptCspHash}'`,
    `style-src 'sha256-${styleCspHash}'`,
    "style-src-attr 'unsafe-inline'",
    "connect-src http://localhost:59941",
    "img-src data: blob: http://localhost:59941",
    "media-src blob: http://localhost:59941",
    "font-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "worker-src 'none'",
    "child-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
  ].join("; ");
  const indexTemplate = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta name="waptions-resource-uri" content="${RESOURCE_URI_TOKEN}">`,
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    "<title>Waptions Editor</title>",
    `<style>${css}</style>`,
    "</head>",
    "<body>",
    '<div id="root"></div>',
    `<script>${script}</script>`,
    "</body>",
    "</html>",
  ].join("");
  if (indexTemplate.split(RESOURCE_URI_TOKEN).length !== 2) {
    throw new Error("The MCP App wrapper must contain one URI template token.");
  }
  const indexTemplateSha256 = sha256(indexTemplate);
  const buildHash = sha256(
    stableStringify({
      indexTemplateSha256,
      payloadFiles: payloadRecords,
    }),
  );
  const resourceUri =
    `ui://waptions/editor/v1/${buildHash}/index.html`;
  const indexHtml = indexTemplate.replace(RESOURCE_URI_TOKEN, resourceUri);
  if (indexHtml.split(resourceUri).length !== 2) {
    throw new Error("The MCP App wrapper must contain its resource URI once.");
  }
  return { buildHash, resourceUri, indexTemplate, indexHtml };
}

async function assertSourceBuildManifestContract(manifest) {
  const contract = JSON.parse(
    await readFile(
      resolve(SOURCE_ROOT, SCHEMA_DIRECTORY, "protocol-contract.json"),
      "utf8",
    ),
  );
  const provenance = contract?.provenance?.sourceBuildManifest;
  const expected = {
    requiredFields: Object.keys(manifest),
    appRequiredFields: Object.keys(manifest.app),
    fileRecordRequiredFields: ["path", "sha256", "bytes"],
  };
  if (stableStringify(provenance) !== stableStringify(expected)) {
    throw new Error(
      "The protocol provenance contract does not match the source build manifest.",
    );
  }
}

async function copySchemas() {
  const names = (await readdir(resolve(SOURCE_ROOT, SCHEMA_DIRECTORY), {
    withFileTypes: true,
  }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  if (names.length < 3) {
    throw new Error("The canonical agent schema bundle is incomplete.");
  }
  const inputPaths = [];
  for (const name of names) {
    const source = `${SCHEMA_DIRECTORY}/${name}`;
    const destination = `schemas/2026-07-25/${name}`;
    await writeArtifact(
      destination,
      await readFile(resolve(SOURCE_ROOT, source)),
    );
    inputPaths.push(source);
  }
  return inputPaths;
}

async function writeArtifact(path, bytes, mode = 0o644) {
  const absolute = resolve(outputRoot, path);
  if (!isPathInside(outputRoot, absolute)) {
    throw new Error(`Artifact path escapes the output directory: ${path}`);
  }
  await mkdir(dirname(absolute), { recursive: true, mode: 0o755 });
  await writeFile(absolute, bytes, { mode });
}

async function collectBuildInputPaths(
  metafiles,
  schemaPaths,
  thirdPartyInputPaths,
) {
  const paths = new Set([
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "agent-runtime/package.json",
    NODE_FIRST_PARTY_ALLOWLIST,
    "scripts/build-agent-plugin.mjs",
    "src/app/globals.css",
    ...schemaPaths,
    ...thirdPartyInputPaths,
  ]);
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      const normalized = input.replaceAll("\\", "/");
      if (
        normalized.startsWith("<") ||
        normalized.includes("/node_modules/") ||
        normalized.startsWith("node_modules/")
      ) {
        continue;
      }
      paths.add(normalized);
    }
  }
  for (const path of await listSourceFiles([
    "agent-runtime/app",
    "src/components/editor-surface",
    "src/lib/editor-ui",
  ])) {
    paths.add(path);
  }
  const sorted = [...paths].sort();
  for (const path of sorted) {
    await assertRegularSourceFile(path);
  }
  return sorted;
}

async function listSourceFiles(directories) {
  const files = [];
  for (const directory of directories) {
    await walk(directory);
  }
  return files
    .filter(
      (path) =>
        /\.(?:ts|tsx)$/.test(path) &&
        !path.includes(".test.") &&
        !path.includes("/test-fixtures/"),
    )
    .sort();

  async function walk(path) {
    const absolute = resolve(SOURCE_ROOT, path);
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        files.push(child);
      } else {
        throw new Error(`Non-regular source entry is not supported: ${child}`);
      }
    }
  }
}

async function assertRegularSourceFile(path) {
  const absolute = resolve(SOURCE_ROOT, path);
  if (!isPathInside(SOURCE_ROOT, absolute)) {
    throw new Error(`Build input escapes the source checkout: ${path}`);
  }
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Build input must be a regular file: ${path}`);
  }
}

async function createFileRecords(root, paths) {
  return Promise.all(
    [...new Set(paths)].sort().map(async (path) => {
      const absolute = resolve(root, path);
      const metadata = await lstat(absolute);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`Manifest input is not a regular file: ${path}`);
      }
      const bytes = await readFile(absolute);
      return {
        path,
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
      };
    }),
  );
}

async function listRegularFiles(root) {
  const files = [];
  await walk(root, "");
  return files.sort();

  async function walk(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, path);
      } else if (entry.isFile()) {
        files.push(path);
      } else {
        throw new Error(`Non-regular artifact is not supported: ${path}`);
      }
    }
  }
}

async function collectThirdPartyPackages(metafiles) {
  const packageRoots = new Map();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      const normalized = input.replaceAll("\\", "/");
      if (
        !normalized.includes("/node_modules/") &&
        !normalized.startsWith("node_modules/")
      ) {
        continue;
      }
      const absolute = resolve(SOURCE_ROOT, normalized);
      const packageRoot = await findPackageRoot(absolute);
      if (!packageRoot) {
        throw new Error(`Could not resolve package metadata for ${input}.`);
      }
      const packageJson = JSON.parse(
        await readFile(resolve(packageRoot, "package.json"), "utf8"),
      );
      if (
        typeof packageJson.name !== "string" ||
        typeof packageJson.version !== "string"
      ) {
        throw new Error(`Third-party package metadata is incomplete for ${input}.`);
      }
      const key = `${packageJson.name}@${packageJson.version}`;
      packageRoots.set(key, { root: packageRoot, packageJson });
    }
  }
  const packages = [];
  const inputPaths = [];
  for (const [identity, value] of [...packageRoots.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const licenseFiles = (await readdir(value.root, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          /^(?:licen[cs]e|copying)(?:[._-].*)?$/i.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
    const licenseText = licenseFiles.length
      ? await readFile(resolve(value.root, licenseFiles[0]), "utf8")
      : null;
    const packageRoot = relative(SOURCE_ROOT, value.root).replaceAll("\\", "/");
    if (
      packageRoot.startsWith("../") ||
      packageRoot === ".." ||
      isAbsolute(packageRoot)
    ) {
      throw new Error(
        `Third-party package root escapes the source install: ${identity}.`,
      );
    }
    inputPaths.push(`${packageRoot}/package.json`);
    if (licenseFiles[0]) {
      inputPaths.push(`${packageRoot}/${licenseFiles[0]}`);
    }
    packages.push({
      identity,
      license:
        typeof value.packageJson.license === "string"
          ? value.packageJson.license
          : "SEE PACKAGE METADATA",
      licenseFile: licenseFiles[0] ?? null,
      licenseText,
    });
  }
  return { packages, inputPaths: [...new Set(inputPaths)].sort() };
}

async function findPackageRoot(inputPath) {
  let current;
  try {
    current = dirname(await realpath(inputPath));
  } catch {
    current = dirname(inputPath);
  }
  while (isPathInside(SOURCE_ROOT, current) || current === SOURCE_ROOT) {
    try {
      const packagePath = resolve(current, "package.json");
      const metadata = await stat(packagePath);
      if (metadata.isFile()) {
        const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
        if (
          typeof packageJson.name === "string" &&
          typeof packageJson.version === "string"
        ) {
          return current;
        }
      }
    } catch {
      // Continue walking to the owning package.
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
}

function renderThirdPartyLicenses(packages) {
  const sections = [
    "Waptions agent runtime third-party notices",
    "",
    "This file is generated deterministically from packages included in the Node and MCP App bundles.",
    "",
  ];
  for (const item of packages) {
    sections.push(
      `===== ${item.identity} =====`,
      `Declared license: ${item.license}`,
      item.licenseFile
        ? `License file: ${item.licenseFile}`
        : "License file: not distributed by the package",
      "",
    );
    if (item.licenseText) {
      sections.push(item.licenseText.trim(), "");
    }
  }
  return `${sections.join("\n").trimEnd()}\n`;
}

async function assertNoMachineLocalPaths(root) {
  const forbidden = [SOURCE_ROOT, outputRoot];
  for (const path of await listRegularFiles(root)) {
    const bytes = await readFile(resolve(root, path));
    if (bytes.includes(0)) {
      continue;
    }
    const text = bytes.toString("utf8");
    for (const value of forbidden) {
      if (text.includes(value)) {
        throw new Error(
          `Generated artifact ${path} contains a machine-local build path.`,
        );
      }
    }
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Base64(value) {
  return createHash("sha256").update(value).digest("base64");
}

function stableStringify(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

function comparePathRecords(left, right) {
  return left.path.localeCompare(right.path);
}
