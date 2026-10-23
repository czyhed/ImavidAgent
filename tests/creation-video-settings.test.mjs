import test from 'node:test';
import assert from 'node:assert/strict';
import { checkVideoSettings, normalizeVideoSettings, effectiveVideoParams, customVideoKeys, SETTING_DEFAULTS } from '../shared/creation-video-settings.mjs';

test('checkVideoSettings accepts valid keys, treats empty as none and rejects everything else', () => {
  assert.deepEqual(checkVideoSettings({ resolution: '1080P', ratio: '16:9', duration: 10 }).settings, { resolution: '1080P', ratio: '16:9', duration: 10 });
  assert.equal(checkVideoSettings(undefined).settings, null);
  assert.equal(checkVideoSettings({}).settings, null);
  assert.deepEqual(checkVideoSettings({ resolution: null, duration: 5 }).settings, { duration: 5 });
  for (const bad of [{ resolution: '720P' }, { ratio: 'adaptive' }, { duration: 3 }, { duration: 31 }, { duration: '5' }, { speed: 1 }, 'x', []]) assert.ok(checkVideoSettings(bad).error, JSON.stringify(bad));
});

test('normalizeVideoSettings drops invalid stored keys instead of throwing', () => {
  assert.deepEqual(normalizeVideoSettings({ resolution: '480P', ratio: 'bad', duration: 99, extra: 1 }), { resolution: '480P' });
  assert.equal(normalizeVideoSettings(null), null);
  assert.equal(normalizeVideoSettings({ ratio: 'bad' }), null);
});

test('effectiveVideoParams: no settings leaves node params untouched; settings fill the gaps under explicit values', () => {
  assert.deepEqual(effectiveVideoParams(null, { duration: 6 }), { duration: 6 });
  assert.deepEqual(effectiveVideoParams(undefined, { aspectRatio: '1:1' }), { ratio: '1:1' }, 'aliases are normalized');
  assert.deepEqual(effectiveVideoParams({ resolution: '480P' }, {}), { ...SETTING_DEFAULTS, resolution: '480P' });
  assert.deepEqual(effectiveVideoParams({ resolution: '480P', duration: 8 }, { duration: 6, mute_audio: true }), { resolution: '480P', ratio: '9:16', duration: 6, mute_audio: true });
  assert.deepEqual(effectiveVideoParams({ ratio: '1:1' }, { ratio: undefined }), { ...SETTING_DEFAULTS, ratio: '1:1' });
});

test('customVideoKeys: only explicit values that differ from the inherited value count', () => {
  assert.deepEqual(customVideoKeys(null, { duration: 5, resolution: '768P', ratio: '9:16' }), [], 'equal to the V-04 defaults');
  assert.deepEqual(customVideoKeys(null, { duration: 6, resolution: '480P' }), ['resolution', 'duration']);
  assert.deepEqual(customVideoKeys({ resolution: '480P', duration: 6 }, { duration: 6, resolution: '768P' }), ['resolution']);
  assert.deepEqual(customVideoKeys({ resolution: '480P' }, {}), []);
});
