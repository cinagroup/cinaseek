<p align="center">
  <img src="./assets/logo.png" alt="CinaSeek logo" width="168" />
</p>

<h1 align="center">CinaSeek</h1>

<p align="center"><strong>An AI productivity environment for secure personal apps and agents.</strong></p>

CinaSeek is an independently branded distribution of the open-source Cloudflare OS v2 foundation. It provides an "operating system" for AI productivity in which people can build, run, and share personal applications and agents inside strong capability-based sandboxes.

![A Q3 planning workspace in CinaSeek, with an AI-generated slide deck](docs/images/q3-planning-workspace.png)

This is not a traditional computer operating system. We use the term "operating system" in two senses:

* An operating system for *the company* to be productive with AI, in a way that is safe, so that the security team can sleep at night.
* An operating system for AI workloads, analogous to the sense in which a traditional operating system manages compute workloads.

CinaSeek provides three things in particular:

1. An agent chat UI where you can ask agents to do tasks, preloaded with knowledge about how your company operates.
2. Sandboxed application development, so that you can ask agents to build "gadgets" (small personal apps) and safely share what you've built with others.
3. A security framework, called Gatekeepers, that applies guardrails to both agents and apps such that non-technical users can safely "go nuts" and nothing bad will happen.

CinaSeek keeps that foundation open and customizable while establishing its own product name, visual identity, deployment defaults, and user-facing integration copy. The original Apache-2.0 license and upstream attribution remain intact.

## Quick Start

