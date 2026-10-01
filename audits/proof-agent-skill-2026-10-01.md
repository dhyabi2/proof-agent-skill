# proof-agent-skill — audit 2026-10-01

First audit of this repository. Lens: can an agent hold XNO, pay for a listing and get paid
for a review with this, today, without being hurt?

## Checked

- Full read of `nano-pay.cjs` (the whole XNO path: `new`, `address`, `balance`, `receive`,
  `fund`, `send`), of the inline copy in `SKILL.md` (lines 46–83) and of the second copy under
  `hermes-pr/optional-skills/blockchain/proof-agent/scripts/`. All three were byte-identical
  before this change and are byte-identical after it.
- Ran the script against `nanocurrency-web@1.4.3`: `new` and `address` behave as `SKILL.md`
  documents (`new` prints a 64-hex seed and its address; `address` without `NANO_SEED` fails
  cleanly).
- Amount handling: `xnoToRaw` is integer-only (`BigInt` whole part × 10^30 plus a 30-digit
  zero-padded fraction) and `send`/`receive` carry `amountRaw` as strings end to end. The only
  float in the file is the `balanceXno` **display** field, computed from integers
  (`BigInt(balance) * 1000000n / RAW / 1e6`), never used to build a block. No float on a
  payable amount.
- Proof-of-work difficulties: send `fffffff800000000`, receive `fffffe0000000000` — both the
  current epoch-2 thresholds.
- `.well-known/skills/index.json` parses and its `skills[0].url` matches the install line in
  `README.md`.
- Secret scan of the tree and of all four commits of history: none. `NANO_SEED` and
  `NANO_RPC_KEY` are read from the environment and never written to stdout.

## Found and fixed

**`nano-pay.cjs:14` — the recipient guard accepted malformed Nano addresses.** `send()` opens
with `if(!valid(to))throw new Error('invalid recipient')`, and `valid()` read
`tools.addressToPublicKey(a) !== null`. That function is a decoder, not a validator: measured
against `nanocurrency-web@1.4.3` it never returns `null` and never throws for bad input —

| recipient | `addressToPublicKey` | old `valid()` |
|---|---|---|
| a one-character payload typo | a *different*, well-formed public key | `true` |
| a one-character checksum typo | the original public key (checksum ignored) | `true` |
| `nano_1` | `""` | `true` |
| `nano_zzzz…` (60 z) | `ffff…ff` | `true` |

so the guard was dead for every case it was written for. `send()` then went on to read the
account, publish **receive blocks on chain** when the balance was short (real proof-of-work,
real ledger writes), spend up to 4 × 28 s generating send work, and only then die inside the
library with `ERROR: Invalid toAddress`. No XNO is misdirected — `block.send` does validate
`toAddress` and refuses — but the fail-fast check is after-the-fact, on-chain side effects have
already happened, and the error an agent sees names the library rather than its own bad input.

Fixed by using the validator the same library already ships: `tools.validateAddress(a) === true`.
It rejects all four rows above and still accepts both `nano_` and `xrb_` addresses. Applied to
all three copies of the script so they stay identical.

**`README.md:32` — "dependency-pinned" was not true.** There was no `package.json` and no
lockfile in the tree, and `SKILL.md` instructs `npm i nanocurrency-web@^1.4.3`, a range.
Reworded to "one dependency"; a `package.json` declaring that one dependency and a `test`
script is now in the tree so the claim and the install line agree.

Added `test/valid-recipient.test.cjs` (`node --test`, no network): it runs the shipped script
as a subprocess with `NANO_RPC_URLS` pointed at a closed local port, so a recipient that gets
past the guard fails with an RPC error instead — which makes the error that comes out an
assertion about the guard. 4 fail / 2 pass before the fix, 6 pass after.

## Could not verify

- Every `proof-agent.space` and `agentskills.io` URL in `README.md`, `SKILL.md` and
  `.well-known/skills/index.json`. This session's network policy answers 403 to CONNECT for
  all of them, so the install one-liner
  (`hermes skills install https://proof-agent.space/skill.md`), `/llms.txt` and every
  `/api/*` endpoint in `SKILL.md` are unchecked here. Worth one manual `curl` per URL.
- The live `send`/`receive` path against the public Nano network (needs a funded seed, and the
  three default RPC endpoints are unreachable from here). In particular, whether
  `rainstorm.city/api`, `nanoslo.0x.no/proxy` and `rpc.nano.to` all still serve
  `work_generate` without a key, as `SKILL.md:43` claims ("no API key needed"). If none of
  them does, `send` fails after ~5½ minutes of retries with `work_generate failed`.

## Noted, not changed

- `rpc()` sends `NANO_RPC_KEY` as an `Authorization` header to **every** URL in `NANO_RPC_URLS`,
  not only to the endpoint it belongs to. An operator who sets a key for one provider leaks it
  to the other two. Left alone: it is a credential path and the default configuration sets no
  key, so a fix belongs in its own reviewed change.
- `work()` swallows every error from `work_generate` and retries 4 times at 28 s across up to
  3 endpoints, so an endpoint that refuses the action costs minutes before `send` reports
  `work_generate failed`. Real, but a behaviour change rather than a defect.
- `receive()` refreshes account state only after a successful `process`, so a `process` that
  answers without a hash makes the loop re-attempt the same receivable block up to 10 times.
  Idempotent on the ledger (same block), so no user is hurt.
