import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'forma-test-'));
  const dataFile = join(directory, 'forms.json');
  let server;
  let origin;
  const start = async () => {
    server = await createApp({ dataFile });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); };
  await start();
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  return {
    dataFile,
    async restart() { await stop(); await start(); },
    async request(path, method = 'GET', body, headers = {}) {
      const response = await fetch(origin + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = response.headers.get('content-type').includes('json') ? await response.json() : await response.text();
      return { status: response.status, data, headers: response.headers };
    },
  };
}
const definition = () => ({ title: 'Летняя стажировка', description: 'Проверка полного сценария', fields: [
  { id: 'name', type: 'text', label: 'Ваше имя', required: true },
  { id: 'email', type: 'email', label: 'Email', required: true },
  { id: 'track', type: 'select', label: 'Направление', required: true, options: ['Разработка', 'Дизайн'] },
  { id: 'skills', type: 'checkbox', label: 'Навыки', required: true, options: ['JS', 'CSS'] },
  { id: 'year', type: 'number', label: 'Курс', required: false },
] });
const validAnswers = { name: 'Анна', email: 'anna@example.com', track: 'Разработка', skills: ['JS'], year: '3' };

test('MVP: create, publish, student submit, manager read, restart persistence', async t => {
  const f = await fixture(t);
  const created = await f.request('/api/forms', 'POST', definition());
  assert.equal(created.status, 201);
  const form = created.data;
  const publicPath = `/api/public/${form.slug}`;
  assert.equal((await f.request(publicPath)).status, 404);
  assert.equal((await f.request(`/api/forms/${form.id}/publish`, 'POST', { draftVersion: 1 })).status, 200);
  const published = (await f.request(publicPath)).data;
  assert.equal(published.title, definition().title);
  assert.equal(published.responses, undefined);
  const sessionId = randomUUID();
  await f.request(`${publicPath}/visit`, 'POST', { sessionId });
  await f.request(`${publicPath}/visit`, 'POST', { sessionId });
  await f.request(`${publicPath}/start`, 'POST', { sessionId });
  const payload = { sessionId, revision: published.revision, answers: validAnswers };
  const response = await f.request(`${publicPath}/responses`, 'POST', payload);
  assert.equal(response.status, 201);
  assert.equal((await f.request(`${publicPath}/responses`, 'POST', payload)).data.id, response.data.id);
  let responses = (await f.request(`/api/forms/${form.id}/responses`)).data;
  assert.equal(responses.responses.length, 1);
  assert.deepEqual(responses.responses[0].answers, validAnswers);
  assert.equal(responses.views, 1);
  assert.equal(responses.started, 1);
  await f.restart();
  responses = (await f.request(`/api/forms/${form.id}/responses`)).data;
  assert.equal(responses.responses.length, 1);
  assert.equal((await f.request(publicPath)).data.title, definition().title);
  assert.equal((await f.request('/admin')).status, 200);
  assert.equal((await f.request('/admin/forms')).status, 200);
  assert.equal((await f.request('/admin/forms/')).status, 200);
  assert.equal((await f.request(`/f/${form.slug}`)).status, 200);
});

test('validation rejects invalid definitions and answers without storing them', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/forms', 'POST', { title: '', fields: [] })).status, 400);
  const duplicateIds = definition(); duplicateIds.fields[1].id = 'name';
  assert.equal((await f.request('/api/forms', 'POST', duplicateIds)).status, 400);
  const { data: form } = await f.request('/api/forms', 'POST', definition());
  await f.request(`/api/forms/${form.id}/publish`, 'POST', { draftVersion: 1 });
  const { status, data } = await f.request(`/api/public/${form.slug}/responses`, 'POST', {
    sessionId: randomUUID(), revision: 1, answers: { name: '', email: 'bad', track: 'Нет такого', skills: [], year: 'abc' },
  });
  assert.equal(status, 400);
  assert.deepEqual(Object.keys(data.fields).sort(), ['email', 'name', 'skills', 'track', 'year']);
  assert.equal((await f.request(`/api/forms/${form.id}/responses`)).data.responsesCount, 0);
  assert.equal((await f.request('/api/forms')).data[0].views, 0);
  assert.equal((await f.request(`/api/public/${form.slug}/responses`, 'POST', { sessionId: randomUUID(), revision: 1, answers: { ...validAnswers, skills: ['JS', 'BAD'] } })).status, 400);
});

