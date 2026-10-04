#!/usr/bin/env node
/**
 * Offline checks on the two `nano-pay.cjs` commands that need no network, run the
 * way the README tells an agent to run them: as a subprocess, from a clone.
 *
 * The first of them is the first step in both README.md ("Get a wallet") and
 * SKILL.md ("1) Get a wallet"), so it is also the first step a new agent takes.
 * Without a dependency manifest in the repository it exited 1 with
 * `Error: Cannot find module 'nanocurrency-web'`, which is what these checks
 * catch.
 *
 * No network, no funds, no RPC: `new` and `address` are pure key derivation.
 */
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { tools, wallet } = require('nanocurrency-web');

const SCRIPT = path.join(__dirname, '..', 'nano-pay.cjs');
const ROOT = path.join(__dirname, '..');
const { readFileSync, readdirSync } = require('node:fs');
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');
/** Every document in this repository that an agent or its owner reads before paying. */
const DOCS = [
  'README.md',
  'SKILL.md',
  'hermes-pr/optional-skills/blockchain/proof-agent/SKILL.md',
  'hermes-pr/PR_BODY.md',
];

/** The copy these checks exercise. Every other copy in the repository must equal it. */
const REFERENCE = read('nano-pay.cjs');
/** A fenced block or a file is a WHOLE copy of the script only if it carries both of these. */
const WHOLE_COPY_MARKERS = ["require('nanocurrency-web')", 'usage: nano-pay.cjs'];
const JS_FENCE_LANGS = new Set(['js', 'javascript', 'cjs', 'node']);

/** Every tracked-looking file in the repository, excluding what npm and git put there. */
function tree(dir = ROOT, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tree(full, out);
    else if (entry.isFile()) out.push(path.relative(ROOT, full));
  }
  return out;
}

/** The fenced code blocks of a markdown document, as `{lang, body}`. */
function fences(text) {
  const out = [];
  const pattern = /```(\w*)\r?\n([\s\S]*?)```/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    out.push({ lang: match[1].toLowerCase(), body: match[2] });
  }
  return out;
}

const isWholeCopy = (body) => WHOLE_COPY_MARKERS.every((marker) => body.includes(marker));

/**
 * Every copy of the payment script in the repository: files named `nano-pay.cjs`,
 * and whole copies embedded as JavaScript in a document. Derived from disk so a
 * new copy is covered without being named here.
 */
function scriptCopies() {
  const found = [];
  for (const relative of tree()) {
    if (path.basename(relative) === 'nano-pay.cjs') {
      found.push({ where: relative, body: read(relative) });
      continue;
    }
    if (!relative.endsWith('.md')) continue;
    for (const fence of fences(read(relative))) {
      if (JS_FENCE_LANGS.has(fence.lang) && isWholeCopy(fence.body)) {
        found.push({ where: `${relative} (inline \`\`\`js block)`, body: fence.body });
      }
    }
  }
  return found;
}

function run(args, env) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${error.message}`);
  }
}

check('`new` prints a usable seed and a checksum-valid Nano address', () => {
  const out = JSON.parse(run(['new']));
  assert.match(out.seed, /^[0-9a-fA-F]{64}$/, `seed is not 64 hex chars: ${out.seed}`);
  assert.ok(tools.validateAddress(out.address), `address fails its checksum: ${out.address}`);
  assert.match(out.address, /^nano_/, `address is not a nano_ address: ${out.address}`);
});

check('`address` re-derives exactly the address `new` printed', () => {
  const created = JSON.parse(run(['new']));
  const derived = run(['address'], { NANO_SEED: created.seed }).trim();
  assert.strictEqual(derived, created.address);
  // And the same seed through the library directly, so the script is not just
  // agreeing with itself.
  assert.strictEqual(wallet.fromLegacySeed(created.seed).accounts[0].address, created.address);
});

check('no command prints usage on stderr and exits 1', () => {
  try {
    run([]);
    assert.fail('expected a non-zero exit');
  } catch (error) {
    assert.strictEqual(error.status, 1);
    assert.match(String(error.stderr), /usage: nano-pay\.cjs/);
  }
});

check('a recipient whose checksum is wrong is refused before any work is done', () => {
  // `send` is the only command that moves real XNO, and `valid()` is its only
  // guard on the destination. `tools.addressToPublicKey` decodes an address but
  // does NOT verify Nano's checksum, so a typo, a truncation and a mangled
  // checksum all passed it; the refusal then came from `block.send` instead,
  // after `info`, a possible `receive` pass and up to 4 x 28s of work_generate.
  // Offline: every case below must be refused before the first RPC call, which
  // is why a bogus seed and no network are enough to run this.
  const seed = 'A'.repeat(64);
  const good = wallet.generateLegacy().accounts[0].address;
  const bad = {
    'one character changed': good.slice(0, 10) + (good[10] === 'a' ? 'b' : 'a') + good.slice(11),
    'truncated': good.slice(0, 50),
    'mangled checksum': good.slice(0, -8) + 'aaaaaaaa',
    'prefix plus filler': 'nano_' + '1'.repeat(60),
  };
  for (const [label, address] of Object.entries(bad)) {
    assert.ok(!tools.validateAddress(address), `test's own ${label} case is actually valid`);
    try {
      run(['send', address, '1'], { NANO_SEED: seed, NANO_RPC_URLS: 'http://127.0.0.1:1' });
      assert.fail(`${label}: expected a non-zero exit`);
    } catch (error) {
      assert.strictEqual(error.status, 1, `${label}: ${error.message}`);
      assert.match(
        String(error.stderr),
        /ERROR: invalid recipient/,
        `${label}: refused for the wrong reason (or too late) - ${String(error.stderr).trim()}`,
      );
    }
  }
  // And the guard still admits a well-formed address: it gets past `valid()` and
  // fails on the unreachable RPC instead, which is the next step in `send`.
  try {
    run(['send', good, '1'], { NANO_SEED: seed, NANO_RPC_URLS: 'http://127.0.0.1:1' });
    assert.fail('expected a non-zero exit');
  } catch (error) {
    assert.doesNotMatch(String(error.stderr), /invalid recipient/, 'a valid address was refused');
  }
});

