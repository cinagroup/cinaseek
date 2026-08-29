# CinaSeek Security

CinaSeek is designed around sandboxed execution, capability-based connections, and explicit
authentication boundaries. Security-sensitive changes to the backend kernel and shared RPC API are
reviewed separately from user-authored applications and connector interfaces.

## Reporting a vulnerability

Please report suspected vulnerabilities through a
[private GitHub security advisory](https://github.com/cinagroup/cinaseek/security/advisories/new).
Do not open a public issue until a fix is available.

Include the affected component and version, impact, reproduction steps, and any suggested
mitigation. Do not include live credentials, access tokens, private prompts, customer data, or other
secrets; use clearly synthetic test data instead.

For ordinary bugs and feature requests, use
[GitHub Issues](https://github.com/cinagroup/cinaseek/issues).

## Supported versions

Security fixes are made on the current `main` branch and included in subsequent releases. Operators
should keep their CinaSeek deployment and separately deployed identity and connector services up to
date.

## Scope

This policy covers source code maintained in this repository. Vulnerabilities in an upstream AI
provider, connected third-party service, customer-authored application, or deployment-specific
configuration should also be reported to the responsible operator or vendor.
