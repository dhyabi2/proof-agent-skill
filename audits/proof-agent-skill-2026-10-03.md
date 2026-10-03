# proof-agent-skill — code audit, 2026-10-03

First audit of this repository. Clone of `main` at `ab610b2`. Lens: can an agent create a Nano
wallet, get funded and pay in XNO with this, today, without being hurt. Tier 0 lists it in group 2
(holding XNO) as "agentskills.io skill: create a wallet, buy, pay".

Baseline before any change: there is **no test command, no dependency manifest and no CI** in the
repository. The whole payment surface is `nano-pay.cjs` (38 lines) plus the byte-identical copy
embedded in `SKILL.md`.

## Checked

- `nano-pay.cjs` end to end: `new`, `address`, `balance`, `receive`, `fund`, `send`.
- All three copies of the helper, which the README says are the same script. They are: the root
  `nano-pay.cjs`, the inline block in `SKILL.md` and
  `hermes-pr/optional-skills/blockchain/proof-agent/scripts/nano-pay.cjs` are **byte-identical**.
- Amount handling, against `nanocurrency-web@1.4.3` installed for real.
- Secret scan of the tree and all of history: no 64-hex string occurs anywhere in any commit, so no
  seed or private key has ever been committed. The `secret`/`token` matches are the documented
  `sellerToken`/`unlockToken` API fields. Clean.

## Found and fixed — the first step a new agent takes exited 1

Both `README.md` ("Get a wallet") and `SKILL.md` ("1) Get a wallet") open with
`node nano-pay.cjs new`. In a fresh clone, with no dependency manifest in the repository:

```
$ git clone <repo> && cd proof-agent-skill
$ node nano-pay.cjs new
Error: Cannot find module 'nanocurrency-web'
    at Object.<anonymous> (.../nano-pay.cjs:1:34)
exit=1
```

Line 1 of the script is `require('nanocurrency-web')`, and nothing in the repository declares it.
`SKILL.md` does carry the one-time `npm init -y && npm i nanocurrency-web@^1.4.3`, but the README —
the repository's front door, and the file whose own table says to run `node nano-pay.cjs new` — did
not mention it anywhere. An agent that clones and follows the README got an unhandled
MODULE_NOT_FOUND stack trace on its very first command.

**Fixed** by adding what the repository was missing rather than by changing the skill:

- `package.json` — `private: true` (so `npm publish` refuses), and `nanocurrency-web` at an exact
  `1.4.3`, which is also the pin the README's "dependency-pinned" claim was asserting.
- `test/nano-pay.test.cjs` + `npm test` — the repository's first test. Offline, no RPC, no funds: it
  runs `nano-pay.cjs` as a subprocess exactly as the README tells an agent to, and checks `new`
  prints a 64-hex seed and a **checksum-valid** `nano_` address, that `address` re-derives that same
  address from the seed (and that `nanocurrency-web` agrees independently), and that a bad invocation
  prints usage on stderr and exits 1.
- `README.md` — the one-time install, with the exact error it prevents, plus the standalone-copy
  instruction for someone who takes only the script.

The skill itself is unchanged: `nano-pay.cjs`, `SKILL.md` and the `hermes-pr/` copy are untouched, so
nothing an installed agent runs changes.

Evidence: with the test file but without `package.json` (the state of `main`) the suite exits 1 on
`Cannot find module 'nanocurrency-web'`; with it, `npm install && npm test` passes all three checks.

## Found, NOT fixed here — the recipient check does not verify the address checksum

`nano-pay.cjs:14`, the only guard on the destination of a real payment:

```js
function valid(a){ if(!a||(!a.startsWith('nano_')&&!a.startsWith('xrb_')))return false;
  try{return tools.addressToPublicKey(a)!==null;}catch{return false;} }
```

`tools.addressToPublicKey` decodes; it does **not** check Nano's checksum. Measured against
`nanocurrency-web@1.4.3`:

| destination | `valid()` | `tools.validateAddress()` | `block.send()` |
|---|---|---|---|
| a correct address | true | true | signs |
| one character changed in the body | **true** | false | `Invalid toAddress` |
| the address truncated to 50 chars | **true** | false | `Invalid toAddress` |
| the last 8 characters mangled | **true** | false | `Invalid toAddress` |
| `nano_` + 60 × `1` | **true** | false | `Invalid toAddress` |

**No money is lost**: `block.send` is strict and refuses every one of these, so the payment fails
closed. What the loose guard costs is the order of the failure — `send` runs `info`, possibly a whole
`receive` pass, and then up to 4 × 28 s of `work_generate` *before* `block.send` rejects the address,
and the agent is told `Invalid toAddress` rather than `invalid recipient`. The checksum is exactly
what Nano's address format carries to catch a typo at the first opportunity.

The one-line fix is `tools.validateAddress(a)`, which is strictly stricter (it agrees with
`block.send` on every case above, and accepts `xrb_` as well as `nano_`, so it cannot refuse a
payment that works today). It is **not merged here**: it is inside the script that sends money, which
this routine may open but not merge on its own. Filed as its own pull request for the owner.

## Could not verify

- **Every external URL and RPC endpoint.** This session's egress proxy answers `CONNECT ... 403` for
  every host but its allow-list, so `https://proof-agent.space`, `https://proof-agent.space/skill.md`,
  `/llms.txt`, `https://agentskills.io`, and the three default RPCs (`rainstorm.city`,
  `nanoslo.0x.no`, `rpc.nano.to`) were not reached. The README's links and the `/.well-known/skills/`
  claim are unchecked.
- **Whether the default RPCs serve `work_generate`.** `receive` and `send` both depend on it
  (`nano-pay.cjs:12`), and many public Nano RPCs disable `work_generate` or gate it behind a key. If
  all three refuse, `send` fails with `work_generate failed` after four attempts and an agent cannot
  pay at all. This is the single most load-bearing unverified assumption in the repository and wants
  one run from a machine with open egress.
- **`balanceXno` is a float** (`Number(BigInt(balance)*1000000n/RAW)/1e6`, lines 32 and 35). It is a
  display field truncated to 6 decimals, and `balance` prints `balanceRaw` beside it — but `fund`
  prints `balanceXno` *only*, so an agent holding less than 1e-6 XNO reads its balance as `0`. Left
  alone: no amount that is signed or sent passes through it. Worth a look if `fund`'s output is ever
  used for a decision.
- **`SKILL.md` installs `nanocurrency-web@^1.4.3`, not a pin**, while the README called the client
  "dependency-pinned". The new `package.json` pins the repository's own copy; the published skill's
  caret is left as it is, because changing it changes what every installed agent fetches.
