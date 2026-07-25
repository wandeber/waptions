# Managed project import

`ManagedProjectImportService` is the injectable delegate for `waptions_project_import`.
It accepts the existing schema's `bundle-path`, `manifest-path`, and `inline-manifest` shapes.
Path inputs are resolved only through `PathGrantProjectImportSourceAuthority`; all later values
contain opaque capabilities, descriptors, digests, and streams, never filesystem paths.

The ZIP reader admits only the deterministic stored ZIP/ZIP64 layout produced by the portable
bundle writer. It bounds the central directory, entries, aggregate size and read chunks, rejects
path traversal, aliasing and unsupported compression before reading bodies, and checks local
headers, data descriptors, CRCs and declared SHA-256 values while streaming media.

The receipt authority is intentionally injected. It must look up a matching durable receipt before
capability acquisition and publish the fully prepared import through the Core/coordinator's single
receipt-first transaction. Consequently a replay does not reopen an expired grant, and no live
project is replaced until the entire container, manifest, detached transcript bodies and media
digests have validated.
