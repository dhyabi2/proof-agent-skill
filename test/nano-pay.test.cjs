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

check('`fund` refuses an amount that is not a decimal number, before any RPC call', () => {
  // `fund` prints the `nano:` URI the agent's OWNER opens to fund it - step 2 of
  // both README.md and SKILL.md, and the only way the agent gets XNO at all.
  // `xnoToRaw` validated nothing, so `String(x).split('.')` quietly made an
  // amount out of anything BigInt would swallow:
  //
  //   "-5"     -> -5000000000000000000000000000000   a NEGATIVE amount in the URI
  //   "1.2.3"  ->  1200000000000000000000000000000   silently 1.2, while the
  //                                                  `message` field in the same
  //                                                  output still said "about
  //                                                  1.2.3 XNO"
  //   "."      ->  0                                 a URI asking for nothing
  //   "+3"     ->  3000000000000000000000000000000   not a decimal number
  //
  // The URI and the human message disagreeing in one JSON object is the whole
  // defect: the owner reads one number and their wallet shows another.
  //
  // `fund` also used to call `info()` - a live RPC - BEFORE parsing its
  // argument, so a bad amount cost a network round trip and could not be
  // reached offline at all. The parse now happens first, which is what lets
  // this check run with no network.
  const seed = 'A'.repeat(64);
  const offline = { NANO_SEED: seed, NANO_RPC_URLS: 'http://127.0.0.1:1' };
  for (const amount of ['-5', '1.2.3', '.', '+3', '1e3', 'abc', '٥', '1_0']) {
    try {
      run(['fund', amount], offline);
      assert.fail(`fund ${JSON.stringify(amount)}: expected a non-zero exit`);
    } catch (error) {
      assert.strictEqual(error.status, 1, `fund ${JSON.stringify(amount)}: ${error.message}`);
      assert.match(
        String(error.stderr),
        /ERROR: amount must be a decimal number of XNO/,
        `fund ${JSON.stringify(amount)}: refused for the wrong reason (or too late) - ${String(error.stderr).trim()}`,
      );
    }
  }
  // The control: every decimal spelling `fund` accepted before is still
  // accepted, so this refusal has narrowed nothing real. These get past the
  // parse and then fail on the unreachable RPC, which is how we know the parse
  // let them through.
  for (const amount of ['1', '1.5', '.5', '1.', '0.0000001', '133248.297', '  2  ']) {
    try {
      run(['fund', amount], offline);
      assert.fail(`fund ${JSON.stringify(amount)}: expected the RPC to be the thing that fails`);
    } catch (error) {
      assert.doesNotMatch(
        String(error.stderr),
        /amount must be a decimal number/,
        `fund ${JSON.stringify(amount)} is a real amount and must not be refused`,
      );
    }
  }
});

check('`fund` refuses an amount it cannot put in the URI exactly, before any RPC call', () => {
  // `xnoToRaw` padded the fraction to 30 digits and then cut it to 30, so
  // `fund 1.0000000000000000000000000000009` printed a URI for exactly 1 XNO
  // while `message` said "about 1.0000000000000000000000000000009 XNO" - the URI
  // and the message disagreeing again, one digit past the smallest unit. `fund 0`
  // printed `?amount=0`, a URI asking for nothing, and nothing stopped an amount
  // larger than every XNO that exists. Each is now refused, with no URI.
  const seed = 'A'.repeat(64);
  const offline = { NANO_SEED: seed, NANO_RPC_URLS: 'http://127.0.0.1:1' };
  const refused = [
    ['1.0000000000000000000000000000009', /ERROR: amount has more than 30 decimal places/],
    ['0.0000000000000000000000000000001', /ERROR: amount has more than 30 decimal places/],
    ['0', /ERROR: amount must be greater than 0 XNO/],
    ['0.000', /ERROR: amount must be greater than 0 XNO/],
    ['.0', /ERROR: amount must be greater than 0 XNO/],
    ['133248297.920938463463374607431768211456', /ERROR: amount is more than the total XNO supply/],
    ['133248298', /ERROR: amount is more than the total XNO supply/],
  ];
  for (const [amount, reason] of refused) {
    try {
      const out = run(['fund', amount], offline);
      assert.fail(`fund ${JSON.stringify(amount)}: expected a non-zero exit, got ${String(out).trim()}`);
    } catch (error) {
      assert.strictEqual(error.status, 1, `fund ${JSON.stringify(amount)}: ${error.message}`);
      assert.match(String(error.stderr), reason, `fund ${JSON.stringify(amount)}: ${String(error.stderr).trim()}`);
      assert.doesNotMatch(String(error.stdout), /nano:/, `fund ${JSON.stringify(amount)} must print no URI`);
    }
  }
  // The edges that ARE exact still get past the parse (and fail on the RPC).
  for (const amount of ['0.000000000000000000000000000001', '1.000000000000000000000000000000', '133248297.920938463463374607431768211455']) {
    try {
      run(['fund', amount], offline);
      assert.fail(`fund ${JSON.stringify(amount)}: expected the RPC to be the thing that fails`);
    } catch (error) {
      assert.doesNotMatch(String(error.stderr), /ERROR: amount/, `fund ${JSON.stringify(amount)} is exact and must not be refused`);
    }
  }
});

