import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../../../plugin/core/gate/sha256';

describe('sha256Hex', () => {
  it('matches the FIPS 180-2 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('agrees with Node for padding edges, multibyte text, surrogates and long prompts', () => {
    const cases = [
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(63),
      'a'.repeat(64),
      'a'.repeat(119),
      'café · ≈ $6.50 → /compact',
      'emoji 🧭 and 𝔘𝔫𝔦𝔠𝔬𝔡𝔢',
      'lone \ud800 surrogate',
      'x'.repeat(200_000),
    ];
    for (const text of cases) expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
  });
});
