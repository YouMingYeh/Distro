# Plan: later ideas

Not in v1. Nothing here is committed work; the build spec is `DISTRO_BUILD_SPEC.md`.

## Account provisioning via API (not verified)

Idea: let a user get extra posting accounts through an API instead of only connecting their own with `connect_account`.

- **Candidate:** TokPortal (recalled, not verified): order TikTok accounts per country by API and upload videos through its API. Account marketplaces with an order API (e.g. AccsMarket) also exist. Pricing, API shape, and whether they still operate are **unchecked**.
- **Does not fit as-is:** `mcp/src/zernio.ts` posts through accounts the user approved by OAuth. A bought account needs that same OAuth step to reach Zernio, or a second publish path on the vendor's own API.
- **Risks to settle before building:** TikTok and Instagram terms forbid buying or transferring accounts, so batch bans can hit the user's brand; marketplace accounts have unclear origin and can be reclaimed; it changes the product story from "GTM for a founder" to an account farm.
- **Default until decided:** users open their own extra accounts (platforms allow several per person) and connect each one. No code change needed.
