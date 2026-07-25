import { isAbsolute } from "node:path";
import type { Server, Socket } from "node:net";

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
 * Native Windows host seam. Implementations verify the actual listening or
 * connected pipe handle, not a path before a later open, and restrict its DACL
 * to the current logon identity without returning bearer material.
 */
export interface WindowsNamedPipeSecurityPort {
  secureAndVerifyServer(server: Server, path: string): Promise<void>;
  /**
   * Return an already connected and paused socket only after validating the
   * server identity and DACL on that same pipe handle. Pausing prevents the
   * authentication challenge from being lost before JS listeners are attached.
   */
  connectTrustedClient(path: string): Promise<Socket>;
}

/**
 * Control traffic is private IPC. Port 59941 is reserved exclusively for the
 * coordinator-owned HTTP media/artifact/pairing bridge and must never be used
 * for coordinator commands.
 */
export function assertPrivateControlEndpoint(
  endpoint: CoordinatorControlEndpoint,
): void {
  if (
    !endpoint ||
    typeof endpoint !== "object" ||
    typeof endpoint.path !== "string" ||
    Object.keys(endpoint).sort().join(",") !== "kind,path"
  ) {
    throw new Error("Coordinator control endpoint is invalid.");
  }
  if (endpoint.kind === "unix-socket") {
    if (
      process.platform === "win32" ||
      !isAbsolute(endpoint.path) ||
      endpoint.path.includes("\0") ||
      Buffer.byteLength(endpoint.path, "utf8") > 100
    ) {
      throw new Error("Coordinator Unix socket path is invalid.");
    }
    return;
  }

  if (
    endpoint.kind !== "windows-named-pipe" ||
    process.platform !== "win32" ||
    !/^\\\\\.\\pipe\\[^\\/\0]{1,240}$/.test(endpoint.path)
  ) {
    throw new Error("Coordinator named pipe path is invalid.");
  }
}
