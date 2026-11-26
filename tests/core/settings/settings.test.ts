import { describe, expect, it } from 'vitest';

import { applySetting, fingerprint, isAllowedSetting, pasteSnippet } from '../../../plugin/core/settings/settings';

describe('settings lever', () => {
  it('allows only known keys with their own values', () => {
    expect(isAllowedSetting({ key: 'promptCacheTtl', value: '1h' })).toBe(true);
    expect(isAllowedSetting({ key: 'subagentPromptCacheTtl', value: '5m' })).toBe(true);
    expect(isAllowedSetting({ key: 'idleCompaction', value: false })).toBe(true);
    expect(isAllowedSetting({ key: 'promptCacheTtl', value: '2h' })).toBe(false);
    expect(isAllowedSetting({ key: 'model', value: 'opus' })).toBe(false);
  });

  it('merges one key, keeping the others in order', () => {
    const before = '{\n  "theme": "dark",\n  "promptCacheTtl": "5m",\n  "env": { "A": "1" }\n}\n';
    const r = applySetting(before, { key: 'promptCacheTtl', value: '1h' });
    expect(r).toEqual({ ok: true, text: '{\n  "theme": "dark",\n  "promptCacheTtl": "1h",\n  "env": {\n    "A": "1"\n  }\n}\n' });
  });

  it('creates the file content when there is none, or it is blank', () => {
    expect(applySetting(null, { key: 'idleCompaction', value: false })).toEqual({ ok: true, text: '{\n  "idleCompaction": false\n}\n' });
    expect(applySetting('  \n', { key: 'promptCacheTtl', value: '1h' })).toEqual({ ok: true, text: '{\n  "promptCacheTtl": "1h"\n}\n' });
  });

  it('refuses to rewrite a file it cannot read faithfully', () => {
    expect(applySetting('{ // comment\n "a": 1 }', { key: 'promptCacheTtl', value: '1h' })).toEqual({ ok: false, reason: 'unparseable' });
    expect(applySetting('[1, 2]', { key: 'promptCacheTtl', value: '1h' })).toEqual({ ok: false, reason: 'not-object' });
    expect(applySetting('"text"', { key: 'promptCacheTtl', value: '1h' })).toEqual({ ok: false, reason: 'not-object' });
  });

  it('fingerprints tell a changed file from the shown one', () => {
    expect(fingerprint(null)).toBe('none');
    expect(fingerprint('{}')).toBe(fingerprint('{}'));
    expect(fingerprint('{}')).not.toBe(fingerprint('{ }'));
    expect(fingerprint('{"a":1}')).not.toBe(fingerprint('{"a":2}'));
  });

  it('gives a one-line snippet to paste', () => {
    expect(pasteSnippet({ key: 'promptCacheTtl', value: '1h' })).toBe('{"promptCacheTtl":"1h"}');
  });
});
