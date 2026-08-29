# CinaSeek brand system

CinaSeek is a CinaGroup product for building secure, controllable, and shareable AI applications
and agents.

## Brand architecture

- **CinaGroup** is the parent organization.
- **CinaSeek** is the product users build and work in.
- **CinaAuth** is the identity service. Authentication surfaces should say “Sign in to CinaSeek”
  and may use “Secured by CinaAuth” as a secondary trust statement.
- Infrastructure providers are named only where they help users understand a real configuration,
  limit, or security boundary.

The canonical product manifest, terminology, colors, and asset references live in the sibling
[`cinagroup/cinabrand`](https://github.com/cinagroup/cinabrand) repository under
`products/cinaseek/`. This repository keeps a checked-in, hash-locked snapshot in `brand/` so builds
do not depend on a runtime CDN or another repository being available.

Run `pnpm brand:sync` after an approved asset or manifest change in `cinabrand`, then review the
generated `brand/brand.lock.json`. CI and the root test task run `pnpm brand:check` to reject drift.

## Product voice

Primary message: **Build what you need. Keep control.**

Describe security through concrete controls: isolated execution, scoped connections, explicit
approvals, verified identity, and user-selected models. Avoid unsupported superlatives or absolute
claims such as “fully secure” or “private by default” when deployment configuration can change the
result.

## User-facing terminology

Compatibility identifiers remain unchanged in code, RPC APIs, package names, routes, and `.gadget`
archives. User-facing language uses:

- Gadget → App
- Blueprint → Template
- Gatekeeper → Connection or Connections & permissions
- Output → Result
- Provider → AI model

English, Simplified Chinese, and Traditional Chinese equivalents are defined in
`brand/terminology.json` and applied to translated interface strings by the CinaSeek terminology
post-processor.

## Deployment customization

An administrator may supply a deployment name, logo, and accent color. Customized deployments must
retain a visible “Powered by CinaSeek” attribution so organization identity is layered on top of,
not confused with, the canonical product identity.