test('draft isolation, stale form rejection, answer snapshots, closing and reopening', async t => {
  const f = await fixture(t);
  const { data: form } = await f.request('/api/forms', 'POST', definition());
  await f.request(`/api/forms/${form.id}/publish`, 'POST', { draftVersion: 1 });
  const path = `/api/public/${form.slug}`;
  await f.request(`${path}/responses`, 'POST', { sessionId: randomUUID(), revision: 1, answers: validAnswers });
  const updated = definition(); updated.title = 'Новое название'; updated.fields[0].label = 'Имя и фамилия';
  await f.request(`/api/forms/${form.id}`, 'PUT', { ...updated, draftVersion: 1 });
  assert.equal((await f.request(path)).data.title, definition().title);
  await f.request(`/api/forms/${form.id}/publish`, 'POST', { draftVersion: 2 });
  assert.equal((await f.request(path)).data.title, updated.title);
  assert.equal((await f.request(`${path}/responses`, 'POST', { sessionId: randomUUID(), revision: 1, answers: validAnswers })).status, 409);
  const snapshot = (await f.request(`/api/forms/${form.id}/responses`)).data.responses[0];
  assert.equal(snapshot.fields[0].label, 'Ваше имя');
  await f.request(`/api/forms/${form.id}/unpublish`, 'POST');
  assert.equal((await f.request(path)).status, 404);
  assert.equal((await f.request(`${path}/responses`, 'POST', { sessionId: randomUUID(), revision: 2, answers: validAnswers })).status, 404);
  await f.request(`/api/forms/${form.id}/publish`, 'POST', { draftVersion: 2 });
  assert.equal((await f.request(path)).status, 200);
  assert.equal((await f.request(`/api/forms/${form.id}/responses`)).data.responsesCount, 1);
});

test('parallel writes and simultaneous retries do not lose or duplicate submissions', async t => {
  const f = await fixture(t);
  const { data: form } = await f.request('/api/forms', 'POST', definition());
  await f.request(`/api/forms/${form.id}/publish`, 'POST', { draftVersion: 1 });
  const sessionId = randomUUID();
  const responses = await Promise.all(Array.from({ length: 15 }, (_, index) => f.request(`/api/public/${form.slug}/responses`, 'POST', {
    sessionId: index < 5 ? sessionId : randomUUID(), revision: 1, answers: validAnswers,
  })));
  assert.equal(responses.filter(response => response.status === 201).length, 11);
  assert.equal(responses.filter(response => response.status === 200).length, 4);
  assert.equal((await f.request(`/api/forms/${form.id}/responses`)).data.responsesCount, 11);
  await f.restart();
  assert.equal((await f.request(`/api/forms/${form.id}/responses`)).data.responsesCount, 11);
});

test('empty drafts cannot publish; static paths, origin and request limits are enforced', async t => {
  const f = await fixture(t);
  const { data: form } = await f.request('/api/forms', 'POST', { title: 'Черновик', fields: [] });
  assert.equal((await f.request(`/api/forms/${form.id}/publish`, 'POST', { draftVersion: 1 })).status, 400);
  assert.equal((await f.request('/api/forms', 'POST', definition(), { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await f.request('/data/forms.json')).status, 404);
  assert.equal((await f.request('/server.js')).status, 404);
  assert.equal((await f.request('/unknown')).status, 404);
  assert.equal((await f.request('/api/unknown')).status, 404);
  assert.equal((await f.request('/api/forms', 'POST', { title: 'x'.repeat(1100000) })).status, 413);
  const page = await f.request('/admin');
  assert.ok(page.headers.get('content-security-policy').includes("script-src 'self'"));
  const file = JSON.parse(await readFile(f.dataFile, 'utf8'));
  assert.equal(file.forms.length, 1);
});

test('corrupt data is not silently overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forma-corrupt-'));
  const dataFile = join(directory, 'forms.json');
  try {
    await writeFile(dataFile, '{broken');
    await assert.rejects(createApp({ dataFile }));
    assert.equal(await readFile(dataFile, 'utf8'), '{broken');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a second distinct response in one session is rejected honestly, including after restart', async t => {
  const f = await fixture(t);
  const { data: form } = await f.request('/api/forms', 'POST', definition());
  await f.request(`/api/forms/${form.id}/publish`, 'POST', { draftVersion: 1 });
  const path = `/api/public/${form.slug}`;
  const sessionId = randomUUID();
  const payload = { sessionId, revision: 1, answers: validAnswers };
  const first = await f.request(`${path}/responses`, 'POST', payload);
  assert.equal(first.status, 201);
  const retry = await f.request(`${path}/responses`, 'POST', payload);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.id, first.data.id);
  const changed = await f.request(`${path}/responses`, 'POST', { ...payload, answers: { ...validAnswers, name: 'Мария' } });
  assert.equal(changed.status, 409);
  assert.equal(changed.data.code, 'ALREADY_SUBMITTED');
  assert.equal((await f.request(`${path}?sessionId=${sessionId}`)).data.submitted, true);
  assert.equal((await f.request(`${path}?sessionId=${randomUUID()}`)).data.submitted, false);
  await f.restart();
  assert.equal((await f.request(`${path}/responses`, 'POST', payload)).status, 200);
  const responses = (await f.request(`/api/forms/${form.id}/responses`)).data.responses;
  assert.equal(responses.length, 1);
  assert.equal(responses[0].answers.name, 'Анна');
});