check('no document promises a spend cap, because `send` has none', () => {
  // README.md and SKILL.md both told an agent that "budget is a hard cap - the
  // agent sends the exact listed priceRaw, nothing more". There is no budget, no
  // cap and no maximum anywhere in this repository: `send`'s only refusals are an
  // invalid recipient, a non-positive amount, and more than the wallet holds. The
  // amount comes from `POST /api/order`, which is the server's number, not the
  // `priceXno` the agent vetted in the step before - and nothing compared the two.
  //
  // Measured 2026-10-04 against a real unfunded wallet and the public RPC:
  //   node nano-pay.cjs send <valid address> 1000000000000000000000000000000000000
  //   ERROR: account unopened / no funds        <- the BALANCE refused it, not a cap
  // A skill whose own Safety section says it makes an agent "hold a key and send
  // real money" must not promise a bound it does not have.
  const seed = 'A'.repeat(64);
  const good = wallet.generateLegacy().accounts[0].address;
  const ABSURD = '1' + '0'.repeat(36); // 10^36 raw = a million XNO

  // 1. The script really has no upper bound. Offline, with the RPC unreachable, an
  //    absurd amount must get PAST the argument checks and die on the network --
  //    if a cap existed it would refuse here, before any RPC call.
  try {
    run(['send', good, ABSURD], { NANO_SEED: seed, NANO_RPC_URLS: 'http://127.0.0.1:1' });
    assert.fail('expected a non-zero exit');
  } catch (error) {
    const err = String(error.stderr);
    assert.doesNotMatch(err, /invalid recipient|amount must be/, `refused before the RPC: ${err.trim()}`);
    assert.match(err, /ERROR:/, `expected an error from the unreachable RPC, got: ${err.trim()}`);
  }
  // 2. And no identifier in the script implements one, so claim 3 below cannot be
  //    satisfied by a cap this test failed to notice.
  assert.doesNotMatch(
    read('nano-pay.cjs'),
    /\b(budget|maxRaw|maxAmount|spendCap|MAX_RAW|MAX_XNO)\b/,
    'nano-pay.cjs now has a cap mechanism - update this law instead of deleting it',
  );

  // 3. So no document may promise one.
  for (const file of DOCS) {
    const text = read(file);
    assert.doesNotMatch(text, /hard cap/i, `${file} promises a "hard cap" that nano-pay.cjs does not implement`);
    assert.doesNotMatch(text, /nothing more/i, `${file} promises the agent sends "nothing more", which nothing enforces`);
  }

  // 4. And the buy flow must carry the one check that makes a cap real: the agent
  //    is the only actor that knows what it vetted, so it must compare the
  //    server's priceRaw against that before paying.
  const skill = read('SKILL.md');
  const buy = skill.slice(skill.indexOf('## 5) Buy an idea'));
  assert.ok(buy.length > 0, 'SKILL.md no longer has a "Buy an idea" section');
  assert.match(buy, /priceRaw/, 'the buy flow no longer mentions priceRaw');
  assert.match(
    buy,
    /10\s*\\?\*\\?\*\s*30|10\s*\^\s*30/,
    'the buy flow must state the raw conversion (1 XNO = 10^30 raw) so the agent can compare the two prices',
  );
  assert.match(
    buy,
    /refuse|do not pay|stop/i,
    'the buy flow must tell the agent to refuse a priceRaw above what it vetted',
  );
});

