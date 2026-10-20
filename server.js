import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { createStore } from './lib/store.js';
import { HttpError, validateDefinition, validateAnswers } from './lib/validation.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const now = () => new Date().toISOString();
const summary = form => ({
  id: form.id, slug: form.slug, title: form.draft.title,
  description: form.draft.description, published: !!form.published,
  updatedAt: form.updatedAt, fieldsCount: form.draft.fields.length,
  responsesCount: form.responses.length,
  views: form.visits.length, started: form.visits.filter(visit => visit.startedAt).length,
});
const locate = (state, id) => {
  const form = state.forms.find(item => item.id === id);
  if (!form) throw new HttpError(404, 'Форма не найдена.');
  return form;
};
const publicForm = (state, slug) => {
  const form = state.forms.find(item => item.slug === slug && item.published);
  if (!form) throw new HttpError(404, 'Форма недоступна. Возможно, приём ответов ещё не открыт или уже завершён.');
  return form;
};
const sessionId = body => {
  if (typeof body.sessionId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.sessionId)) throw new HttpError(400, 'Неверная сессия. Обновите страницу.');
  return body.sessionId;
};

async function readBody(request) {
  if (!request.headers['content-type']?.includes('application/json')) throw new HttpError(415, 'Используйте JSON.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new HttpError(413, 'Запрос слишком большой.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new HttpError(400, 'Некорректный JSON.'); }
}

export async function createApp({ dataFile = resolve(root, 'data/forms.json') } = {}) {
  const store = await createStore(dataFile);
  return http.createServer(async (request, response) => {
    const json = (data, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(data));
    };
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      const method = request.method;
      // Reject cross-origin browser mutations; /admin intentionally has no login per spec.
      if (!['GET', 'HEAD'].includes(method) && request.headers.origin) {
        const origin = new URL(request.headers.origin);
        if (origin.host !== request.headers.host) throw new HttpError(403, 'Запрос с другого сайта отклонён.');
      }
      if (path === '/api/forms' && method === 'GET') return json(store.read().forms.map(summary).reverse());
      if (path === '/api/forms' && method === 'POST') {
        const draft = validateDefinition(await readBody(request));
        const form = { id: randomUUID(), slug: randomBytes(12).toString('hex'), draft, published: null, revision: 0, createdAt: now(), updatedAt: now(), visits: [], responses: [] };
        await store.update(state => { state.forms.push(form); });
        return json({ ...summary(form), draft: form.draft, revision: 0 }, 201);
      }
      const adminMatch = path.match(/^\/api\/forms\/([a-f0-9-]+)(?:\/(publish|unpublish|responses))?$/);
      if (adminMatch) {
        const [, id, action] = adminMatch;
        if (!action && method === 'GET') {
          const form = locate(store.read(), id);
          return json({ ...summary(form), draft: form.draft, revision: form.revision, publishedDefinition: form.published });
        }
        if (!action && method === 'PUT') {
          const draft = validateDefinition(await readBody(request));
          return json(await store.update(state => {
            const form = locate(state, id);
            form.draft = draft;
            form.updatedAt = now();
            return { ...summary(form), draft, revision: form.revision };
          }));
        }
        if (['publish', 'unpublish'].includes(action) && method === 'POST') {
          return json(await store.update(state => {
            const form = locate(state, id);
            form.published = action === 'publish' ? validateDefinition(form.draft, true) : null;
            if (action === 'publish') form.revision++;
            form.updatedAt = now();
            return { ...summary(form), revision: form.revision };
          }));
        }
        if (action === 'responses' && method === 'GET') {
          const form = locate(store.read(), id);
          return json({ ...summary(form), responses: form.responses.slice().reverse() });
        }
      }
      const publicMatch = path.match(/^\/api\/public\/([a-f0-9]{24})(?:\/(visit|start|responses))?$/);
      if (publicMatch) {
        const [, slug, action] = publicMatch;
        if (!action && method === 'GET') {
          const form = publicForm(store.read(), slug);
          return json({ ...form.published, revision: form.revision });
        }
        if (method === 'POST' && action) {
          const body = await readBody(request);
          const sid = sessionId(body);
          const result = await store.update(state => {
            const form = publicForm(state, slug);
            if (action === 'responses') {
              const existing = form.responses.find(item => item.sessionId === sid);
              if (existing) return { id: existing.id };
              if (body.revision !== form.revision) throw new HttpError(409, 'Форма изменилась. Скопируйте свои ответы и обновите страницу.');
            }
            // Validate before adding visit, so rejected submissions leave no trace.
            const answers = action === 'responses' ? validateAnswers(form.published.fields, body.answers) : null;
            let visit = form.visits.find(item => item.id === sid);
            if (!visit) { visit = { id: sid, viewedAt: now(), startedAt: null }; form.visits.push(visit); }
            if (['start', 'responses'].includes(action) && !visit.startedAt) visit.startedAt = now();
            if (action !== 'responses') return { ok: true };
            const entry = { id: randomUUID(), sessionId: sid, createdAt: now(), revision: form.revision, fields: structuredClone(form.published.fields), answers };
            form.responses.push(entry);
            return { id: entry.id };
          });
          return json(result, action === 'responses' ? 201 : 200);
        }
      }
      if (path.startsWith('/api/')) throw new HttpError(404, 'Адрес API не найден.');
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Метод не поддерживается.');
      const assets = { '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      let asset = assets[path];
      if (!asset && (path === '/' || /^\/admin(?:\/[a-f0-9-]+)?\/?$/.test(path) || /^\/f\/[a-f0-9]{24}\/?$/.test(path))) asset = ['index.html', 'text/html'];
      if (!asset) throw new HttpError(404, 'Страница не найдена.');
      const content = await readFile(resolve(root, 'public', asset[0]));
      response.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` });
      response.end(method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!error.status) console.error(error);
      json({ error: error.status ? error.message : 'Не удалось сохранить данные. Попробуйте ещё раз.', fields: error.fields }, error.status || 500);
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть целым числом от 1 до 65535.');
  const server = await createApp();
  server.on('error', error => { console.error(`Не удалось запустить сервер: ${error.message}`); process.exitCode = 1; });
  server.listen(port, () => console.log(`Форма → http://localhost:${port}/admin`));
}
