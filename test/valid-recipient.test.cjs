// The recipient guard in nano-pay.cjs `send()`.
//
// `send()` opens with `if(!valid(to))throw new Error('invalid recipient')` so a
// malformed Nano address is refused BEFORE the script touches the network. The
// guard used to read `tools.addressToPublicKey(a) !== null`, which is not a
// validity check: that function never returns null and never throws for bad
// input -- it decoded 'nano_1' to the empty public key, 'nano_zzz...' to
// all-ff, and a one-character payload typo to a different, perfectly
// well-formed public key, all as `true`. `send()` then went on to read the
// account, publish receive blocks on chain and generate send proof-of-work
// before dying inside the library with "Invalid toAddress".
//
// These run the shipped script as a subprocess with RPC pointed at a closed
// local port, so a recipient that gets past the guard fails with an RPC error
// instead. Asserting on which error comes out is therefore an assertion about
// the guard, and needs no network.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'nano-pay.cjs');
const SEED = 'a'.repeat(64);
const AMOUNT = '1000000000000000000000000000'; // 0.001 XNO in raw
const GOOD = 'nano_3arg3asgtigae3xckabaaewkx3bzsh7nwz7jkmjos79ihyaxwphhm6qgjps4';

function sendTo(address) {
  try {
    execFileSync(process.execPath, [SCRIPT, 'send', address, AMOUNT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NANO_SEED: SEED,
        // A port nothing listens on: no RPC call can succeed from here.
        NANO_RPC_URLS: 'http://127.0.0.1:1',
        no_proxy: '127.0.0.1,localhost',
        NO_PROXY: '127.0.0.1,localhost',
      },
    });
    return { code: 0, stderr: '' };
  } catch (error) {
    return { code: error.status, stderr: String(error.stderr ?? '') };
  }
}

const malformed = {
  'a one-character payload typo (checksum no longer matches)':
    'nano_3brg3asgtigae3xckabaaewkx3bzsh7nwz7jkmjos79ihyaxwphhm6qgjps4',
  'a one-character checksum typo':
    `${GOOD.slice(0, -1)}5`,
  'far too short': 'nano_1',
  'right length, not a Nano address': `nano_${'z'.repeat(60)}`,
};

for (const [what, address] of Object.entries(malformed)) {
  test(`send refuses ${what} before any network call`, () => {
    const { code, stderr } = sendTo(address);
    assert.notStrictEqual(code, 0, 'send must fail for a malformed recipient');
    assert.match(
      stderr,
      /ERROR: invalid recipient/,
      `expected the recipient guard to reject it, got: ${stderr.trim()}`,
    );
  });
}

test('send accepts a well-formed address and gets as far as the RPC', () => {
  // The guard must not have become over-strict: a real address passes it and
  // the run then fails on the unreachable RPC, not on the recipient.
  const { code, stderr } = sendTo(GOOD);
  assert.notStrictEqual(code, 0, 'no RPC is reachable in this test, so send fails');
  assert.doesNotMatch(stderr, /invalid recipient/, `a valid address was rejected: ${stderr.trim()}`);
});

test('xrb_ addresses are still accepted', () => {
  const { stderr } = sendTo(`xrb_${GOOD.slice(5)}`);
  assert.doesNotMatch(stderr, /invalid recipient/, `an xrb_ address was rejected: ${stderr.trim()}`);
});