check('`fund` accepts an exact amount written with trailing zeros, and bounds the text it echoes back', () => {
  // The refusal of "more than 30 decimal places" first counted digits, so an
  // EXACT amount padded with zeros - `1.0000000000000000000000000000000`, 31
  // places - was refused although it names exactly 1 XNO. Only a nonzero digit
  // past the 30th place is more precision than 1 raw. And the refusal quoted the
  // trimmed text, so whitespace showed as `(got "")` and a 100k-digit argument
  // was echoed whole onto stderr.
  //
  // The URI is printed only after a live RPC call, so the exact raw value is read
  // from the parse itself, lifted out of the reference copy.
  const start = REFERENCE.indexOf('const RAW = ');
  const end = REFERENCE.indexOf('return r.toString(); }', start) + 'return r.toString(); }'.length;
  assert.ok(start >= 0 && end > start, 'could not find xnoToRaw in nano-pay.cjs');
  const xnoToRaw = new Function(`${REFERENCE.slice(start, end)}\nreturn xnoToRaw;`)();
  const exact = [
    ['1.0000000000000000000000000000000', '1000000000000000000000000000000'],
    ['0.100000000000000000000000000000000000', '100000000000000000000000000000'],
    ['133248297.9209384634633746074317682114550', '133248297920938463463374607431768211455'],
    ['0.0000000000000000000000000000010000', '1'],
  ];
  for (const [amount, raw] of exact) {
    assert.strictEqual(xnoToRaw(amount), raw, `xnoToRaw(${JSON.stringify(amount)})`);
  }

  const seed = 'A'.repeat(64);
  const offline = { NANO_SEED: seed, NANO_RPC_URLS: 'http://127.0.0.1:1' };
  for (const [amount] of exact) {
    try {
      run(['fund', amount], offline);
      assert.fail(`fund ${JSON.stringify(amount)}: expected the RPC to be the thing that fails`);
    } catch (error) {
      assert.doesNotMatch(String(error.stderr), /ERROR: amount/, `fund ${JSON.stringify(amount)} is exact and must not be refused`);
    }
  }

  // Zeros past the 30th place add no precision, so an all-zero amount is zero.
  for (const amount of ['0.0000000000000000000000000000000000000000', '.' + '0'.repeat(31)]) {
    try {
      run(['fund', amount], offline);
      assert.fail(`fund ${JSON.stringify(amount)}: expected a non-zero exit`);
    } catch (error) {
      assert.strictEqual(error.status, 1, `fund ${JSON.stringify(amount)}: ${error.message}`);
      assert.match(String(error.stderr), /ERROR: amount must be greater than 0 XNO/, `fund ${JSON.stringify(amount)}: ${String(error.stderr).trim()}`);
      assert.doesNotMatch(String(error.stdout), /nano:/, `fund ${JSON.stringify(amount)} must print no URI`);
    }
  }

  // The refusal quotes what was passed, and no more than about 80 characters of it.
  const echoes = [
    ['   ', /\(got "   "\)/],
    ['9'.repeat(100000), /\(got "9{77}\.\.\."\)/],
    ['1.' + '0'.repeat(30) + '1' + '7'.repeat(5000), /\(got "1\.0{30}17{44}\.\.\."\)/],
  ];
  for (const [amount, quoted] of echoes) {
    try {
      run(['fund', amount], offline);
      assert.fail(`fund (${amount.length} chars): expected a non-zero exit`);
    } catch (error) {
      const err = String(error.stderr);
      assert.strictEqual(error.status, 1, `fund (${amount.length} chars): ${error.message}`);
      assert.match(err, /ERROR: amount/, `fund (${amount.length} chars): ${err.slice(0, 200)}`);
      assert.match(err, quoted, `fund (${amount.length} chars) quoted the wrong text: ${err.slice(0, 300)}`);
      assert.ok(err.length < 400, `fund (${amount.length} chars) echoed ${err.length} bytes to stderr`);
    }
  }
});

