# Waptions MCP App source

`index.tsx` is the UI entry consumed by the packaged runtime build. It renders the same
controller-driven editor surface as the managed web host and communicates only through the MCP
Apps parent-window JSON-RPC bridge.

This directory deliberately does not register a resource URI or own a CSP. The runtime packaging
step must:

1. bundle this entry and the editor surface with the repository Tailwind pipeline;
2. emit one deterministic HTML payload with no arbitrary inline script;
3. compute the canonical payload hash;
4. register `ui://waptions/editor/v1/<buildHash>/index.html` as
   `text/html;profile=mcp-app`;
5. allow only the MCP host bridge plus `http://localhost:59941` in the exact generated CSP;
6. record every asset byte hash in the packaged build manifest.

Changing any UI byte requires a new build hash and resource URI.
