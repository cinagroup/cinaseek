# Cloudflare Access production authentication

CinaSeek treats Cloudflare Access as the only authentication authority when `CF_ACCESS_ISS` and
`CF_ACCESS_AUD` are configured. Access authenticates the browser at the edge and sends
`Cf-Access-Jwt-Assertion` to the backend. The backend verifies the RS256 signature against the
team JWKS plus the exact issuer and application audience, then accepts only an application token
with a valid `email` and `sub` claim. Password, session-token, and authentication-Gatekeeper entry
points are disabled in this mode.

Setting only one Access variable is an invalid, fail-closed configuration. The `/api` endpoint
returns HTTP 503 until the pair is corrected.

## OAuth and OIDC registrations

Use separate OAuth clients for separate trust boundaries. CinaAuth is the only identity provider
selected by the CinaSeek Access application; Google and GitHub are upstream social providers owned
by CinaAuth, not direct login methods on the Access application. In particular, a GitHub OAuth App
has a single callback URL and cannot safely serve both Cloudflare Access and CinaAuth.

| Consumer | Provider registration | Exact callback |
| --- | --- | --- |
| CinaAuth social login | Google web client | `https://accounts.cinaseek.ai/api/auth/callback/google` |
| CinaAuth social login | Dedicated GitHub OAuth App | `https://accounts.cinaseek.ai/api/auth/callback/github` |
| Cloudflare Access | Dedicated confidential CinaAuth OIDC client | `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback` |

For the CinaAuth OIDC client, use authorization code flow, `client_secret_basic`, PKCE, and the
`openid email profile` scopes. Configure the Access Generic OIDC identity provider with:

- Issuer: `https://auth.cinaseek.ai`
- Authorization endpoint: `https://auth.cinaseek.ai/api/auth/oauth2/authorize`
- Token endpoint: `https://auth.cinaseek.ai/api/auth/oauth2/token`
- JWKS endpoint: `https://auth.cinaseek.ai/api/auth/jwks/cloudflare-access`
- Email claim: `email`

The client embedded in `cinaauth/demo/oidc-client` is not reusable for Access. It is an immutable
public PKCE acceptance client with `token_endpoint_auth_method=none` and a callback fixed to
`https://oidc-demo.cinaseek.ai/callback`; Access needs its own server-side confidential client and
callback.

Keep every OAuth/OIDC client secret only in its provider and consumer secret store. Never place a
secret in this repository, a generated Wrangler configuration, a command-line argument, or a CI
log.

## Access application and policy

Create a self-hosted application for the exact hostname. Select only the CinaAuth Generic OIDC
identity provider and enable **Apply instant authentication** (`auto_redirect_to_identity=true`).
This skips the Cloudflare provider picker and sends the browser directly to CinaAuth. Google,
GitHub, and OTP may remain configured at the account level for other applications, but must not be
selected by the CinaSeek application. Keep the authorization cookie HttpOnly and do not add Bypass
or Everyone policies.

Do not protect `auth.cinaseek.ai` or `accounts.cinaseek.ai` with the same Access application or a
matching wildcard, because the OIDC authorization flow would loop back into Access. If direct IdP
access is needed for recovery, use a separate administrator-only break-glass hostname and Access
application rather than adding a second IdP to CinaSeek.

Use a reusable Access group for administrators and reference that group from an Allow policy. Add
corporate email-domain rules only for a domain controlled by the organization; never use a shared
consumer domain such as `gmail.com`. IdP-native group policy requires the provider to emit a stable
group claim in the ID token. Until CinaAuth emits that claim, use Access groups or exact email rules.

## Deploy and audit

Create the Access application and a restrictive Allow policy before enabling Access mode. A live
deployment now checks that the hostname is challenged by the expected team and that the team JWKS
contains an RS256 signing key before uploading Workers:

    node scripts/deploy-cloudflare.mjs --domain cinaseek.ai --zone-route \
      --access-issuer https://<team>.cloudflareaccess.com \
      --access-audience <application-aud-tag>

Run the read-only remote audit after any Access, policy, or identity-provider change. It reads the
issuer and audience from the generated backend configuration and the API token only from
`CLOUDFLARE_API_TOKEN` (or `CF_API_TOKEN`):

    node scripts/check-cloudflare-access.mjs --domain cinaseek.ai \
      --require-instant-auth-idp CinaAuth \
      --require-access-group "CinaSeek administrators"

The audit checks the application type and AUD, HttpOnly cookie, exclusive CinaAuth allow-list,
instant authentication, Allow policies, absence of Bypass/Everyone, required Access groups, edge
challenge, issuer, and rotating JWKS. It intentionally does not print application IDs, user emails,
or policy subjects.

## Release acceptance

Complete all of these checks before calling the authentication chain production-ready:

1. An unauthenticated request to `/` and `/api` reaches the expected Access team, skips its provider
   picker, and redirects directly to the CinaAuth OIDC authorization endpoint.
2. Google and GitHub each complete through the CinaAuth broker and return to `cinaseek.ai`.
3. The authenticated WebSocket/RPC connection reaches `whoami()` before the UI shows an
   authenticated session.
4. A token with the wrong issuer, audience, algorithm, type, email, or subject is rejected.
5. A user outside every Allow policy is denied at the edge.
6. Access logout invalidates the session and a new `/api` connection is challenged again.
7. The remote audit and the Access-mode frontend/backend build pass from the release revision.

Cloudflare references: [validate an Access JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
[application token claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/),
[instant authentication](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/),
and [Generic OIDC](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/generic-oidc/).
