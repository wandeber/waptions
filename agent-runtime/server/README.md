# Runtime attachment and packaging

`server/stdio.ts` is a protocol adapter. It requires
`WAPTIONS_RUNTIME_ADAPTER_MODULE`, whose `attachWaptionsRuntime()` function
returns:

- a client adapter attached to the durable coordinator;
- the exact hashed Core semantic schema bundle; and
- a declared private control endpoint (`unix-socket` or
  `windows-named-pipe`).

TCP and HTTP control endpoints are rejected. The stdio process never binds
`59941`, starts a project authority, or owns durable session state. Closing
stdio detaches its coordinator client; durable projects and coordinator-owned
jobs remain available. Its newline-delimited JSON-RPC reader is bounded before
`JSON.parse`, so an oversized or unterminated line cannot grow without limit.

`runtime-package.json` freezes the complete packaged surfaces:
`coordinator`, `runtime`, `render`, `media`, `http-bridge`, `mcp`, and `server`.
The TypeScript build includes all of those directories. Normal package-owner
validation records missing integration surfaces without inventing stubs.
Integrated P6 packaging sets `WAPTIONS_REQUIRE_FULL_RUNTIME=1`, which makes the
manifest build fail if any required surface is absent.

The deterministic build manifest hashes every emitted file and records the
stdio/bridge entrypoints, transport ownership, source commit, canonical MCP
App assets and payload hash, server bundle hash, schema hashes, and immutable
MCP App URI. The exact App HTML is copied into `dist/mcp-app/index.html`, so
the stdio server and protocol verification consume the packaged bytes rather
than an unrelated runtime path. Startup verifies those bytes and the attached
Core schema hash against the build manifest. `prepack` builds first, and
`pack:verify` installs the resulting PNPM tarball, imports every public export,
and executes the packaged bin through its expected fail-closed startup path.
