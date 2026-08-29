# CinaSeek brand snapshot

This directory pins the product brand contract consumed by the CinaSeek build. The canonical source
is [`cinagroup/cinabrand`](https://github.com/cinagroup/cinabrand); runtime builds use the committed
snapshot and local assets, not a CDN.

Run `pnpm brand:sync` after checking out the matching `cinabrand` version beside this repository.
Run `pnpm brand:check` to verify checksums, product metadata, and key Web/native brand boundaries.

Internal protocol and package names such as `Gadget`, `Gatekeeper`, `workshop-*`, and `@gadgets/*`
remain compatibility identifiers. The product terminology in `terminology.json` controls what people
see without forcing a high-conflict kernel rename.