test('unchanged publication, metadata updates and reopening keep open student forms valid', async t => {
  const f = await fixture(t);
  const { data: form } = await f.request('/api/forms', 'POST', definition());
  const admin = `/api/forms/${form.id}`;
  const path = `/api/public/${form.slug}`;
  await f.request(`${admin}/publish`, 'POST', { draftVersion: 1 });
  await f.request(`${admin}/publish`, 'POST', { draftVersion: 1 });
  assert.equal((await f.request(path)).data.revision, 1);
  const modified = { ...definition(), title: 'Новое название', draftVersion: 1 };
  const saved = await f.request(admin, 'PUT', modified);
  assert.equal(saved.data.draftVersion, 2);
  await f.request(`${admin}/publish`, 'POST', { draftVersion: 2 });
  assert.equal((await f.request(path)).data.revision, 1);
  await f.request(`${admin}/unpublish`, 'POST');
  await f.restart();
  await f.request(`${admin}/publish`, 'POST', { draftVersion: 2 });
  assert.equal((await f.request(path)).data.revision, 1);
  const accepted = await f.request(`${path}/responses`, 'POST', { sessionId: randomUUID(), revision: 1, answers: validAnswers });
  assert.equal(accepted.status, 201);
});

test('concurrent editor saves accept one version and never erase newer questions', async t => {
  const f = await fixture(t);
  const { data: form } = await f.request('/api/forms', 'POST', definition());
  const path = `/api/forms/${form.id}`;
  const one = definition();
  one.fields.push({ id: 'about', type: 'textarea', label: 'О себе', required: false });
  const two = { ...definition(), description: 'Из старой вкладки' };
  const responses = await Promise.all([
    f.request(path, 'PUT', { ...one, draftVersion: 1 }),
    f.request(path, 'PUT', { ...two, draftVersion: 1 }),
  ]);
  assert.deepEqual(responses.map(item => item.status).sort(), [200, 409]);
  assert.equal(responses.find(item => item.status === 409).data.code, 'DRAFT_CONFLICT');
  const current = (await f.request(path)).data;
  assert.equal(current.draftVersion, 2);
  assert.deepEqual(current.draft, responses[0].status === 200 ? one : two);
  assert.equal((await f.request(`${path}/publish`, 'POST', { draftVersion: 1 })).status, 409);
  assert.equal((await f.request(path, 'PUT', two)).status, 428);
  // A fresh save of identical data is a no-op and keeps the counter stable.
  assert.equal((await f.request(path, 'PUT', { ...current.draft, draftVersion: 2 })).data.draftVersion, 2);
  await f.restart();
  assert.equal((await f.request(path)).data.draftVersion, 2);
});

test('legacy JSON gains draft counters without losing forms or responses', async t => {
  const f = await fixture(t);
  const { data: form } = await f.request('/api/forms', 'POST', definition());
  const state = JSON.parse(await readFile(f.dataFile, 'utf8'));
  delete state.forms[0].draftVersion;
  delete state.forms[0].lastPublished;
  await writeFile(f.dataFile, JSON.stringify(state));
  await f.restart();
  const restored = (await f.request(`/api/forms/${form.id}`)).data;
  assert.equal(restored.draftVersion, 1);
  assert.deepEqual(restored.draft, definition());
  const saved = await f.request(`/api/forms/${form.id}`, 'PUT', { ...definition(), description: 'После миграции', draftVersion: 1 });
  assert.equal(saved.status, 200);
});

test('different concurrent answers from one session yield one success and one explicit rejection', async t => {
  const f = await fixture(t);
  const { data: form } = await f.request('/api/forms', 'POST', definition());
  await f.request(`/api/forms/${form.id}/publish`, 'POST', { draftVersion: 1 });
  const sessionId = randomUUID();
  const requests = ['Анна', 'Мария'].map(name => f.request(`/api/public/${form.slug}/responses`, 'POST', {
    sessionId, revision: 1, answers: { ...validAnswers, name },
  }));
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  assert.equal(responses.find(response => response.status === 409).data.code, 'ALREADY_SUBMITTED');
  assert.equal((await f.request(`/api/forms/${form.id}/responses`)).data.responsesCount, 1);
});
