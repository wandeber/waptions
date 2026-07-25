import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const NODE_ENTRY = "agent-runtime/runtime/plugin-server.ts";
const STATIC_NODE_RUNTIME_ENTRIES = [
  "agent-runtime/integration/transcription/provider-transport.ts",
  "agent-runtime/integration/export/exact-render-router.ts",
];
const NODE_ALLOWLIST =
  "agent-runtime/runtime/node-first-party-allowlist.json";

test("agent plugin build refuses a non-empty output directory without deleting it", async () => {
  const temporaryRoot = await mkdtemp(
    resolve(tmpdir(), "waptions-agent-build-output-"),
  );
  const sentinelPath = resolve(temporaryRoot, "keep-me.txt");
  await writeFile(sentinelPath, "owned by caller\n", "utf8");

  try {
    await assert.rejects(
      execFileAsync(process.execPath, ["scripts/build-agent-plugin.mjs"], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          WAPTIONS_AGENT_PLUGIN_OUTPUT_DIR: temporaryRoot,
          WAPTIONS_AGENT_SOURCE_COMMIT: "a".repeat(40),
          WAPTIONS_AGENT_SOURCE_TREE: "b".repeat(40),
          SOURCE_DATE_EPOCH: "1",
        },
      }),
      (error) => {
        assert.match(
          String(error.stderr),
          /WAPTIONS_AGENT_PLUGIN_OUTPUT_DIR must be empty before the build/u,
        );
        return true;
      },
    );
    assert.equal(await readFile(sentinelPath, "utf8"), "owned by caller\n");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("agent plugin Node graph exactly matches its first-party allowlist", async () => {
  const allowed = JSON.parse(
    await readFile(resolve(PROJECT_ROOT, NODE_ALLOWLIST), "utf8"),
  );
  const result = await build({
    absWorkingDir: PROJECT_ROOT,
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
    tsconfig: resolve(PROJECT_ROOT, "tsconfig.json"),
    external: ["node:*"],
    logLevel: "silent",
  });
  const actual = Object.keys(result.metafile.inputs)
    .map(normalizeBuildInput)
    .filter(
      (path) =>
        !path.startsWith("<")
        && !path.startsWith("node_modules/")
        && !path.includes("/node_modules/"),
    )
    .sort();
  assert.deepEqual(actual, allowed);
});

test("managed runtime entries retain no dynamic imports", async () => {
  for (const entryPoint of STATIC_NODE_RUNTIME_ENTRIES) {
    const result = await build({
      absWorkingDir: PROJECT_ROOT,
      entryPoints: [entryPoint],
      outfile: "static-node-runtime-entry.mjs",
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      write: false,
      splitting: false,
      sourcemap: false,
      minify: true,
      legalComments: "none",
      charset: "utf8",
      tsconfig: resolve(PROJECT_ROOT, "tsconfig.json"),
      external: ["node:*"],
      metafile: true,
      logLevel: "silent",
    });
    const output = result.outputFiles.find((file) =>
      file.path.endsWith("static-node-runtime-entry.mjs"),
    );
    assert.ok(output, `${entryPoint} bundle was not emitted`);
    assert.deepEqual(dynamicImportEdges(result.metafile), []);
  }
});

test("static runtime detection rejects a real dynamic import edge", async () => {
  const result = await build({
    stdin: {
      contents: 'await import("node:fs");',
      resolveDir: PROJECT_ROOT,
      sourcefile: "dynamic-import-fixture.ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    write: false,
    metafile: true,
    external: ["node:*"],
    logLevel: "silent",
  });
  assert.deepEqual(dynamicImportEdges(result.metafile), [
    "stdin.js -> node:fs",
  ]);
});

test("agent plugin build is deterministic and retains a static offline server graph", async () => {
  const first = await mkdtemp(
    resolve(tmpdir(), "waptions-agent-deterministic-a-"),
  );
  const second = await mkdtemp(
    resolve(tmpdir(), "waptions-agent-deterministic-b-"),
  );
  try {
    await Promise.all([buildPlugin(first), buildPlugin(second)]);
    assert.deepEqual(await hashTree(first), await hashTree(second));

    const server = await readFile(resolve(first, "mcp/server.mjs"), "utf8");
    assert.doesNotMatch(server, /WAPTIONS_RUNTIME_ADAPTER_MODULE/u);
    assert.doesNotMatch(server, /agent-runtime\/server\/stdio\.ts/u);
    assert.doesNotMatch(server, /CONTRACT_APP_RESOURCE/u);
    assert.doesNotMatch(
      server,
      /The Waptions editor UI package is not integrated/u,
    );
    assert.match(server, /--waptions-authority/u);
    assert.match(server, /WAPTIONS_AGENT_DATA_DIR/u);
    assert.match(
      server,
      /A native Windows named-pipe DACL verifier is required/u,
    );

    const manifest = JSON.parse(
      await readFile(resolve(first, "build-manifest.json"), "utf8"),
    );
    assert.ok(
      manifest.buildInputs.some(
        (record) => record.path === NODE_ALLOWLIST,
      ),
    );
    assert.deepEqual(
      (await listFiles(first)).filter(
        (path) =>
          path !== "build-manifest.json"
          && path !== "THIRD_PARTY_LICENSES.txt"
          && !path.startsWith("mcp/app/")
          && !path.startsWith("schemas/"),
      ),
      ["mcp/server.mjs"],
    );
  } finally {
    await Promise.all([
      rm(first, { recursive: true, force: true }),
      rm(second, { recursive: true, force: true }),
    ]);
  }
});

async function buildPlugin(outputRoot) {
  await execFileAsync(process.execPath, ["scripts/build-agent-plugin.mjs"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      WAPTIONS_AGENT_PLUGIN_OUTPUT_DIR: outputRoot,
      WAPTIONS_AGENT_SOURCE_COMMIT: "a".repeat(40),
      WAPTIONS_AGENT_SOURCE_TREE: "b".repeat(40),
      SOURCE_DATE_EPOCH: "1",
    },
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function hashTree(root) {
  const result = {};
  for (const path of await listFiles(root)) {
    const bytes = await readFile(resolve(root, path));
    result[path] = createHash("sha256").update(bytes).digest("hex");
  }
  return result;
}

async function listFiles(root) {
  const files = [];
  await visit(root);
  return files.sort();

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push(relative(root, absolute).replaceAll("\\", "/"));
      } else {
        throw new Error(`Unexpected build artifact: ${absolute}`);
      }
    }
  }
}

function normalizeBuildInput(input) {
  const normalized = input.replaceAll("\\", "/");
  const rootPrefix = `${PROJECT_ROOT.replaceAll("\\", "/")}/`;
  return normalized.startsWith(rootPrefix)
    ? normalized.slice(rootPrefix.length)
    : normalized;
}

function dynamicImportEdges(metafile) {
  const edges = [];
  for (const [outputPath, output] of Object.entries(metafile.outputs)) {
    for (const imported of output.imports ?? []) {
      if (imported.kind === "dynamic-import") {
        edges.push(`${normalizeBuildInput(outputPath)} -> ${imported.path}`);
      }
    }
  }
  return edges.sort();
}
