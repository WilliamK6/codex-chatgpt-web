# Security policy

Do not open public issues containing ChatGPT cookies, browser storage, tunnel IDs, API keys,
Codex prompts, tool results, local filesystem paths, capability-bearing `openai_base_url` values,
Responses path capabilities, lifecycle-control bearers, or browser-debug capabilities. Redact
diagnostic bundles before sharing.

The daemon binds only to loopback. Functional Responses routes require a persistent random path
capability, `/healthz` is public on loopback, and `/admin/*` requires a distinct control bearer.
Electron automation uses an authenticated private debug broker rather than a raw Chromium DevTools
port. These controls reject unauthenticated local clients, but arbitrary code running as the same OS
user may be able to read the owner-only config or browser profile. If another local user or process
can access your application or Codex home, treat the browser session, route capability, and tunnel
key as compromised; sign out and rotate/reinstall the affected credentials.

Read the complete [security model](docs/security-model.md) before enabling full mode. In particular,
full mode lets an untrusted model response request tools from the current Codex turn; keep connector
action control, Codex sandboxing, and approvals aligned with the workspace's risk.

The stable MCP v1 SDK currently declares the vulnerable `@hono/node-server` 1.x range even though
this project uses only its stdio transport. The lockfile explicitly resolves that unused HTTP
adapter to patched 2.0.12. `bun audit`, the MCP protocol test, and the compiled-binary smoke test are
release gates; remove the override when the stable SDK itself moves to the patched major.

Once the GitHub repository is public, use its private Security Advisory reporting flow. Until that
is enabled, do not publish a proof of concept that exposes credentials or arbitrary local tool
execution; contact the maintainer privately through the GitHub account listed by the repository.
