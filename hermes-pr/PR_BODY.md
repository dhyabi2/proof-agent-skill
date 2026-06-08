# Add optional skill: `blockchain/proof-agent` (agent commerce on Nano/XNO)

## What
Adds a new optional skill, **`proof-agent`**, under `optional-skills/blockchain/`. It lets a Hermes
agent autonomously operate on the [Proof Agent](https://proof-agent.space) marketplace:

- **create a Nano (XNO) wallet** and **ask its owner to fund it** (never fabricates a purchase),
- **buy** pressure-tested startup ideas/blueprints feelessly and **install** them as skills,
- **earn XNO by reviewing** ideas — quality-weighted, Sybil-resistant bounties from a community pool.

Install (after merge):
```bash
hermes skills install official/blockchain/proof-agent
```

## Files
- `optional-skills/blockchain/proof-agent/SKILL.md` — the skill (Hermes frontmatter convention).
- `optional-skills/blockchain/proof-agent/scripts/nano-pay.cjs` — small, auditable Nano client
  (`nanocurrency-web@^1.4.3`, public-RPC failover, **no API key, no custodian**). Commands:
  `new · address · balance · receive · fund · send`.

> Docs/catalog pages are auto-generated — run `python website/scripts/generate-skill-docs.py` to
> regenerate `optional-skills-catalog.md` and the per-skill page.

## Why it fits `blockchain`
Like `solana`/`evm`/`hyperliquid`, this is a chain-native skill — it's built entirely on Nano (XNO):
feeless payments, wallet identity, on-chain settlement. The new angle is **agent-to-agent commerce**
(buy/sell/review), so tags include `Agent-Commerce` and `Marketplace`.

## Safety review (money-moving skill)
This skill makes an agent **hold a key and send real value**, so it was designed conservatively:
- **Budget is a hard cap** — the agent sends the exact listed `priceRaw`, nothing more.
- **Owner funds it** — an unfunded agent shows a `nano:` URI and asks; it never spends what it can't.
- **`NANO_SEED` never logged/committed** (documented; `600` perms).
- **Public RPCs with failover** — no third-party key, no custodial wallet, no secret exfil path.
- Purchased instructions are flagged **untrusted** ("resilience-certified" = a validation/retry
  contract, not a safety guarantee) and told to run scoped.
- The `nano-pay.cjs` dependency is **version-pinned**; the script is ~40 lines and fully auditable in this PR.

## Verification
End-to-end tested against production with two fresh agent identities — wallet lifecycle, discovery,
order + pre-pay gate, listing, review submission, and the anti-abuse gates (self-review block,
min-rationale, duplicate-notes) all pass; review→consensus and the quality-weighted community
standings are live. (Payment leg verified on-chain separately.)

## Notes for maintainers
- Please confirm `blockchain` is the preferred category (vs. a new `commerce`/`agent-commerce`).
- Update the `author:` GitHub handle if you'd like a different attribution.
- The canonical, always-current skill is also hosted at `https://proof-agent.space/skill.md`
  (agentskills.io standard) — this PR vendors a pinned copy into the official catalog.
