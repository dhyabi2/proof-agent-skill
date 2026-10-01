# proof-agent-skill — audit 2026-10-01

First audit of this repository. Reviewed at commit `ab610b2`.

## What was checked

- `nano-pay.cjs` line by line: the wallet commands, the RPC failover, the `work_generate`
  difficulties, the receive loop, the send path, and every amount that crosses them.
- The two other copies of the same script — the one embedded in `SKILL.md`, which is what
  an agent installing from `proof-agent.space/skill.md` actually runs, and
  `hermes-pr/optional-skills/blockchain/proof-agent/scripts/nano-pay.cjs`. All three were
  byte-identical before this change.
- The first step a new agent takes: clone, then `node nano-pay.cjs new`.
- Every behaviour claim `README.md` and `SKILL.md` make about the helper.
- `nanocurrency-web@1.4.3` itself, installed and exercised: what `tools.addressToPublicKey`,
  `tools.validateAddress` and `block.send` do with an address that is not an address.
- Secrets: the working tree (9 files) and every blob version in the repository's full
  history (19 blob versions). Clean — no key, token, seed or `.env` value. The one address
  in the source is the public default representative.
- `.well-known/skills/index.json` against the `agentskills.io` shape and against `SKILL.md`.

## What was found

**1. A clone cannot run the helper.** The repository shipped no `package.json`, and
`.gitignore` excluded `package-lock.json`. From a clean clone:

```
$ node nano-pay.cjs new
Error: Cannot find module 'nanocurrency-web'
```

The README called the helper "a small, auditable, **dependency-pinned** Nano client
(`nanocurrency-web@^1.4.3`)" — the version was pinned in prose and nowhere else. `SKILL.md`
does tell an agent `npm init -y && npm i nanocurrency-web@^1.4.3`, so an agent that
*installs the skill* is fine; an agent or a human who clones the repository, which is what
the README's "Manual" install says to do, hits the error above on its very first command.
There was also no way to run any check at all against the thing that holds the key.

**2. The recipient guard did not check the recipient.** `nano-pay.cjs:14`

```js
function valid(a){ if(!a||(!a.startsWith('nano_')&&!a.startsWith('xrb_')))return false;
                   try{return tools.addressToPublicKey(a)!==null;}catch{return false;} }
```

`tools.addressToPublicKey` in `nanocurrency-web@1.4.3` decodes the base32 body and checks
neither the checksum nor the length. Measured against the library directly:

| input                                            | `addressToPublicKey`               | `validateAddress` |
|--------------------------------------------------|------------------------------------|-------------------|
| `nano_3arg…qgjps4` (real)                        | `a30e0a32…de59ef`                  | `true`            |
| the same, one body character changed             | `a30e0a72…de59ef` (**no refusal**) | `false`           |
| the same, last checksum character changed        | `a30e0a32…de59ef` (**no refusal**) | `false`           |
| `nano_3abc`                                      | `a12a` (**no refusal**)            | `false`           |
| `nano_`                                          | `""` (**no refusal**)              | `false`           |

So `valid()` returned true for all of them and `send()` carried on. What happens next is the
cost: `send` calls `info()`, and when the balance looks short it calls `receive(seed)`, which
grinds proof-of-work and **publishes real receive blocks on the agent's own chain** — all for
a payment that cannot go out. Only at the end does `block.send` refuse, with
`Invalid toAddress`. Demonstrated before the fix, with the node pointed at the discard port:

```
$ node nano-pay.cjs send nano_3arg3bsgtigae3xck…qgjps4 1000000000000000000000000
ERROR: fetch failed          # it went to the network for an address it should have refused
```

**Money was not at risk.** `block.send` does validate its `toAddress`, so a mistyped
recipient was refused before any send block was signed, and no XNO could go to an address
nobody controls. This is a guard that did not guard, not a lost-funds defect: the agent paid
in work, in published blocks and in a misleading error (`fetch failed`, or
`Invalid toAddress`) instead of `invalid recipient`.

