# proof-agent-skill — audit, 2026-10-14

Lens: can an agent pay in XNO with this, today, without being hurt?

## Checked

- `npm install && npm test` — 11 ok / 0 fail, exit 0, before any change.
  (`npm ci` cannot be used here and that is deliberate: no lockfile is committed,
  `.gitignore` lists it, and `package.json` pins `nanocurrency-web` to an exact
  1.4.3 which pins its own four dependencies exactly. `.github/workflows/ci.yml`
  says so and runs `npm install`, which is also what README.md tells an agent.)
- `node nano-pay.cjs new` — the README's own first step, in a fresh clone: a
  64-hex seed and a checksum-valid `nano_` address.
- `nano-pay.cjs` end to end, all 42 lines: `xnoToRaw`, `rpc` failover, `work`,
  `info`, `valid`, `receive`, `send`, and all six commands.
- **The amount path, empirically.** `send` guards with `BigInt(amountRaw)` and
  then signs `String(amountRaw)`, which are two different readers of one string,
  so I probed whether they can ever disagree. They do not: `"0x10"`, `"0b101"`,
  `"0o17"`, `" 10 "`, `"10\n"` all give the same number through `BigInt` and
  through `nanocurrency-web`'s `block.send` (checked by differencing the signed
  block's balance), and `"1_0"`/`""` are refused by both. No float touches an
  amount anywhere on the send path; `xnoToRaw` is integer BigInt throughout,
  `\d` in its regex is ASCII-only, over-30-decimal input is refused unless the
  extra digits are zeros, and the total-supply bound holds.
- `valid()` on the recipient: prefix plus `tools.validateAddress` checksum, and
  it is the first thing `send` does.
- Receive difficulty `fffffe0000000000` and send difficulty `fffffff800000000`
  are the right way round, and the unopened-account path uses the public key as
  the work root with `frontier: ZERO` and `subtype: 'open'`.
- A node that misreports a receivable `amount` cannot cost the agent anything:
  Nano itself validates that a receive block's new balance equals the source
  send's, so a wrong amount yields a rejected block, not a short credit.
- README.md's claims against the code: "`send` auto-receives pending funds
  first" (true, when the balance is short), "no API key, no custodian" (true),
  and the safety section's claim that `SKILL.md` step 4 is the only spend cap —
  step 4 exists and says exactly that. No document promises a cap that `send`
  does not have, which the suite also pins.
- Both file copies of the script and the inline copy in `SKILL.md`.

## Found

**`nano-pay.cjs:38` — `fund` produced nothing at all when no Nano RPC answered.**
`const i = await info(a)` was awaited unguarded, and `rpc()` throws when every
endpoint in `NANO_RPC_URLS` fails, so one unreachable node took the whole
command down: `ERROR: fetch failed`, exit 1, no address and no URI printed.

Measured, with the RPC list pointed at a closed port:

```
$ NANO_RPC_URLS=http://127.0.0.1:1 node nano-pay.cjs fund 0.5
ERROR: fetch failed
exit=1
```

`fund` is how an **unfunded** agent asks its owner for XNO — step 2 of both
README.md ("Get funded") and SKILL.md. Every field an owner needs from it is
derived locally from the seed: the address, the `nano:` URI and the amount. The
only field that needs a node is `balanceXno`, and that is the one field an agent
with no money yet has no use for. So an agent in a no-egress sandbox, or behind
a public-RPC outage or a rate limit, could not ask to be funded at all — and so
could never pay for anything, which is the single thing this skill exists to do.

Why it survived ten audits: the 2026-10-04 fix moved the amount *parse* ahead of
the RPC call, which is what made the offline checks possible — but every offline
check written since exercises a **refusal** (`fund -5`, `fund 0`, `fund .`). The
success path had no offline coverage at all.

## Fixed

The balance read is wrapped, so everything local still prints and the balance is
reported as `null` with a `balanceNote` saying why. `null` is deliberately not
`0`: a node that answered says the account holds nothing, an unreachable one
says nothing at all — the same distinction between a fact and an unknown that
`nano-receipt-ledger`'s node layer draws. The node's error text is clipped to
120 characters so an endpoint cannot choose an unbounded message.

Nothing on the send path changed. No amount, destination, rounding or key path
is touched, and no refusal was widened — `fund` cannot move money and still
refuses every amount it refused before.

The same edit is applied to both file copies and to `SKILL.md`'s inline copy, so
the suite's byte-identical law still holds. (The detector I wrote to find the
copies missed the `SKILL.md` one; the repository's own check caught it, which is
the check working.)

Tests: `` `fund` still prints the address and URI when no node can be reached ``
— asserts the address against the library's own derivation, the exact `nano:`
URI including `?amount=500000000000000000000000000000`, `needXno`, the message,
`balanceXno === null` and the note, plus the no-amount form. It fails on `main`
with `Command failed ... ERROR: fetch failed` and passes after.

Suite after: **12 ok / 0 fail, exit 0.** `node --check` passes, and the change
uses nothing newer than ES2017, so CI's Node 18 floor is unaffected.

## Could not verify

- **The four documented URLs.** `https://proof-agent.space`, its `/skill.md`,
  `/.well-known/skills/SKILL.md` and `/llms.txt`, and `https://agentskills.io`,
  are all unreachable from this session — but as a **policy denial in my own
  container**, not a fault in the repository: the agent proxy answers `403` to
  `CONNECT` for those hosts (`recentRelayFailures` names each one). So this run
  can say nothing about whether they 404; it is not evidence that they do.
- The live network paths: `receive`, `send`, `balance` and `work_generate` were
  never exercised against a real node or real funds, by design — the suite
  points the script at a closed port and the repository holds no key.
- `nanocurrency-web` 1.4.3's signing itself is taken as correct; only its
  agreement with `BigInt` on amount strings was measured.

## Left alone deliberately

- `balanceXno`'s six-decimal truncation (`Number(BigInt(b)*1000000n/RAW)/1e6`),
  which reports `0` for a sub-microXNO balance. Already recorded as a known nit
  by the 2026-10-03, -04, -09 and -13 audits; the float is exact below the whole
  XNO supply and `balance` prints `balanceRaw` beside it. Not worth a change.
- `.github/workflows/ci.yml`'s comment saying the suite is "6 ok / 0 fail",
  measured 2026-10-04 and now 12. It reads as a dated measurement rather than a
  law, and a commit that only corrects a stale number is noise.
