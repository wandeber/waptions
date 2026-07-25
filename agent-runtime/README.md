# Waptions agent runtime protocol layer

This package contains the descriptor-first MCP server, persistent coordinator
adapter boundary, and coordinator-owned localhost media/artifact bridge for
Waptions managed editing sessions.

- [`mcp/README.md`](./mcp/README.md) documents the semantic tool contract.
- [`server/README.md`](./server/README.md) documents private IPC attachment and
  reproducible packaging.
- [`http-bridge/README.md`](./http-bridge/README.md) documents local pairing
  and signed range reads.

The package is not a second project store. Production stdio processes attach
to the durable coordinator over a private Unix socket or Windows named pipe;
only the coordinator HTTP bridge owns `localhost:59941`.
