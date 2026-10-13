# proof-agent-skill — audit 2026-10-13

The lens: can an agent create a wallet, get funded and pay in XNO with this
skill today without being hurt?

Previous audit 2026-10-11 (at `df82c3a`); audited here at `ae67c24` (`main`
after #9). Suite run the way the repository runs it — `npm install` then
`npm test`: **10 ok / 0 fail** before this change, **11 ok / 0 fail** after, on
Node 22.22.0. `npm ci` still exits `EUSAGE` for want of a `package-lock.json`
that `.gitignore` excludes deliberately; `ci.yml` explains the choice and uses
`npm install`. Recorded again so a later run does not read it as a finding.

## Found and fixed

- **The standalone and Hermes installs floated the library that signs every
  send, while the clone and CI pinned it.** (LOW-MEDIUM; queued by the 10-11
  audit as its own concern, which is what this is)

  `package.json:8` pins `"nanocurrency-web": "1.4.3"` exactly, and
  `.github/workflows/ci.yml:38` says in as many words *"Nothing is floating:
  package.json pins nanocurrency-web to an exact 1.4.3, and 1.4.3 pins each of
  its own four dependencies to an exact version too."* For a clone that is
  true. But a clone is not the only way in, and for a *skill* it is not the
  main one — `README.md:9` promises that "a single fetch gives an agent
  everything it needs". Every by-hand setup line asked for a **caret range**:

      README.md:41                                      npm i nanocurrency-web@^1.4.3
      SKILL.md:45                                       npm i nanocurrency-web@^1.4.3
      hermes-pr/.../proof-agent/SKILL.md:30             npm i nanocurrency-web@^1.4.3
      hermes-pr/PR_BODY.md:19                           nanocurrency-web@^1.4.3

  The last two are the ones that go to an outside maintainer: the Hermes bundle
  is what that pull request installs, so an agent installing the skill through
  it got the floating range too. `^1.4.3` admits any `1.x` — on the library that
  derives the seed (`wallet.generateLegacy`, `wallet.fromLegacySeed`) and signs
  every block (`block.send`, `block.receive`). The clone and CI would be
  testing one build of the signer while the agent ran another, which is exactly
  the claim `ci.yml` makes and this path broke.

  All four now ask for `1.4.3` exactly, and `README.md` says why in one line.

  **How bad today: latent, not live.** Checked against the registry this run —
  the newest `1.x` published is `1.4.3` itself, so `^1.4.3` resolves to the
  pinned version right now. Worth noting the `latest` dist-tag is already
  **2.0.0**, so this library does ship majors; the caret cannot cross into
  `2.x`, but it would take any `1.4.4` the day one appears, silently and only on
  the copy-paste path.

  **The law**, `test/nano-pay.test.cjs`
  (`every document installs the exact nanocurrency-web the suite ran against`):
  every `nanocurrency-web@<spec>` in the existing `DOCS` list must equal the
  version `package.json` pins. The expected version is read out of
  `package.json`, so bumping the pin needs no edit to the test — only the same
  bump in the documents. It asserts the pin is itself exact (or the law has no
  target), and that it matched at least two specs, so it cannot pass by finding
  nothing. It sits next to the repo's existing byte-identity law over the three
  script copies and extends the same discipline to the dependency. Against the
  documents as on `main` the suite exits **1**; with the fix, 11 ok.

## Checked and found correct — no change made

Two hypotheses tested against the real library and discarded. Recording them so
a later run does not re-open them:

- **`send` checks the amount with `BigInt` but hands the signer the original
  string** (`nano-pay.cjs:26` checks `BigInt(amountRaw)`, `:31` passes
  `amountRaw:String(amountRaw)`). If `BigInt` and the signer's parser disagreed
  on any spelling, the amount checked would not be the amount signed. Tested
  against `nanocurrency-web` 1.4.3 directly, signing real blocks off a fixed
  frontier: `"5"`, `" 5 "`, `"  5"`, `"5 "` and `"0x10"` all produce exactly
  the balance `BigInt` had checked (`...995` for the four fives, `...984` for
  the sixteen). bignumber.js trims whitespace and reads `0x` the same way
  `BigInt` does, so there is no divergence to exploit. `"5.5"`, `"1e3"` and
  `"5_000"` are refused by `BigInt` before anything is signed.
- **`info()` can return an object with an empty `frontier`**
  (`nano-pay.cjs:17`, `r.frontier||''`), which `send` would then sign against.
  Traced: an RPC answering `{}` with no error gives `balance:'0'`, so the
  balance check at `:29` throws `insufficient balance` and nothing is signed. A
  reply carrying a balance but no frontier reaches `work('')`, which a node
  errors on, and `work()` throws `work_generate failed` after four attempts.
  Both ends fail closed, and reaching either needs a lying endpoint.

## What I checked, end to end

- **`nano-pay.cjs` in full, all 42 lines**, with attention to what #8 and #9
  changed since the 10-11 audit: `xnoToRaw`'s five refusals (not a decimal
  number, more than 30 decimal places, zero or less, above `SUPPLY_RAW`, and
  the bounded 80-character echo of the argument it quotes back), and that they
  run **before** any RPC call, so a bad amount is refused offline.
- **`send`**: destination checksum-validated before any work or RPC; the amount
  compared with `BigInt`, never a float; `walletBalanceRaw` and `frontier` taken
  from one `account_info` reply, so the mismatch that bit `nano-wallet-xno#4` is
  not present; the balance re-read after the auto-receive pass; the amount
  checked against the balance before the block is built.
- **`receive`**: the open-vs-receive subtype and the `ZERO` frontier on an
  unopened account; the pending amount comes from the node, and a node that
  misreports it produces a block the network rejects, so it is self-correcting.
- **`fund`**: the URI amount and the `needXno` figure in the `message` are now
  both derived from the same parsed raw, which is what #9 fixed.
- **The float that is not a defect**, unchanged and noted again: `balance` and
  `fund` report `balanceXno` through `Number(BigInt(raw)*1000000n/RAW)/1e6`.
  That is a float, but only ever a human-readable field beside the exact
  `balanceRaw`; no amount that is signed or sent passes through it.
- **The three-copy byte-identity law still holds** after this change: the lines
  edited are prose above the fenced copy, not the script, and the law passes.
- **No secret in the tree.** The seed is read from `NANO_SEED` and never
  written; `new` prints a freshly generated one to stdout, which is the
  documented and intended behaviour of that command.

## Could not verify

- **Anything against the live Nano network.** The suite is offline by
  construction and points the script at `http://127.0.0.1:1`. No block was
  signed against a real frontier, no XNO moved, and `send`, `receive` and
  `balance` were read and reasoned about rather than executed against a node.
- **Whether any agent installed a `1.x` other than 1.4.3.** None exists to
  install today; the finding is what the documents permitted, not a recorded
  event.
- **What `nanocurrency-web` 2.0.0 changes.** Not read: nothing in this
  repository can reach it, since the pin and now every documented install name
  `1.4.3`. Moving to it would be its own piece of work with its own evidence.