To quickly run CinaSeek locally, [install pnpm](https://pnpm.io/), then do:

    pnpm run-local

Then visit: http://localhost:8787

This runs the whole stack locally on wrangler and workerd. This is not meant for production use, but is a quick way to see what the product does.

Production releases are assembled with the included `scripts/release/` pipeline and the checked-in Wrangler configurations.

(More options at the end of this readme.)

### What to try

Try prompts like:

* "Make slides for my upcoming meeting with a customer." (This will use the built-in slides blueprint.)
* "Make a collaborative whiteboard app." (This will create a new app from scratch.)
* "Make a tic tac toe game." followed by "I'll be X and you be O. I've made my first move. Your turn."
* "Make an issue dashboard for this GitHub repo." (Attach a repo; requires that the GitHub integration is configured.)
* "Fix the typos in this Google Doc." (Attach a doc; requires that the Google integration is configured.)

### WARNING: Early access

CinaSeek is in a state of heavy development. Its upstream v2 foundation is a complete rewrite built from the lessons of the first-generation system.

As of the August 2026 release, the v2 foundation is very capable but still has rough edges. For now, consider CinaSeek an "early access" release.

## Overview: What is CinaSeek really?

### Gadgets: A new way of thinking about software

CinaSeek is more than just another chatbox with connectors. The system revolves around a new approach to software, where every user runs their own copy of the productivity apps they use.

When you create a slide deck in CinaSeek, you are not calling out to some SaaS software running in the cloud. The system creates a *private instance* of the slide deck software *just for you*. We call this a "gadget". This instance runs in a separate sandbox from everyone else's slide decks.

This has two profound effects:
1. The CinaSeek sandbox controls all access to your private app instance, sharply reducing the blast radius of application bugs.
2. If you want, you can freely modify the code. If the slide deck app is missing a feature you need, you can just ask your agent to add it. And because of point 1, it's totally safe to do so.

This is a big departure from the last 25 years of cloud architecture and "Software as a Service", but we think AI has changed the equation. When any user is capable of prompting an agent to add the features they need, the centralized model of software stops making sense.

### Gatekeepers: A capability-based security layer

Gatekeepers are like supercharged MCP servers.

When you introduce an agent or Gadget to an external resource, a Gatekeeper is created to manage that access. The Gatekeeper is a piece of software specific to each external service which moderates a Gadget's connection to that service. It:
* Provides a clean Cap'n Web API to the service (wrapping whatever API the service provides natively).
* Handles authorization (e.g. via OAuth).
* Enforces narrow access to only the specific resource the user intended.
* Logs every action the Gadget (or agent) performs, for your review.
* For any action which has side effects, provides the human user an opportunity to approve or deny the action ("human in the loop").

On the last point, Gatekeepers implement a significant advancement in the state of the art. Traditionally, human-in-the-loop setups require the human to approve actions *synchronously*. When the agent wants to do something, it has to *stop* and wait for said approval before it can continue. This is annoying: you give your agent a task, then walk away and get a coffee, only to come back and find the agent got stuck on an approval on the first step and has made no progress. As a result, people often give in and set their agents to "auto-approve", or `--dangerously-skip-permissions`, which is, obviously, unsafe.

Gatekeepers provide a better way: When the agent (or Gadget) performs an action that requires approval, the Gatekeeper will *simulate* the outcome locally, allowing the agent to proceed and queue up more actions. The Gatekeeper tells the agent that the action completed, and if the agent tries to read back the results, the Gatekeeper gives it simulated results. Once the agent is done, the user may approve or reject the actions in bulk, or one-by-one, but either way, they can do it later, when it is convenient.

Logistically, each Gatekeeper is implemented as a separate Worker. In the future, we envision Gatekeeper services being deployed and maintained independently from OS instances, but the details have yet to be worked out. For now, we have provided a few interesting Gatekeepers in this repository which you can deploy together with your own OS instance.

### Think of an office suite

The basic user experience of CinaSeek is something like an online office suite, like Google Docs or MS Office. But, imagine that instead of a fixed set of file types (document, spreadsheet, slide deck), each file -- or "Gadget" -- is potentially its own custom application, written by AI to serve exactly your needs.

Just like office docs, each gadget is private by default, but can be shared -- securely -- in order to collaborate with your team or your friends.

Just like office docs, you can have thousands of them. You can create them on a whim.

Just like office docs, you can start from "templates" -- called "Blueprints". But where an office template is just some content, a Blueprint specifies a whole application.

Like office docs, you can create new templates (blueprints) from your own docs (Gadgets) and share them with others. But when you do so, you are sharing the code for a whole app.

### It kind of is an Operating System

The OS terminology isn't *entirely* marketing. CinaSeek is analogous to an operating system on a technical level.

| Normal OS      | CinaSeek                   |
|----------------|----------------------------|
| kernel         | packages/workshop-backend  |
| device drivers | packages/gatekeeper-*      |
| shell          | packages/workshop-frontend |
| processes      | gadgets                    |
| executables    | blueprints                 |
| users          | users                      |
| ACLs           | shared permissions         |
| ???            | agents                     |

Our "kernel" is in the workshop-backend package. The backend legitimately does a lot of things similar to real OS kernels: it connects users to programs and devices (Gadgets and Gatekeepers, as we call them) while implementing security by sandboxing applications and enforcing access control.

In this analogy, Gatekeepers -- which connect users and agents to external services -- are like drivers -- which connect users and programs to external devices.

There is one thing that traditional OSes don't really manage today, but CinaSeek does: AI agents. AI agents cannot simply be treated as users. They must be accountable to a human user while retaining their own restricted permissions. Agents do work by writing snippets of code and executing them on the fly. The ideal security model for this is capability-based security, not ambient access.

### Built on Cloudflare Workers

CinaSeek is built on [Cloudflare Workers](https://workers.cloudflare.com), making heavy use of [Durable Objects](https://developers.cloudflare.com/durable-objects/), [Dynamic Workers](https://blog.cloudflare.com/dynamic-workers/), and [Facets](https://blog.cloudflare.com/durable-object-facets-dynamic-workers/) in particular. Every workspace is its own Durable Object, every Gadget runs in a Dynamic Worker Facet, and Gatekeepers also install facets into each workspace to manage access to remote services.

The upstream Cloudflare OS foundation was created by members of the Workers team and uses cutting-edge Workers Runtime features. CinaSeek preserves that architecture while maintaining an independent product identity.

Being built on Workers does not mean that CinaSeek can only run on Cloudflare. [`workerd`, the Cloudflare Workers Runtime, is open source](https://github.com/cloudflare/workerd), and the platform can run entirely on top of it on your own servers.

## Features

### General multi-purpose agent

The CinaSeek coding agent is a multi-purpose agent that can perform arbitrary tasks; you do not have to code with it. You can use it to build Gadgets, or skip the Gadget and have the agent perform tasks directly. The agent uses [Code Mode](https://blog.cloudflare.com/code-mode/) and can connect to external resources through Gatekeepers such as MCP.

### Build apps with AI

While you can code a Gadget by hand, the expectation is that AI writes the code for you. CinaSeek includes a coding agent that builds, tests, and debugs the applications you request.

You can choose your LLM. CinaSeek works with major AI model providers and self-hosted models.

Because the platform tightly integrates the agent, sandbox, application runtime, and capability system, its coding agent can work with less glue code than a general-purpose agent.

### Collaborate with AI

Every app built with CinaSeek automatically has an agent-friendly API. After asking AI to build an app, you can also ask AI to collaborate with you *inside* it. There is no need to build a separate MCP server or integrate a custom agent loop.

This works because the client and server portions of a Gadget are required to communicate via [Cap'n Web RPC](https://github.com/cloudflare/capnweb). This is a win-win:
1. Cap'n Web is extremely low-boilerplate, which makes it easy for agents to work with. You basically just define a method on your server, then call it from your client, as if it were a local call.
2. Meanwhile, it means that the server necessarily exposes an easy-to-understand API which could be called directly by an agent. The AI Agent harness uses [Code Mode](https://blog.cloudflare.com/code-mode/) for tool calling, making it trivial to expose the Gadget's API directly for the agent to invoke.

### Real-time Multiplayer

You can share your Gadget just like you'd share a document in a typical online office suite. You can give specific users access, or create a share link that provides access to anyone who opens it. And just like those online office suites, you'll be able to see your collaborators' actions in real time.

This works because every Gadget is backed by a [Durable Object](https://developers.cloudflare.com/durable-objects/), Cloudflare's stateful serverless primitive which makes real-time multiplayer collaboration easy. It's so easy that the coding agent just implements it by default, without being asked.

### Blueprints: Share your code

If you've created a Gadget that might be useful to others, but you don't want to share the Gadget itself, you can instead share a Blueprint, allowing other people to create their own copy of the Gadget. A Blueprint is essentially a copy of the code.

It may sound simple, but Blueprints are a major change from cloud software tradition. Traditionally, if you create a web app that you want to share with other users, you host the app on your server, and the users connect to that. Blueprints are much more like mobile apps and traditional PC apps: every user runs their own copy of the software.

In the age of AI, this change is critically important. On one hand, AI empowers an individual developer to build more than ever, but it is still difficult for an individual developer to maintain an online service; this eliminates the need. On the other hand -- and even more importantly -- allowing each user to run their own copy of the software empowers the user to *change* the software to meet their needs, using AI. No need to file a feature request, no need to beg the developer to prioritize it. The end user can solve their own problems.

### Sandboxed and secure by default

Each Gadget runs in a secure sandbox that prevents it from talking to the internet at all without your explicit consent. In particular:
* The server runs in a [Dynamic Worker](https://blog.cloudflare.com/dynamic-workers/) which has had its access to the internet disabled. It can only communicate with specific external resources that you have explicitly designated, via [Workers Bindings](https://blog.cloudflare.com/workers-environment-live-object-bindings/).
* The client code runs in a sandboxed iframe. This iframe can communicate with its server only via a Cap'n Web RPC session provided over `postMessage()` to the parent frame. The iframe is otherwise blocked from accessing the internet (to the maximum extent allowed by browsers, via `Content-Security-Policy` and iframe sandbox settings).

### Capability-based access control

Each agent, and each Gadget, starts with access to nothing. Even if you've configured CinaSeek with external accounts, agents and Gadgets do NOT automatically get to use them.

Instead, you must *introduce* each agent (or Gadget) to any particular resources you want it to access. For instance, you may introduce a GitHub repository by pasting a link to it, or clicking "add resource" and selecting it via the UI. An agent can also request an introduction to a resource it thinks it needs, which you can then provide or deny.

This differs from most agent harnesses, where MCP servers are configured upfront, making broad access to all your services ambiently available to the agent in every chat. Capability-based introductions keep each agent restricted to only the access it actually needs for the job at hand.

## Get Started

### Deploy to Cloudflare

CinaSeek's production release pipeline lives in `scripts/release/`. It bundles all deployable Workers, produces a content-addressed release manifest, uploads a candidate to R2, and promotes that candidate only after verification. Instance-specific worker names, resource IDs, public URLs, and secrets are injected by the deployment service rather than committed to this repository.

The upstream [Cloudflare OS deployment wizard](https://os.cloudflare.app/deploy) and [deployment starter](https://github.com/cloudflare/cloudflare-os-starter) remain useful architectural references, but they deploy the upstream distribution rather than this CinaSeek fork.

For a standalone deployment that does not use the external deployment service, authenticate Wrangler and run:

    node scripts/deploy-cloudflare.mjs --domain cinaseek.ai --dry-run
    node scripts/deploy-cloudflare.mjs --domain cinaseek.ai

If the hostname already has an A, AAAA, or CNAME record in the Cloudflare zone, preserve that DNS record and attach the router as a Worker Route instead:

    node scripts/deploy-cloudflare.mjs --domain cinaseek.ai --zone-route

The standalone path deploys the public router, backend, and the credential-free Context and Scheduler Gatekeepers. It keeps internal Workers off `workers.dev`, attaches the router either as the custom-domain origin or as an existing-zone route, and stores account-specific generated configuration under the gitignored `.wrangler/production/` directory. Password sign-in remains enabled by default. To grant an existing username deployment-admin access, add `--admin <username>` on a subsequent deploy; do not reserve a guessable admin name before its account exists. Third-party Gatekeepers should be added only after their OAuth credentials are provisioned.

To use Cloudflare Access, create and test the Access application and its Allow policies before switching the deployment. Then provide the application's team issuer and Audience (AUD) tag together:

    node scripts/deploy-cloudflare.mjs --domain cinaseek.ai --zone-route \
      --access-issuer https://<team-name>.cloudflareaccess.com \
      --access-audience <application-aud-tag>

This builds the frontend without password login or signup and configures the backend to verify `Cf-Access-Jwt-Assertion` against the team's rotating JWKS, issuer, and application audience. The issuer and AUD identify the Access application but are not client secrets. Identity-provider client secrets remain in Cloudflare Zero Trust and must never be committed to this repository.

Access mode is exclusive: built-in password, session-token, and authentication-Gatekeeper entry points are disabled, and a partial issuer/AUD configuration fails closed. A live deployment verifies the edge challenge and team JWKS before uploading Workers. After deployment, run the read-only remote audit and complete the provider login matrix in [the Cloudflare Access production runbook](docs/cloudflare-access-production.md).

To route deployment-managed models through Cloudflare AI Gateway, create or select an authenticated Gateway, configure its stored provider keys or Unified Billing, and give the deployment an API token with AI Gateway Run and Read permissions. Supply that token only through the deployment environment variable `CINASEEK_AI_GATEWAY_API_TOKEN`; the script consumes it through stdin for `wrangler secret put`, removes it before build subprocesses start, and never writes it to generated configuration:

    node scripts/deploy-cloudflare.mjs --domain cinaseek.ai --zone-route --ai-gateway cinaseek --ai-gateway-account-id <cloudflare-account-id> --ai-gateway-providers openai,anthropic,google,cloudflare,openai-compatible

The token environment variable is required on the first Gateway-enabled deployment and when rotating the secret. Later deployments reuse the existing Worker secret. On a completely new account, deploy the base Worker once without the Gateway flags first; Gateway deployment fails closed if it cannot verify the remote secret state. `openai-compatible` accepts a Cloudflare Custom Provider path such as `custom-internal/v1` plus its real model ID, avoiding the deprecated Gateway `/compat` API; outside Gateway mode it exposes any directly reachable OpenAI Chat Completions-compatible base URL. Use `--workers-ai-gateway <gateway>` to route Workers AI through a different Gateway, or `--workers-ai-direct` to call Workers AI directly with the same account and token.

### Run locally

To quickly run CinaSeek locally, [install pnpm](https://pnpm.io/), then do:

    pnpm run-local

Then visit: http://localhost:8787

This runs CinaSeek using `wrangler`, the Workers developer tooling CLI. It is intended for local evaluation rather than production hosting.

Your data will be stored in a subdirectory named `.wrangler`.

### Deploy to your own server using `workerd`

**COMING SOON**

CinaSeek can run entirely on `workerd`, Cloudflare's open-source runtime for Workers. The local instructions above already use `workerd` under the hood. Self-hosted production tooling is still evolving; see the [low-level workerd configuration documentation](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp) for the runtime model.

#### Configuring external services

Many Gatekeepers require configuration in order to be able to connect to third-party services, including obtaining OAuth client credentials for each service. Unfortunately, many service providers intentionally do not make this easy, since the intended audience for OAuth is developers.

Each gatekeeper package contains instructions for how to set it up:

* [GitHub API](packages/gatekeeper-github/README.md)
* [Google API](packages/gatekeeper-google/README.md)
* [Cloudflare API](packages/gatekeeper-cloudflare/README.md)
* [Supabase API](packages/gatekeeper-supabase/README.md)
* [Notion API](packages/gatekeeper-notion/README.md)
* [Confluence API](packages/gatekeeper-confluence/README.md)
* [Email Workers](packages/gatekeeper-email/README.md)
* [Home Assistant](packages/gatekeeper-homeassistant/README.md)
* [Slack API](packages/gatekeeper-slack/README.md)
* [Spotify](packages/gatekeeper-spotify/README.md)
* [ZoomInfo API](packages/gatekeeper-zoominfo/README.md)

## Developing

When developing, you'll want to run the front-end and back-end as two separate commands in two terminals:

    pnpm dev-server
    pnpm dev-client

Then visit: http://localhost:3000

### Contributing

At this time, we are not seeking outside contribution.

AI has made writing code easy. The hard part, today, is not writing the code, but reviewing it, making sure quality stays high, and keeping the product coherent. In that light, unfortunately, external code contributions are "donating" the easy part of the job, while creating more of the hard work.

With that said, we are happy to accept small, trivially-verified PRs that fix a problem. However, we ask that you refrain from submitting low-value PRs (e.g. typo fixes) or PRs that are more than a dozen or so lines. Such PRs will be closed with a reference to this guideline.

If you have a big idea you'd like us to consider, feel free to [open a discussion](https://github.com/cinagroup/cinaseek/discussions) about it.

This policy may change in the future as the project matures. Until then, thank you for your understanding.

## Credits

CinaSeek builds on Cloudflare OS and many other open-source dependencies. A few projects do particularly heavy lifting:

* [Pi](https://pi.dev/) (specifically, `pi-agent-core`), which made it easy to support every LLM provider with one API.
* [CodeMirror](https://codemirror.net/) provides our code editor UI and operational transform implementation for synchronizing real-time edits.
* [isomorphic-git](https://isomorphic-git.org/) is used to implement the backing storage for Gadget code and integration with external git servers.
* [Vite](https://vite.dev/), which makes the development loop so pleasant.
