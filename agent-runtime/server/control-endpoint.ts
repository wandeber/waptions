import { isAbsolute } from "node:path";

export type CoordinatorControlEndpoint =
  | {
      kind: "unix-socket";
      path: string;
    }
  | {
      kind: "windows-named-pipe";
      path: string;
    };

/**
 * Control traffic is private IPC. Port 59941 is reserved exclusively for the
 * coordinator-owned HTTP media/artifact/pairing bridge and must never be used
 * for coordinator commands.
 */
export function assertPrivateControlEndpoint(
  endpoint: CoordinatorControlEndpoint,
): void {
  if (endpoint.kind === "unix-socket") {
    if (
      process.platform === "win32" ||
      !isAbsolute(endpoint.path) ||
      endpoint.path.includes("\0") ||
      endpoint.path.length > 1024
    ) {
      throw new Error("Coordinator Unix socket path is invalid.");
    }
    return;
  }

  if (
    process.platform !== "win32" ||
    !/^\\\\\.\\pipe\\[^\\/\0]{1,240}$/.test(endpoint.path)
  ) {
    throw new Error("Coordinator named pipe path is invalid.");
  }
}
