# Local media and artifact HTTP bridge

The coordinator process owns this bridge. It binds both loopback families for
the logical `localhost:59941` origin by default, preventing another process
from claiming the same port through IPv4 or IPv6. That port is reserved
exclusively for HTTP range reads and managed view pairing. Coordinator commands
use a private Unix socket on Unix or a private named pipe on Windows.

Routes are fixed:

- `POST /v1/pair/exchange`
- `GET|HEAD /v1/media/<opaque-resource-id>`
- `GET|HEAD /v1/artifacts/<opaque-resource-id>`

`OPTIONS` is supported only for exact CORS preflights to those routes. The
bridge rejects other hosts, origins, methods, route shapes, path-like resource
IDs, duplicate capability transports, unknown query parameters, multiple byte
ranges, expired signatures, detached views, stale epochs, and cross-resource
or cross-session use.

One-time pairing capabilities are sent only in a bounded JSON request body.
The coordinator consumes them atomically and returns a session/view/epoch
scope. The bridge signs a short-lived method/origin/resource capability with
the coordinator-owned secret. Pairing responses use `no-store` and
`no-referrer`; pairing secrets never appear in a URL. Media elements may use a
short-lived signed range URL, while programmatic callers can use a Bearer
header. Query capabilities are never logged.

The bridge never accepts a filesystem path. `openBridgeResource` receives an
opaque media/artifact ID and the verified scope. The coordinator resolves that
ID, applies path grants and source identity checks, and returns an already
authorized range handle.

Single byte ranges, suffix ranges, `ETag`, `If-Range`, `206`, `416`, `HEAD`,
abort propagation, close-once ownership, and streaming backpressure are
implemented. No response staging chunk exceeds 4 MiB, and concurrent GET
streams are capped (eight by default). A non-default port is rejected unless
the caller supplies the exact CSP-approved localhost origin.

The persistent coordinator starts the production listener with
`startLocalHttpBridge(...)` and supplies the path-grant/session adapter. The
bridge package does not create a second coordinator or resolve filesystem
authority itself.