check('`fund` reports an accepted amount in normalized form, so its output stays bounded', () => {
  // needXno and message used to repeat the argument as typed, so an EXACT amount
  // such as `1.<100000 zeros>` was accepted and echoed twice, about 200 KB on
  // stdout. Both now show the amount the URI asks for: the whole part with no
  // leading zeros and the fraction with no trailing zeros - at most 40 characters.
  // The URI itself is unchanged. A local mock RPC answers "Account not found" so
  // `fund` reaches its output offline; it runs in a child process because
  // execFileSync blocks this one.
  const driver = `
    const http = require('node:http');
    const { execFile } = require('node:child_process');
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end('{"error":"Account not found"}'); });
    });
    server.listen(0, '127.0.0.1', () => {
      const env = { ...process.env, NANO_SEED: 'A'.repeat(64), NANO_RPC_URLS: 'http://127.0.0.1:' + server.address().port };
      execFile(process.execPath, [process.argv[1], 'fund', process.argv[2]], { env, maxBuffer: 1 << 26 }, (error, stdout, stderr) => {
        server.close();
        process.stdout.write(JSON.stringify({ code: error ? error.code : 0, stdout, stderr }));
      });
    });`;
  const fund = (amount) => JSON.parse(execFileSync(process.execPath, ['-e', driver, SCRIPT, amount], { encoding: 'utf8', maxBuffer: 1 << 26 }));
  const SUPPLY = '133248297.920938463463374607431768211455';
  const cases = [
    ['1.' + '0'.repeat(100000), '1', '1000000000000000000000000000000'],
    ['007.50', '7.5', '7500000000000000000000000000000'],
    [' 2 ', '2', '2000000000000000000000000000000'],
    ['1.0000000000000000000000000000000', '1', '1000000000000000000000000000000'],
    ['.5', '0.5', '500000000000000000000000000000'],
    ['0.000000000000000000000000000001', '0.000000000000000000000000000001', '1'],
    [SUPPLY, SUPPLY, '133248297920938463463374607431768211455'],
  ];
  for (const [amount, shown, raw] of cases) {
    const label = amount.length > 40 ? `(${amount.length} chars)` : JSON.stringify(amount);
    const result = fund(amount);
    assert.strictEqual(result.code, 0, `fund ${label}: ${result.stderr.slice(0, 300)}`);
    assert.ok(result.stdout.length < 600, `fund ${label} printed ${result.stdout.length} bytes`);
    const out = JSON.parse(result.stdout);
    assert.strictEqual(out.needXno, shown, `fund ${label}: needXno`);
    assert.strictEqual(out.message, `Ask your owner to fund this address with about ${shown} XNO.`, `fund ${label}: message`);
    assert.strictEqual(out.uri, `nano:${out.address}?amount=${raw}`, `fund ${label}: uri`);
  }
  // With no amount, there is still no amount anywhere.
  const bare = JSON.parse(fund('').stdout);
  assert.strictEqual(bare.needXno, null);
  assert.strictEqual(bare.uri, `nano:${bare.address}`);
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

// The dependency an agent installs by hand must be the one these checks ran
// against. `package.json` pins nanocurrency-web to an exact version, and
// .github/workflows/ci.yml says in as many words that "Nothing is floating".
// But a clone is not the only way in: README.md and both SKILL.md files tell an
// agent copying the script on its own to `npm i nanocurrency-web@<spec>`, and
// the hermes-pr bundle carries that line to an outside maintainer. Those lines
// asked for a caret range, so the standalone and Hermes installs floated across
// 1.x while the clone and CI did not - on the library that derives the seed and
// signs every send block. (It resolves to the pinned version today only because
// no 1.4.4 has shipped; `latest` on the registry is already 2.0.0.)
//
// The expected version is read out of package.json, so bumping the pin needs no
// edit here - only the same bump in the documents.
check('every document installs the exact nanocurrency-web the suite ran against', () => {
  const pinned = JSON.parse(read('package.json')).dependencies['nanocurrency-web'];
  assert.ok(
    /^\d+\.\d+\.\d+$/.test(pinned),
    `package.json must pin nanocurrency-web to an exact version for this law to have a target, got ${JSON.stringify(pinned)}`,
  );
  let seen = 0;
  for (const doc of DOCS) {
    const body = read(doc);
    for (const [, spec] of body.matchAll(/nanocurrency-web@(\S*?)[`'"\s,)]/g)) {
      seen += 1;
      assert.strictEqual(
        spec,
        pinned,
        `${doc} tells the reader to install nanocurrency-web@${spec}, but package.json pins ` +
          `${pinned} and that is the only version this suite and CI ever run. An agent that ` +
          `copies the script on its own - which SKILL.md is written to be - would install a ` +
          `different build of the library that derives its seed and signs its sends. Ask for ` +
          `${pinned} exactly, or change the pin in package.json too.`,
      );
    }
  }
  // The law must not pass by matching nothing: SKILL.md's setup line is the one
  // an agent that fetched only that file reads.
  assert.ok(seen >= 2, `expected at least 2 documented install specs, found ${seen}`);
});

process.exit(failed === 0 ? 0 : 1);
