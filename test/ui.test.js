import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createApp } from '../server.js';

const files = ['api.js', 'editor-session.js', 'student-draft.js', 'app.js'];
// jsdom has no native module-script loader. Execute the actual module bodies in
// one window, removing only import/export declarations; no application logic is mocked.
const scripts = (await Promise.all(files.map(file => readFile(new URL(`../public/${file}`, import.meta.url), 'utf8'))))
  .map(source => source.replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '')).join('\n');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

async function until(condition, label) {
  for (let count = 0; count < 200; count++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Ожидание не завершилось: ${label}`);
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'forma-ui-'));
  const server = await createApp({ dataFile: join(directory, 'forms.json') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pages = [];
  t.after(async () => {
    for (const page of pages) page.window.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  async function request(path, method = 'GET', body) {
    const response = await fetch(origin + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  }
  function page(path, { intercept, storage = {}, blockedStorage = false } = {}) {
    const errors = [];
    const console = new VirtualConsole();
    console.on('jsdomError', error => {
      // Native navigation and modal rendering are outside jsdom's capabilities.
      if (!error.message.includes('Not implemented: navigation')) errors.push(error.message);
    });
    const dom = new JSDOM(html.replace('</head>', `<style>${css}</style></head>`), {
      url: origin + path, runScripts: 'outside-only', virtualConsole: console,
    });
    pages.push(dom);
    const w = dom.window;
    w.structuredClone = structuredClone;
    w.AbortController = AbortController;
    w.fetch = (path, options) => intercept ? intercept(path, options, () => fetch(origin + path, options)) : fetch(origin + path, options);
    for (const [key, value] of Object.entries(storage)) w.sessionStorage.setItem(key, value);
    if (blockedStorage) Object.defineProperty(w, 'sessionStorage', { get() { throw new Error('Storage blocked'); } });
    w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
    w.addEventListener('error', event => errors.push(event.error?.stack || event.message));
    w.eval(scripts);
    const d = w.document;
    return {
      w, d, errors,
      click(selector) { const control = d.querySelector(selector); assert.ok(control, selector); control.click(); },
      fill(selector, value) { const control = d.querySelector(selector); assert.ok(control, selector); control.value = value; control.dispatchEvent(new w.Event('input', { bubbles: true })); },
      check(selector) { const control = d.querySelector(selector); assert.ok(control, selector); control.checked = true; control.dispatchEvent(new w.Event('input', { bubbles: true })); },
      submit() { d.querySelector('#student-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); },
      async ready(selector) {
        try { await until(() => d.querySelector(selector), selector); }
        catch (error) { throw new Error(`${error.message}\n${d.querySelector('#app').textContent}\n${errors.join('\n')}`); }
      },
      storage() { return Object.fromEntries(Object.keys(w.sessionStorage).map(key => [key, w.sessionStorage.getItem(key)])); },
    };
  }
  return { request, page };
}

const definition = () => ({ title: 'Стажировка', description: 'Тест', fields: [
  { id: 'name', type: 'text', label: 'Имя', required: true },
  { id: 'email', type: 'email', label: 'Email', required: true },
  { id: 'about', type: 'textarea', label: 'О себе', required: false },
  { id: 'year', type: 'number', label: 'Курс', required: true },
  { id: 'track', type: 'select', label: 'Направление', required: true, options: ['Разработка', 'Дизайн'] },
  { id: 'format', type: 'radio', label: 'Формат', required: true, options: ['Удалённо', 'В офисе'] },
  { id: 'skills', type: 'checkbox', label: 'Навыки', required: true, options: ['JS', 'CSS'] },
] });
function fillStudent(page) {
  page.fill('[name="name"]', 'Анна <script>alert(1)</script>');
  page.fill('[name="email"]', 'anna@example.com');
  page.fill('[name="about"]', 'Хочу учиться');
  page.fill('[name="year"]', '3');
  page.fill('[name="track"]', 'Разработка');
  page.check('[name="format"][value="Удалённо"]');
  page.check('[name="skills"][value="JS"]');
}

test('UI: empty list, template creation, editing, question order and keyboard tabs', async t => {
  const f = await fixture(t);
  const home = f.page('/admin/forms');
  await home.ready('.empty-state');
  assert.equal(home.d.querySelector('.nav-item').getAttribute('href'), '/admin/forms');
  home.click('[data-action="new"]');
  assert.ok(home.d.querySelector('dialog').open);
  home.click('[data-template="internship"]');
  await until(async () => (await f.request('/api/forms')).length === 1, 'создание шаблона');
  const [form] = await f.request('/api/forms');
  const editor = f.page(`/admin/${form.id}`);
  await editor.ready('#builder');
  editor.click('[data-action="add-field"][data-type="checkbox"]');
  const added = editor.d.querySelectorAll('.question-card')[5].dataset.field;
  editor.fill(`#label-${added}`, 'Выберите навыки');
  editor.fill(`#options-${added}`, 'JS\nCSS');
  editor.click(`[data-action="move-up"][data-id="${added}"]`);
  assert.equal(editor.d.querySelectorAll('.question-card')[4].dataset.field, added);
  editor.click(`[data-action="remove-field"][data-id="${added}"]`);
  assert.equal(editor.d.querySelectorAll('.question-card').length, 5);
  editor.click('[data-tab="preview"]');
  assert.ok(editor.d.querySelector('.submit-button').disabled);
  editor.d.querySelector('#tab-preview').dispatchEvent(new editor.w.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  assert.ok(editor.d.querySelector('#builder'));
  editor.click('[data-action="save"]');
  await until(() => editor.d.querySelector('#save-state').textContent.includes('Изменения сохранены'), 'сохранение');
  assert.deepEqual(editor.errors, []);
  assert.deepEqual(home.errors, []);
});

test('UI: publish, validation of all field types, draft restore, lost response retry and manager answers', async t => {
  const f = await fixture(t);
  const form = await f.request('/api/forms', 'POST', definition());
  const editor = f.page(`/admin/${form.id}`);
  await editor.ready('#builder');
  editor.click('[data-action="publish"]');
  await editor.ready('.share-bar');
  let loseResponse = true;
  const first = f.page(`/f/${form.slug}`, { intercept: async (path, options, send) => {
    if (path.endsWith('/responses') && loseResponse && JSON.parse(options.body).answers.name) {
      loseResponse = false;
      await send();
      throw new Error('Response lost after server saved it');
    }
    return send();
  } });
  await first.ready('#student-form');
  first.submit();
  await first.ready('[aria-invalid]');
  assert.ok(first.d.querySelector('#error-email').textContent);
  fillStudent(first);
  // Re-open with the same browser storage; typed values and choices must survive.
  const student = f.page(`/f/${form.slug}`, { storage: first.storage(), intercept: async (path, options, send) => {
    if (path.endsWith('/responses') && loseResponse) {
      loseResponse = false;
      await send();
      throw new Error('Response lost after server saved it');
    }
    return send();
  } });
  await student.ready('#student-form');
  assert.equal(student.d.querySelector('[name="name"]').value, 'Анна <script>alert(1)</script>');
  assert.ok(student.d.querySelector('[name="skills"][value="JS"]').checked);
  // Publishing identical questions must not invalidate this student's page.
  editor.click('[data-action="publish"]');
  await until(() => !editor.d.querySelector('[data-action="publish"]').disabled, 'повторная публикация');
  student.submit();
  await until(() => student.d.querySelector('#submit-error')?.textContent.includes('Не удалось связаться'), 'ошибка доставки ответа');
  assert.equal(student.d.querySelector('[name="email"]').value, 'anna@example.com');
  assert.equal(student.d.querySelector('.submit-button').disabled, false);
  student.submit();
  await student.ready('.success-card');
  const reopened = f.page(`/f/${form.slug}`, { storage: student.storage() });
  await reopened.ready('.success-card');
  assert.match(reopened.d.querySelector('h1').textContent, /уже отправили/);
  assert.equal(reopened.d.querySelector('#student-form'), null);
  editor.click('[data-tab="responses"]');
  await editor.ready('.response-card');
  assert.equal(editor.d.querySelectorAll('.response-card').length, 1);
  assert.match(editor.d.querySelector('.response-card').textContent, /anna@example.com/);
  assert.equal(editor.d.querySelectorAll('script').length, 1, 'User input is text, not an inserted script');
  for (const page of [first, student, reopened, editor]) assert.deepEqual(page.errors, []);
});

test('UI: editor locks during save, retains text after network failure, and retries', async t => {
  const f = await fixture(t);
  const form = await f.request('/api/forms', 'POST', definition());
  let release;
  let fail = true;
  const editor = f.page(`/admin/${form.id}`, { intercept: async (path, options, send) => {
    if (options.method === 'PUT' && fail) {
      await new Promise(resolve => { release = resolve; });
      fail = false;
      throw new Error('Offline');
    }
    return send();
  } });
  await editor.ready('#builder');
  editor.fill('#form-title', 'Мои важные правки');
  editor.click('[data-action="save"]');
  await until(() => release, 'задержанный запрос');
  assert.ok(editor.d.querySelector('#form-title').disabled);
  assert.ok(editor.d.querySelector('[data-action="add-field"]').disabled);
  release();
  await editor.ready('.editor-alert');
  assert.equal(editor.d.querySelector('#form-title').value, 'Мои важные правки');
  assert.equal(editor.d.querySelector('#form-title').disabled, false);
  assert.match(editor.d.querySelector('#save-state').textContent, /несохранённые/);
  editor.click('[data-action="save"]');
  await until(() => editor.d.querySelector('#save-state').textContent.includes('Изменения сохранены'), 'повторное сохранение');
  assert.equal((await f.request(`/api/forms/${form.id}`)).draft.title, 'Мои важные правки');
  assert.deepEqual(editor.errors, []);
});

test('UI: stale editor shows a conflict and preserves local changes', async t => {
  const f = await fixture(t);
  const form = await f.request('/api/forms', 'POST', definition());
  const one = f.page(`/admin/${form.id}`);
  const two = f.page(`/admin/${form.id}`);
  await Promise.all([one.ready('#builder'), two.ready('#builder')]);
  one.fill('#form-title', 'Из первой вкладки');
  one.click('[data-action="save"]');
  await until(() => one.d.querySelector('#save-state').textContent.includes('Изменения сохранены'), 'первая вкладка');
  two.fill('#form-description', 'Не потерять этот текст');
  two.click('[data-action="save"]');
  await two.ready('.editor-alert');
  assert.match(two.d.querySelector('.editor-alert').textContent, /другой вкладке/);
  assert.equal(two.d.querySelector('#form-description').value, 'Не потерять этот текст');
  assert.equal(two.d.querySelector('.editor-alert a').target, '_blank');
  assert.ok(two.d.querySelector('[data-action="download-draft"]'));
  assert.equal((await f.request(`/api/forms/${form.id}`)).draft.title, 'Из первой вкладки');
  assert.deepEqual(two.errors, []);
});

test('UI: changed questions restore matching answers and storage blocking does not break submission', async t => {
  const f = await fixture(t);
  const form = await f.request('/api/forms', 'POST', definition());
  await f.request(`/api/forms/${form.id}/publish`, 'POST', { draftVersion: 1 });
  const student = f.page(`/f/${form.slug}`);
  await student.ready('#student-form');
  fillStudent(student);
  const changed = definition();
  changed.fields.push({ id: 'new', type: 'text', label: 'Новый вопрос', required: true });
  await f.request(`/api/forms/${form.id}`, 'PUT', { ...changed, draftVersion: 1 });
  await f.request(`/api/forms/${form.id}/publish`, 'POST', { draftVersion: 2 });
  student.submit();
  await student.ready('[data-action="refresh-public"]');
  student.click('[data-action="refresh-public"]');
  await student.ready('[name="new"]');
  assert.equal(student.d.querySelector('[name="email"]').value, 'anna@example.com');
  assert.ok(student.d.querySelector('[name="skills"][value="JS"]').checked);
  student.fill('[name="new"]', 'Новый ответ');
  student.submit();
  await student.ready('.success-card');
  const blocked = f.page(`/f/${form.slug}`, { blockedStorage: true });
  await blocked.ready('#student-form');
  fillStudent(blocked);
  blocked.fill('[name="new"]', 'Ответ без хранилища браузера');
  blocked.submit();
  await blocked.ready('.success-card');
  assert.deepEqual(student.errors, []);
  assert.deepEqual(blocked.errors, []);
});
