import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const temporaryRoot = await mkdtemp(
  resolve(tmpdir(), "waptions-agent-package-"),
);
const archiveDirectory = resolve(temporaryRoot, "archive");

try {
  await mkdir(archiveDirectory);
  await execute(
    "pnpm",
    [
      "pack",
      "--pack-destination",
      archiveDirectory,
    ],
    { cwd: packageRoot },
  );
  const archiveName = (await readdir(archiveDirectory)).find((name) =>
    name.endsWith(".tgz"),
  );
  if (!archiveName) {
    throw new Error("PNPM did not create an agent runtime archive.");
  }
  const archivePath = resolve(archiveDirectory, archiveName);
  await writeFile(
    resolve(temporaryRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "waptions-agent-package-consumer",
        private: true,
        type: "module",
        dependencies: {
          "@waptions/agent-runtime": `file:${archivePath}`,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await execute(
    "pnpm",
    [
      "--ignore-workspace",
      "install",
      "--offline",
      "--dir",
      temporaryRoot,
    ],
    { cwd: temporaryRoot },
  );
  await writeFile(
    resolve(temporaryRoot, "verify.mjs"),
    [
      'await import("@waptions/agent-runtime/mcp");',
      'await import("@waptions/agent-runtime/server");',
      'await import("@waptions/agent-runtime/http-bridge");',
    ].join("\n"),
    "utf8",
  );
  await execute(process.execPath, [resolve(temporaryRoot, "verify.mjs")], {
    cwd: temporaryRoot,
  });

  try {
    await execute(
      "pnpm",
      [
        "--ignore-workspace",
        "--dir",
        temporaryRoot,
        "exec",
        "waptions-mcp",
      ],
      {
        cwd: temporaryRoot,
        env: {
          ...process.env,
          WAPTIONS_RUNTIME_ADAPTER_MODULE: "",
        },
      },
    );
    throw new Error(
      "Packed waptions-mcp unexpectedly started without a runtime adapter.",
    );
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    if (
      !stderr.includes("WAPTIONS_RUNTIME_ADAPTER_MODULE is required")
    ) {
      throw error;
    }
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
