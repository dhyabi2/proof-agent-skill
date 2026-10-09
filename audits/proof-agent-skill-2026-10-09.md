# proof-agent-skill - audit 2026-10-09

Read through one question: can an agent pay in XNO with this, today, without being hurt?

HEAD audited: `04dabbf` on `main`. Node, one pinned dependency (`nanocurrency-web` 1.4.3).

**Nothing was changed.** No defect was found that is worth a patch. The one thing this audit wanted
to check and could not is the marketplace's own URLs - see "Could not verify", which also records
why this environment cannot answer that question and why a reader should not treat its silence as
an outage.

## Checked

- **The documented setup, exactly as the README prints it.** `npm install` (pins
  `nanocurrency-web` 1.4.3), then `npm test` -> all 7 checks pass, including
  `new` printing a usable seed and a checksum-valid address, `address` re-deriving exactly the
  address `new` printed, usage on stderr with exit 1, and a wrong-checksum recipient refused
  before any work is done.
- **All three copies of the payment script are byte-identical.** `npm test`'s last check asserts
  it, and `diff nano-pay.cjs hermes-pr/.../scripts/nano-pay.cjs` is empty; the inline copy in
  `SKILL.md` was read against the file line by line. This is what PR #6 added and it holds - the
  drift that check exists to catch has not happened.
- **Amount handling is integer end to end.** `RAW` is a `BigInt`; `xnoToRaw` splits on the
  decimal point and composes `BigInt(whole) * RAW + BigInt(frac padded to 30)`, so no float is
  involved; `send` compares `BigInt(amountRaw)` against `BigInt(nfo.balance)` and passes
  `String(amountRaw)` to `block.send`. A non-integer `amountRaw` (`0.5`, `1e-6`) makes
  `BigInt()` throw and is refused by the top-level handler rather than rounded.
- **The frontier/balance pair, which is the defect open as `nano-wallet-xno#4` in a sibling
  repository.** `info()` takes `balance` and `frontier` from **one** `account_info` answer
  and `send` builds the block from that single pair, so the two describe the same point on the
  chain. `receive()` re-reads `info()` after each successful `process` rather than carrying a
  stale pair into the next block. The mismatch that lets a send move more XNO than asked is not
  reachable here.
- **A lost `process` reply cannot pay twice.** `rpc()` falls through to the next endpoint when a
  call throws, and that includes `process`. The block is signed **once**, before the loop, so a
  fall-through re-broadcasts the identical signed block, which has the identical hash and is
  idempotent on the ledger. This is the same hazard `nano-wallet-xno#12` fixed; the structure here
  does not have it.
- **The recipient check.** `valid()` requires a `nano_`/`xrb_` prefix and then
  `tools.validateAddress(a) === true`, i.e. the checksum, inside a `try` that treats a throw as
  invalid. `send` calls it first, before the seed is read or any work is requested. This is what
  PR #4 fixed and it is still first in the function.
- **The work difficulties are the right ones.** `fffffff800000000` for send/change and
  `fffffe0000000000` for receive are the current Nano epoch-2 thresholds; they are not swapped.
- **Documented absence of a cap, which is the honest version.** README "Safety" says in as many
  words that nothing bounds a payment but the balance, and `npm test` carries a check named
  "no document promises a spend cap, because `send` has none" - so the documents and the code
  agree. The README also tells the buyer to compare `priceRaw` against the `priceXno` it vetted
  before paying, which is the mitigation that belongs to the caller.
- **Secrets, in the tree and in `git log --all -p`.** None. No 64-hex literal appears outside the
  all-zero `ZERO` frontier constant, and no `NANO_SEED=` or seed assignment appears in history.
  The seed is read from the environment only and is never logged by any command.

## Found

Nothing worth a patch. Two observations are recorded so a later run need not re-derive them:

1. **`fund` prints a 6-decimal `balanceXno` and no raw figure.** `Number(BigInt(balance) *
   1000000n / RAW) / 1e6` truncates to micro-XNO. The integer division happens in `BigInt` and
   the `Number` conversion is exact for any balance under ~9 billion XNO, so the figure is not
   wrong - it is floored, and `fund`'s output is the one place it appears without `balanceRaw`
   beside it (the `balance` command prints both). Flooring a funding ask is the safe direction,
   so this is a readability note rather than a wrong amount.
2. **`receive` is bounded at 10 blocks per invocation** (`for(let p=0;p<10;p++)`, taking
   `e[0]` each pass). An agent with more than 10 receivables gets a partial receive, after which
   `send` may still report `insufficient balance` with funds genuinely pending; the fix is to
   run `receive` again. A bounded loop is the right shape for an autonomous retry, so this is
   deliberate rather than broken, but the README's "`send` auto-receives pending funds first"
   does not say it is bounded.

## Could not verify

- **Every URL this skill publishes.** `proof-agent.space/skill.md`,
  `/.well-known/skills/SKILL.md`, `/llms.txt` and `agentskills.io` could not be reached from
  this environment, and **that says nothing about those sites.** Two different mechanisms fail for
  two different reasons: the HTTP proxy answers `403 to CONNECT` (a policy denial, logged as
  `connect_rejected` by the proxy's own status endpoint), and the container's resolver returns
  NXDOMAIN. The resolver is allow-listed, which a positive control in the same command establishes:
  `github.com` and `rpc.nano.to` resolve, while `proof-agent.space`, `agentskills.io` **and
  `rainstorm.city`** do not - and `agentskills.io` and `rainstorm.city` are both certainly
  live. So the install URL in the README, which is the first step a new agent takes, is **unchecked
  here, not broken**. A run from a box with open egress should check it; this one cannot, and must
  not be read as having found it down.
- **Any live payment.** No XNO moved. `npm test`'s network-touching checks print
  `ERROR: fetch failed` in this environment for the same reason, and the suite is written to pass
  on the refusal path regardless.
- **`work_generate` availability on the three default public RPCs.** Public Nano RPC proxies
  commonly do not expose wallet or work actions without a key, and `send` cannot complete without
  one of them answering `work_generate`. Unreachable from here, so neither confirmed nor denied.
