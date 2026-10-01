// Offline checks for nano-pay.cjs: that it runs at all from a clean install, that
// its recipient guard really refuses an address that is not a Nano address, and
// that XNO -> raw stays exact integer arithmetic.
//
// Nothing here touches the network and nothing here needs a seed or funds.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'nano-pay.cjs');
const { valid, xnoToRaw } = require(SCRIPT);

// A real, well-formed mainnet address (the default representative the script
// itself uses) and three things that are not one. No keys, no funds: an address
// is public, and none of these is ever paid here.
const GOOD = 'nano_3arg3asgtigae3xckabaaewkx3bzsh7nwz7jkmjos79ihyaxwphhm6qgjps4';
const XRB = 'xrb_' + GOOD.slice(5);
const WRONG_CHECKSUM = GOOD.slice(0, 10) + 'b' + GOOD.slice(11);
const WRONG_LAST_CHAR = GOOD.slice(0, -1) + (GOOD.slice(-1) === '4' ? '5' : '4');
const TRUNCATED = 'nano_3abc';

const checks = [];
function check(name, fn) {
  try { fn(); checks.push([true, name]); }
  catch (e) { checks.push([false, name + ' -- ' + e.message]); }
}

// 1. The one thing every agent does first: run the helper. Without a manifest
//    declaring nanocurrency-web, a clean clone dies in require() before the CLI
//    is reached at all.
check('the helper loads its dependency and prints its usage', () => {
  let r;
  try {
    execFileSync('node', [SCRIPT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    r = { code: 0, stderr: '' };
  } catch (e) {
    r = { code: e.status, stderr: e.stderr || '' };
  }
  assert.strictEqual(r.code, 1, 'no command should exit 1, got ' + r.code);
  assert.ok(!/MODULE_NOT_FOUND|Cannot find module/.test(r.stderr),
    'nanocurrency-web did not resolve: ' + r.stderr.split('\n')[0]);
  assert.ok(/usage: nano-pay\.cjs/.test(r.stderr), 'no usage line: ' + r.stderr.split('\n')[0]);
});

// 2. The guard has to accept a real address, in both spellings of it: refusing a
//    good recipient costs the agent the purchase.
check('a real address is accepted, in both the nano_ and the xrb_ spelling', () => {
  assert.strictEqual(valid(GOOD), true, 'the nano_ spelling was refused');
  assert.strictEqual(valid(XRB), true, 'the xrb_ spelling was refused');
});

// 3. And it has to refuse what is not one. All three of these decode to
//    *something* through tools.addressToPublicKey, which checks neither the
//    checksum nor the length, so a guard built on that lets them through to the
//    node - and send() then calls receive(), publishing real blocks and grinding
//    real proof-of-work, for a payment that can never go out.
check('a wrong checksum is refused', () => {
  assert.strictEqual(valid(WRONG_CHECKSUM), false, 'a body character was changed and it still passed');
});
check('a wrong checksum digit is refused', () => {
  assert.strictEqual(valid(WRONG_LAST_CHAR), false, 'the checksum was changed and it still passed');
});
check('a truncated address is refused', () => {
  assert.strictEqual(valid(TRUNCATED), false, "'" + TRUNCATED + "' is not 60 characters and still passed");
});

// 4. Nothing that is not an address gets as far as being compared.
check('an empty body, junk, and a non-string are all refused', () => {
  for (const bad of ['nano_', 'nano_!!!!', 'nano_' + 'a'.repeat(60), '', null, undefined, 5, {}]) {
    assert.strictEqual(valid(bad), false, JSON.stringify(bad) + ' passed the guard');
  }
});

// 5. Raw is an integer: 1 XNO = 10**30 raw, and there is no float on this path to
//    lose the low digits of an amount an owner is asked to fund.
check('XNO converts to raw exactly, to the last digit', () => {
  assert.strictEqual(xnoToRaw('1'), '1000000000000000000000000000000');
  assert.strictEqual(xnoToRaw('0.000001'), '1000000000000000000000000');
  assert.strictEqual(xnoToRaw('0.000000000000000000000000000001'), '1');
  assert.strictEqual(xnoToRaw('133248.123456789012345678901234567891'),
    '133248123456789012345678901234567891');
  assert.strictEqual(xnoToRaw('0.1'), '100000000000000000000000000000');
});

// 6. The three copies of the script -- this file, the one embedded in SKILL.md and
//    the one under hermes-pr/ -- must not drift apart: an agent that installs the
//    skill gets the SKILL.md copy, not this file.
check('the three copies of the script agree', () => {
  const file = fs.readFileSync(SCRIPT, 'utf8');
  const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  const hermes = fs.readFileSync(path.join(__dirname, '..', 'hermes-pr', 'optional-skills',
    'blockchain', 'proof-agent', 'scripts', 'nano-pay.cjs'), 'utf8');
  assert.strictEqual(hermes, file, 'the hermes-pr/ copy differs from nano-pay.cjs');
  assert.ok(skill.includes(file.trimEnd()), 'the copy embedded in SKILL.md differs from nano-pay.cjs');
});

let failed = 0;
for (const [ok, name] of checks) {
  console.log((ok ? '[pass] ' : '[FAIL] ') + name);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks pass`);
process.exit(failed ? 1 : 0);
