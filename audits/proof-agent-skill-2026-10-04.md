# proof-agent-skill — audit 2026-10-04

Lens: can an agent get paid and pay in XNO with this skill, today, without being hurt?

Baseline on `main` `bd5b448`: `npm install` (5 packages), `npm test` **4 ok / 0 fail**. There is no
CI in this repository (no `.github/`), so every claim below is a local measurement.

## Checked

- `nano-pay.cjs` end to end — `new`, `address`, `balance`, `receive`, `fund`, `send` — and the RPC
  failover, work difficulties and block construction underneath them.
- Whether the amount `send` *checks* can differ from the amount it *signs*.
- All three copies of the script in the tree, against each other.
- Every safety claim in `README.md`, `SKILL.md`, the Hermes PR copy and `PR_BODY.md`, against the
  code that implements it.
- The buy flow as an agent would execute it, step by step.

## Found and fixed — the "hard cap" four documents promise does not exist

`README.md:50` said, under **Safety (read before running)**:

> **Budget is a hard cap** — the agent sends the exact listed `priceRaw`, nothing more.

and `SKILL.md:155`, the Hermes copy and `PR_BODY.md` said the same. **There is no cap.** Searched the
whole tree: no budget, no maximum, no `MAX_*`, nothing. `send`'s only refusals are an invalid
recipient, a non-positive amount, and more than the wallet holds.

Measured 2026-10-04 against a freshly generated, unfunded wallet and the public RPC:

```
$ node nano-pay.cjs send nano_1banexkcf...hajojmq 1000000000000000000000000000000000000
ERROR: account unopened / no funds
```

A million XNO was refused by the **balance**, not by any cap — and offline, with the RPC pointed at
`127.0.0.1:1`, the same absurd amount gets past every argument check and dies on the network, which
is what proves no size refusal exists at all.

Worse, the number being sent is not the number the agent vetted. The buy flow was:

```
1-2. Discover / vet          -> priceXno
3.   POST /api/order         -> payAddress, priceRaw      <- a DIFFERENT number, from the server
4.   nano-pay.cjs send <payAddress> <priceRaw>
```

Nothing compared `priceRaw` against the `priceXno` the agent read one step earlier, and the helper
will send whatever it is handed up to the entire balance. For a skill whose own Safety section opens
"this skill makes an autonomous agent **hold a key and send real money**", on a rail with no
chargeback, that is the wrong thing to be wrong about.

Fixed by making the documents say what is true and adding the one check that makes a cap real — a
step 4, before paying: convert what you vetted at 1 XNO = 10^30 raw and **refuse** if `priceRaw` is
higher. The agent is the only actor that knows what it vetted, so it is the only place the check can
live. `nano-pay.cjs` is **not touched**: no amount, destination, rounding or key path changes, and the
change only ever adds a refusal.

For a skill repository the markdown *is* the program, so this is pinned by a law in the suite rather
than left to drift: `send` has no cap mechanism (asserted both by running it and by searching the
script), therefore no document may promise one, and the buy flow must carry the comparison. If a real
cap is ever added, the law says to update it rather than delete it.

Failing-then-passing, with the law kept and the four documents alone reverted to `main`:

```
FAIL no document promises a spend cap, because `send` has none
     README.md promises a "hard cap" that nano-pay.cjs does not implement
```

After: **5 ok / 0 fail**.

## Checked and found sound

- **The amount checked is the amount signed.** `send` guards with `BigInt(amountRaw)` but signs
  `String(amountRaw)`, which could have diverged. Measured against `nanocurrency-web` 1.4.3 for every
  form `BigInt` accepts — `"16"`, `"0x10"`, `"0100"`, `" 100 "`, `"100\n"` — the block deducts exactly
  what `BigInt` read, every time. The forms `BigInt` rejects (`"1e+26"`, `"1_000"`) are refused by
  `send` before anything is signed, so the exponent form a JavaScript caller would produce from
  `String(1e26)` fails closed rather than sending 1e26 raw.
- **#4's checksum fix reached every copy that carries the script.** This tree holds the helper three
  times (`nano-pay.cjs`, inlined in `SKILL.md`, and `hermes-pr/.../scripts/nano-pay.cjs`) — exactly
  the shape where a money fix lands in the file nobody installs. All three carry
  `tools.validateAddress(a)===true`, and `SKILL.md`'s inline copy is **byte-identical** to
  `nano-pay.cjs`. The Hermes `SKILL.md` inlines no script at all; it references the file.
- **Work difficulties are the right way round:** `fffffe0000000000` for receive, `fffffff800000000`
  for send.
- **`process` retry across endpoints is safe.** A published block has a fixed hash, so re-publishing
  the same signed block on the next endpoint cannot double-spend.
- **`xnoToRaw`** is integer `BigInt` throughout, with the fraction padded and truncated to 30 places.
  No float touches an amount on the send path.

## Could not verify

- **Every `proof-agent.space` and `agentskills.io` URL.** All answer `000` from here — this
  environment's network policy denies them (the same CONNECT refusal that blocks
  `search.paypercall.dev`), so whether `/skill.md`, `/.well-known/skills/SKILL.md` or `/llms.txt`
  resolve could **not** be tested and no claim is made either way. The public Nano RPC *is* reachable,
  which is how the send measurement above was taken.
- **No real payment.** Nothing in this run moved XNO. The send path was exercised against an unfunded
  throwaway wallet and an unreachable RPC only.
- **`balanceXno` loses sub-microXNO balances.** `Number(BigInt(balance)*1000000n/RAW)/1e6` truncates
  to 6 decimals, so `fund` — which prints `balanceXno` and no raw figure — reports `0` for any balance
  under 10^24 raw. Noted, not fixed: it is display, `balance` prints `balanceRaw` beside it, and
  changing what `fund` prints is not a defect this run can show hurting anyone.
