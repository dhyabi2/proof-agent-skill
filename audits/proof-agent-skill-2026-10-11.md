# proof-agent-skill — audit 2026-10-11

The lens: can an agent create a wallet, get funded and pay in XNO with this
skill today without being hurt?

## What I checked

- Fast-forwarded to `main` (`df82c3a`). Ran the suite the way the repository
  itself runs it: `npm install` then `npm test` — **6 ok / 0 fail** on Node
  22.22.0, and the README's own first step, `node nano-pay.cjs new`, prints a
  checksum-valid address.
- **`npm ci` fails here, and it is not a defect.** It exits `EUSAGE` because
  there is no `package-lock.json`, which `.gitignore` excludes deliberately;
  `.github/workflows/ci.yml` explains the choice and uses `npm install`, the
  command the README actually tells an agent to run. Nothing floats:
  `package.json` pins `nanocurrency-web` to an exact `1.4.3` and that release
  pins each of its own four dependencies exactly. Recorded here so a later run
  does not read the `npm ci` error as a finding.
- `nano-pay.cjs` end to end — all 38 lines of it: the RPC fan-out and its
  `AbortController` timeout, `work()`'s four attempts, `info()`'s
  `Account not found` handling, `valid()`'s checksum guard on the destination,
  `receive()`'s open-vs-receive subtype and frontier handling, and `send()`.
- `send()` specifically: the destination is checksum-validated before any work
  or RPC; `amountRaw` is compared with `BigInt`, never a float; the balance is
  re-read after an auto-receive pass; the amount is checked against the balance
  before the block is built; and `walletBalanceRaw`/`frontier` are taken from
  one `account_info` reply, so the frontier/balance mismatch that bit
  `nano-wallet-xno#4` is not present here.
- `balance` and `fund` report a *display* XNO figure through
  `Number(BigInt(raw)*1000000n/RAW)/1e6`. That is a float, but it is only ever a
  human-readable `balanceXno` field alongside the exact `balanceRaw`/`amount`;
  no amount that is signed or sent passes through it. Not a defect, noted so it
  is not re-raised.
- The three-copy law: `nano-pay.cjs`, the copy under `hermes-pr/`, and the
  inline fenced copy in `SKILL.md` are held byte-identical by the suite, derived
  from disk so a fourth copy is covered without being named.

## What I found

**One defect, on the funding path: `xnoToRaw` validated nothing, so `fund`
emitted a `nano:` URI whose amount disagreed with what the agent asked for.**

`nano-pay.cjs:6` on `df82c3a`:

```js
function xnoToRaw(x){ const [w,f='']=String(x).split('.'); return (BigInt(w||'0')*RAW + BigInt((f+'0'.repeat(30)).slice(0,30))).toString(); }
```

`String(x).split('.')` destructures to the first two parts and drops the rest,
and `BigInt` accepts a leading sign, so anything BigInt would swallow became an
amount. Measured:

```
"-5"     -> -5000000000000000000000000000000
"1.2.3"  ->  1200000000000000000000000000000
"."      ->  0
"+3"     ->  3000000000000000000000000000000
```

`fund` is step 2 of both `README.md` and `SKILL.md` — the only way the agent
gets XNO at all — and it prints a `nano:` URI for the agent's **owner** to open,
next to a `message` field built from the raw argument. So:

- `fund -5` emitted `nano:<addr>?amount=-5000000000000000000000000000000`: a
  negative amount in a payment URI, which is not a thing the `nano:` scheme can
  express.
- `fund 1.2.3` emitted the URI for **1.2 XNO** while the `message` in the same
  JSON object read *"Ask your owner to fund this address with about 1.2.3
  XNO"*. The owner reads one number and their wallet shows another. That
  disagreement, inside one output, is the whole defect.

**A second part, same path:** `fund` called `info()` — a live RPC — **before**
parsing its argument, so a bad amount cost a network round trip to discover and
could not be reached by this repository's offline suite at all. That is why six
checks had covered the script for a week without touching this.

## What I fixed

`fix/fund-amount-must-be-a-decimal-number`:

- `xnoToRaw` now requires `/^(\d+\.?\d*|\.\d+)$/` on the trimmed argument and
  throws a named error otherwise. The pattern is deliberately shaped to keep
  every spelling the function already accepted — `1`, `1.5`, `.5`, `1.`,
  `0.0000001`, `133248.297`, `0`, and a whitespace-padded `  2  ` all convert
  to exactly the same raw as before. JavaScript's `\d` is ASCII-only without the
  `u` flag, so a non-ASCII digit is refused too.
- `fund` parses the amount **before** the `info()` call, so a bad amount is
  refused offline and instantly — and the offline suite can reach it.

Both changes only add a refusal and reorder two statements. They narrow what is
accepted and widen nothing; no amount, destination, rounding or key path
changes, and `send` is untouched.

All three copies of the script were updated together, so the suite's
byte-identity law still holds (verified: both files `6a94df9a`, and the
`SKILL.md` fenced copy passes the check).

**Evidence.** One check added, with a control. With the three script copies
reverted to `main` and the suite re-run:

```
FAIL `fund` refuses an amount that is not a decimal number, before any RPC call
     fund "-5": refused for the wrong reason (or too late) - ERROR: fetch failed
```

`ERROR: fetch failed` is the proof of the second part: on `main` the amount
reached the network call without ever being validated. With the fix,
**7 ok / 0 fail**.

The control half of the same check asserts that all eight real spellings above
still get *past* the parse (they then fail on the unreachable RPC, which is how
it knows the parse admitted them), so the refusal has narrowed nothing real.

## What I could not verify

- **Anything against the live Nano network.** The suite is offline by
  construction and points the script at `http://127.0.0.1:1`. No block was
  signed against a real frontier, no XNO moved, and `send`, `receive` and
  `balance` were read rather than executed.
- **Whether a real owner ever received a malformed funding URI.** The defect is
  in what `fund` accepts; I have no log showing it happened.
- **How a given wallet renders `?amount=-5...`.** I did not open the malformed
  URI in any wallet; the claim is that the scheme has no signed amount and that
  the URI contradicted the message beside it, both of which are visible in the
  output itself.
- **One thing noted and deliberately not fixed, to keep this branch to one
  concern:** `README.md:41` tells an agent setting the script up *outside* a
  clone to run `npm i nanocurrency-web@^1.4.3`, a caret range, while
  `package.json` and `ci.yml` pin an exact `1.4.3` and `ci.yml` says in as many
  words that nothing floats. For an agent that follows the README's standalone
  line, something does. It is a one-character documentation change, but it is a
  different concern from the amount parser and belongs in its own pull request.
