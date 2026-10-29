import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';

test('a failed disk write preserves saved state and the next transaction can recover', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forma-write-failure-'));
  const filename = join(directory, 'forms.json');
  try {
    const store = await createStore(filename);
    await store.update(state => { state.forms.push({ id: 'original' }); });
    const before = await readFile(filename, 'utf8');
    // A directory at the temporary-file path causes a real filesystem failure.
    await mkdir(`${filename}.tmp`);
    await assert.rejects(store.update(state => { state.forms.push({ id: 'must-not-be-saved' }); }));
    assert.equal(store.read().forms.length, 1);
    assert.equal(await readFile(filename, 'utf8'), before);
    await rm(`${filename}.tmp`, { recursive: true });
    await store.update(state => { state.forms.push({ id: 'recovered' }); });
    assert.deepEqual(store.read().forms.map(form => form.id), ['original', 'recovered']);
    const reopened = await createStore(filename);
    assert.deepEqual(reopened.read().forms.map(form => form.id), ['original', 'recovered']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
