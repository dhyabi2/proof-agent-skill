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

process.exit(failed === 0 ? 0 : 1);
