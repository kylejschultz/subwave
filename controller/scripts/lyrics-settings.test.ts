// settings.lyrics.enabled — the operator's switch for the listener Lyrics panel.
// A new settings field needs DEFAULTS, the update() branch AND a line in
// load()'s composition; one missing from load() still saves and works until
// the next restart, then silently reverts. So the switch is pinned through a
// cold load, not only in-process.
//
// Run: `npm test -- lyrics-settings`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir } from './test-utils/temp-dir.js';
import { coldLoadSettings } from './test-utils/settings.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-lyrics-settings-'));

const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { validateSettingsPatch } = await import('../src/settings/patch-registry.js');

test('absent or malformed loads as off, the behaviour before the panel existed', async () => {
  assert.equal((await coldLoadSettings({})).lyrics.enabled, false);
  assert.equal((await coldLoadSettings({ lyrics: null })).lyrics.enabled, false);
  assert.equal((await coldLoadSettings({ lyrics: { enabled: 'yes' } })).lyrics.enabled, false);
  assert.equal((await coldLoadSettings({ lyrics: { enabled: true } })).lyrics.enabled, true);
});

test('a save survives a cold load, both ways', async () => {
  await coldLoadSettings({});
  await settings.update({ lyrics: { enabled: true } } as never);
  setCache(null);
  await settings.load();
  assert.equal(settings.get().lyrics.enabled, true);

  await settings.update({ lyrics: { enabled: false } } as never);
  setCache(null);
  await settings.load();
  assert.equal(settings.get().lyrics.enabled, false);
});

test('the route accepts the key, and a patch without it leaves the switch alone', async () => {
  assert.equal(validateSettingsPatch({ lyrics: { enabled: true } }), null);
  await settings.update({ lyrics: { enabled: true } } as never);
  await settings.update({ likes: { enabled: false } } as never);
  assert.equal(settings.get().lyrics.enabled, true);
});
