import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(import.meta.dirname, "..");

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