check('every copy of the payment script in this repository is byte-identical to the one these checks run', () => {
  // These checks exercise ONE copy, `nano-pay.cjs`, and it is not the only copy an
  // agent can end up running. README.md promises "The same script is embedded
  // inline in `SKILL.md` so a single fetch gives an agent everything it needs",
  // and `hermes-pr/` carries a third copy as the payload of an outside pull
  // request. On 2026-10-04 all three were byte-identical and NOTHING held them
  // that way: no test, no linter and no type sees a drift between a file and a
  // fenced block in a document. A copy that drifts is a script that signs and
  // sends real XNO and that nothing here has ever run.
  //
  // The rule is derived from disk, so a fourth copy added anywhere is covered
  // without being named: every file called `nano-pay.cjs`, and every fenced
  // JavaScript block in any document that is a WHOLE copy of the script, must
  // equal the root script byte for byte.
  const copies = scriptCopies();

  // The excerpt/copy discriminator is load-bearing, and it is pinned here rather
  // than left to depend on what the repository happens to quote today: an audit
  // note that quotes the script's opening lines in a ```js block must NOT be held
  // to byte-identity with the whole file. `audits/proof-agent-skill-2026-10-03.md`
  // already quotes `valid()` that way. The fixture is assembled from fragments so
  // that spelling it out does not plant a copy of the markers in a file this law
  // scans.
  const EXCERPT =
    'const { wallet, block, tools } = require(' + "'nanocurrency-web');\n" +
    "const RPC_URLS = (process.env.NANO_RPC_URLS || '...').split(',');\n";
  assert.ok(
    !isWholeCopy(EXCERPT),
    'an excerpt that merely requires the wallet library must not count as a whole copy of the script - ' +
      'otherwise this law demands byte-identity from every quotation of two lines',
  );
  assert.ok(isWholeCopy(REFERENCE), 'nano-pay.cjs itself must count as a whole copy');
  // Both markers guard a reachable false-positive direction, so both are pinned:
  // a document that quotes only the usage banner is as much an excerpt as one that
  // quotes only the require, and neither may be held to byte-identity.
  const USAGE_ONLY_EXCERPT =
    "  console.error('usage: nano-pay" + ".cjs new | address | balance');\n";
  assert.ok(
    !isWholeCopy(USAGE_ONLY_EXCERPT),
    'a quotation of the usage banner alone must not count as a whole copy of the script',
  );

  // The rule itself. A failure names the first line that differs, so a reader can
  // tell a drifted copy from a law that has gone wrong on its own.
  for (const { where, body } of copies) {
    if (body === REFERENCE) continue;
    const reference = REFERENCE.split('\n');
    const actual = body.split('\n');
    let line = 0;
    while (line < reference.length && line < actual.length && reference[line] === actual[line]) line += 1;
    assert.fail(
      `${where} is not byte-identical to nano-pay.cjs - first difference at line ${line + 1}:\n` +
        `     nano-pay.cjs: ${JSON.stringify(reference[line])}\n` +
        `     ${where}: ${JSON.stringify(actual[line])}\n` +
        `     An agent that follows README.md or installs the hermes-pr bundle runs THAT copy, ` +
        `and no check in this repository has run it. Copy nano-pay.cjs over it.`,
    );
  }

  // And the law must not pass by finding nothing. SKILL.md carries exactly one
  // copy because README.md says a single fetch of it is enough; the hermes-pr
  // bundle carries exactly one because that is what the pull request installs.
  // If a drift ever makes a copy unrecognisable, these two counts catch it rather
  // than the law going quiet.
  const inSkill = copies.filter((c) => c.where === 'SKILL.md (inline ```js block)');
  assert.strictEqual(
    inSkill.length,
    1,
    `SKILL.md must embed exactly one whole copy of nano-pay.cjs (README.md promises "the same script is ` +
      `embedded inline in SKILL.md"), found ${inSkill.length} - either the promise is now false, or the ` +
      `inline copy drifted so far this law no longer recognises it`,
  );
  const inHermes = copies.filter((c) => c.where.startsWith('hermes-pr/'));
  assert.strictEqual(
    inHermes.length,
    1,
    `the hermes-pr bundle must carry exactly one copy of nano-pay.cjs, found ${inHermes.length}`,
  );
  // Three today, and the assertion is >= so adding a copy is not a failure - only
  // a drifting or vanishing one is.
  assert.ok(copies.length >= 3, `expected at least 3 copies of the script, found ${copies.length}`);
});

process.exit(failed === 0 ? 0 : 1);