## What was fixed

Branch `fix/nano-pay-runs-and-checks-the-recipient`.

- `package.json` declares `nanocurrency-web@^1.4.3` and an `npm test`; `package-lock.json` is
  committed (removed from `.gitignore`) so `npm ci` installs the same bytes every time.
  "Dependency-pinned" is now true of the repository and not only of the sentence.
- `valid()` uses `tools.validateAddress`, which checks the checksum and the length and
  refuses a non-string without throwing. Applied identically to all three copies of the
  script, so the installed skill and the file cannot drift.
- `nano-pay.cjs` exports `{xnoToRaw, valid, rpc, info, receive, send}` and runs its CLI under
  `require.main === module`. Run as a script it behaves exactly as before — verified command
  by command — and the guard and the amount arithmetic can now be checked with no node, no
  seed and no funds.
- `test/nano-pay.test.cjs`: 8 offline checks. The helper loads its dependency and prints its
  usage; a real address is accepted in both the `nano_` and the `xrb_` spelling; a wrong
  checksum, a wrong checksum digit, a truncated address, an empty body, junk, an over-long
  body and a non-string are each refused; XNO converts to raw exactly to the thirtieth
  decimal; and the three copies of the script are asserted to agree.
- README: the install line, and `npm ci && npm test` before the helper is trusted with a key.

Proved: against the old `valid()`, with nothing else changed, 4 of the 8 checks fail. With
the fix, 8/8 pass — from a clean tree, through `npm ci && npm test`. A wrong-checksum
recipient is now refused in 66 ms with no node contacted at all.

## What could not be verified

- **No network.** This sandbox's policy denies outbound HTTP to `proof-agent.space`,
  `agentskills.io`, `rainstorm.city`, `nanoslo.0x.no` and `rpc.nano.to` (every request
  returns no response at all, not a 404). So none of the marketplace URLs in `README.md`,
  `SKILL.md` or `.well-known/skills/index.json` was fetched, and none of the `/api/*`
  request and reply shapes `SKILL.md` documents was checked against the live service. Worth
  one pass from a connected box: `/skill.md`, `/.well-known/skills/SKILL.md`, `/llms.txt`,
  and the `POST /api/order` → `payAddress, priceRaw, orderId, unlockToken` reply the whole
  buy path depends on.
- **No live Nano node**, so `receive`, `send` and `work_generate` were never run end to end.
  Whether the public endpoints in `RPC_URLS` still serve `work_generate` without an API key
  is unverified — if they do not, `send` dies at `work_generate failed` and an agent cannot
  pay at all. That is the single most valuable thing to check from a connected box, and it
  cannot be checked from here.

## Noted, not changed

- `receive()` only advances `nfo` inside `if(pr.hash)`. If `process` answers without a hash
  the loop re-reads the same receivable and re-tries the same block up to ten times instead
  of reporting the failure. Harmless — nothing is double-received, Nano's `process` is
  idempotent for one block — but it hides the reason.
- `balance` and `fund` report `balanceXno` as `Number(BigInt(balance)*1000000n/RAW)/1e6`.
  The arithmetic is integer and the float is only the last step, so nothing is computed from
  it, but it silently truncates below 10^-6 XNO, which is inside the sub-cent range this
  rail exists for. `balanceRaw` beside it is exact, so no code change: anything that decides
  is to read `balanceRaw`.
- `fund` calls `info()` and so fails outright when no node is reachable, even though its
  whole job is to print an address and a `nano:` URI to ask an owner for money — neither of
  which needs a node. An agent that cannot reach an RPC therefore cannot even ask to be
  funded. A real defect on the onboarding path, but fixing it changes what `fund` does on
  failure, which is a separate concern from this branch.
- There is no CI. The other Tier 0 Python repositories each run their suite on push
  (`.github/workflows/test.yml`); with `npm test` now existing, this repository could too.
