import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorSession } from '../public/editor-session.js';

function form() {
  return { id: 'example', draftVersion: 1, draft: { title: 'Исходный текст', fields: [] } };
}

test('a late save response preserves newer edits and keeps them marked unsaved', async () => {
  const editor = new EditorSession(form());
  editor.changed();
  let complete;
  const pending = editor.save(async (path, method, body) => {
    assert.equal(body.draftVersion, 1);
    const snapshot = structuredClone(body);
    delete snapshot.draftVersion;
    return new Promise(resolve => { complete = () => resolve({ draft: snapshot, draftVersion: 2 }); });
  });
  editor.form.draft.title = 'Напечатано после нажатия';
  editor.changed();
  complete();
  assert.equal(await pending, false);
  assert.equal(editor.form.draft.title, 'Напечатано после нажатия');
  assert.equal(editor.form.draftVersion, 2);
  assert.equal(editor.dirty, true);
});

test('failed save keeps local text and version; successful retry marks it saved', async () => {
  const editor = new EditorSession(form());
  editor.form.draft.title = 'Мои изменения';
  editor.changed();
  await assert.rejects(editor.save(async () => { throw new Error('Сеть недоступна'); }));
  assert.equal(editor.form.draft.title, 'Мои изменения');
  assert.equal(editor.form.draftVersion, 1);
  assert.equal(editor.dirty, true);
  assert.equal(await editor.save(async (path, method, body) => ({ draft: { title: body.title, fields: [] }, draftVersion: 2 })), true);
  assert.equal(editor.dirty, false);
  assert.equal(editor.form.draft.title, 'Мои изменения');
});
