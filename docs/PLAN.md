# Plan: later ideas

Not in v1. Nothing here is committed work; the build spec is `DISTRO_BUILD_SPEC.md`.

## Account provisioning via API

Built for TokPortal: `connect_tokportal`, `tokportal_list_tools` and `tokportal_call` (scope `managed`) pass through to TokPortal's own MCP server, on the user's TokPortal account and credits. See `mcp/src/remote.ts`.

Still open:

- **Two publish paths.** `publish` posts through Zernio to accounts the user linked by OAuth. TokPortal accounts are posted to with TokPortal's tools. One `publish` over both is not built.
- **Not verified against a live TokPortal account.** Sign-in, a dry run and a real order have not been run end to end; only the request shapes were checked against TokPortal's docs and discovery endpoints (2026-11-11).
- **Account marketplaces (e.g. AccsMarket) are left out.** Their accounts have unclear origin and can be reclaimed by the first owner.
- **Platform terms.** TikTok and Instagram forbid inauthentic accounts, so bans can hit a user's brand. The tools say so before the first order.
