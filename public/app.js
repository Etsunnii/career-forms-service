import { api } from '/api.js';
import { EditorSession } from '/editor-session.js';
import { readAnswers, hasAnswers, saveStudentDraft, restoreStudentDraft, clearStudentDraft } from '/student-draft.js';

const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  form: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  link: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m3 10v-3a6 6 0 0 0-2-4"/>',
  chart: '<path d="M4 3v17h17M9 15v-4m5 4V7m5 8V4"/>',
  back: '<path d="m14 6-6 6 6 6"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  sparkle: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.form}</svg>`;
const typeNames = { text: 'Короткий текст', email: 'Email', textarea: 'Длинный текст', number: 'Число', select: 'Выпадающий список', radio: 'Один вариант', checkbox: 'Несколько вариантов' };
const date = value => new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
// getRandomValues also works when a reviewer opens the local server over LAN HTTP.
const uuid = () => crypto.randomUUID?.() ?? '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, value => (Number(value) ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(value) / 4).toString(16));
const countWord = (n, forms) => forms[n % 100 >= 11 && n % 100 <= 14 ? 2 : n % 10 === 1 ? 0 : n % 10 >= 2 && n % 10 <= 4 ? 1 : 2];
let forms = [], current = null, editorSession = null, tab = 'builder', busy = false;
let editorError = '', editorConflict = false, studentDraftDirty = false;
let publicDefinition, publicSession, publicSlug, started = false, submitted = false;
let toastTimer;

function notify(message, error = false) {
  toast.textContent = message;
  toast.className = `visible${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = ''; }, 5000);
}
const brand = `<a class="brand" href="/admin" aria-label="Форма — все формы"><img class="brand-mark" src="/favicon.svg" alt="" aria-hidden="true"><span class="brand-name">форма</span></a>`;
function shell(content, page = 'forms') {
  app.innerHTML = `<div class="workspace"><aside class="sidebar">${brand}<span class="workspace-label">Вкладки</span><nav aria-label="Основная навигация"><a class="nav-item ${['forms', 'editor'].includes(page) ? 'active' : ''}" href="/admin/forms">${icon('form')} Мои формы <span class="nav-count">${forms.length}</span></a></nav><div class="workspace-user"><span class="avatar">М</span><div><strong>Менеджер</strong><small>Карьерная платформа</small></div><span class="online-dot" title="Локальное приложение"></span></div></aside><div class="workspace-body"><main id="main" tabindex="-1">${content}</main></div></div>`;
}
const badge = published => `<span class="badge ${published ? 'published' : 'draft'}"><span></span>${published ? 'Опубликована' : 'Черновик'}</span>`;
function renderFormsPage() {
  current = null;
  editorSession = null;
  document.title = 'Мои формы — Форма';
  shell(`<div class="page-heading dashboard-actions"><button class="button primary" data-action="new">${icon('plus')} Создать форму</button></div>
    <section class="forms-section" id="forms"><div class="section-heading"><div><h2>Мои формы <span class="subtle-count">${forms.length}</span></h2><p>Создавайте, делитесь и следите за откликами.</p></div><label class="search">${icon('eye')}<input id="form-search" type="search" placeholder="Найти форму…" aria-label="Найти форму"></label></div>
    <div id="form-list">${renderFormList(forms)}</div></section>
    `);
}
function renderFormList(items) {
  if (!forms.length) return `<div class="empty-state"><div class="empty-art"><span class="art-paper"><i></i><i></i><i></i></span><span class="art-plus">+</span></div><h3>Здесь начнётся что-то хорошее</h3><p>Создайте первую форму и откройте дверь<br>для новых талантов и идей.</p><button class="button primary" data-action="new">${icon('plus')} Создать первую форму</button><small>Начните с шаблона или с чистого листа</small></div>`;
  if (!items.length) return `<div class="small-empty">Формы с таким названием не найдены.</div>`;
  return `<div class="form-grid">${items.map(form => `<article class="form-card"><div class="form-card-top"><span class="form-tile">${icon('form')}</span>${badge(form.published)}</div><h3><a href="/admin/${form.id}">${esc(form.title)}</a></h3><p>${esc(form.description || 'Описание пока не добавлено')}</p><div class="form-card-stats"><span>${icon('people')} <strong>${form.responsesCount}</strong> ${countWord(form.responsesCount, ['отклик', 'отклика', 'откликов'])}</span><span>${form.fieldsCount} ${countWord(form.fieldsCount, ['вопрос', 'вопроса', 'вопросов'])}</span></div><div class="form-card-bottom"><span>Обновлена ${date(form.updatedAt)}</span><a href="/admin/${form.id}" class="card-arrow" aria-label="Редактировать: ${esc(form.title)}">${icon('arrow')}</a></div></article>`).join('')}<button class="new-card" data-action="new"><span>${icon('plus')}</span><strong>Новая форма</strong><small>Для следующей возможности</small></button></div>`;
}
function openCreate() {
  const dialog = document.createElement('dialog');
  dialog.id = 'create-dialog';
  dialog.innerHTML = `<div class="dialog-heading"><div><h2>С чего начнём?</h2></div><button class="icon-button" data-action="close-dialog" aria-label="Закрыть">${icon('close')}</button></div><p class="muted">Выберите основу. Любой вопрос можно изменить.</p><div class="template-options"><button data-action="create" data-template="blank"><span class="template-icon">${icon('plus')}</span><strong>С чистого листа</strong><small>Ваши вопросы, ваши правила</small>${icon('arrow')}</button><button data-action="create" data-template="internship"><span class="template-icon purple">${icon('sparkle')}</span><strong>Отклик на стажировку</strong><small>Знакомство, контакты и направление</small>${icon('arrow')}</button></div>`;
  app.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}
function newField(type = 'text', label = 'Новый вопрос', required = false) {
  return { id: `q_${uuid()}`, type, label, required, ...(['select', 'radio', 'checkbox'].includes(type) ? { options: ['Вариант 1', 'Вариант 2'] } : {}) };
}
async function createForm(template) {
  let definition = { title: 'Новая форма', description: '', fields: [] };
  if (template !== 'blank') {
    definition = { title: 'Стажировка: первый шаг в карьеру', description: 'Давайте знакомиться! Расскажите немного о себе, и мы свяжемся с вами по поводу следующих шагов.', fields: [newField('text', 'Как вас зовут?', true), newField('email', 'Ваш email', true), newField('text', 'В каком вузе вы учитесь?')] };
    definition.fields.push({ ...newField('select', 'Какое направление вам интересно?', true), options: ['Разработка', 'Дизайн', 'Аналитика', 'Маркетинг'] }, newField('textarea', 'Почему вы хотите пройти стажировку?'));
  }
  const form = await api('/api/forms', 'POST', definition);
  document.querySelector('dialog')?.close();
  location.href = `/admin/${form.id}`;
}
function editorTabs() {
  return `<div class="tabs" role="tablist" aria-label="Разделы формы">${[['builder', 'Конструктор', 'form'], ['preview', 'Предпросмотр', 'eye'], ['responses', `Ответы${current.responsesCount ? ` · ${current.responsesCount}` : ''}`, 'people']].map(([id, label, name]) => `<button id="tab-${id}" role="tab" aria-controls="editor-panel" aria-selected="${tab === id}" tabindex="${tab === id ? 0 : -1}" class="tab ${tab === id ? 'selected' : ''}" data-action="tab" data-tab="${id}">${icon(name)} ${label}</button>`).join('')}</div>`;
}
function renderEditor() {
  document.title = `${current.draft.title} — Форма`;
  const content = `<a class="back-link" href="/admin/forms">${icon('back')} Все формы</a><div class="editor-heading"><div><div class="editor-title"><h1>${esc(current.draft.title)}</h1>${badge(current.published)}</div><p id="save-state">${editorSession.dirty ? 'Есть несохранённые изменения' : 'Изменения сохранены'} · ${current.draft.fields.length} ${countWord(current.draft.fields.length, ['вопрос', 'вопроса', 'вопросов'])}</p></div><div class="heading-actions"><button class="button secondary" data-action="save">Сохранить</button><button class="button primary" data-action="publish">${icon('link')} ${current.published ? 'Обновить публикацию' : 'Опубликовать'}</button></div></div>${renderEditorError()}${current.published ? `<div class="share-bar"><span class="share-live">${icon('check')} Форма принимает ответы</span><a href="/f/${current.slug}" target="_blank" rel="noopener">${esc(location.origin)}/f/${current.slug}</a><button class="text-button" data-action="copy-link">${icon('copy')} Скопировать</button><button class="text-button muted" data-action="unpublish">Закрыть приём</button></div>` : ''}${editorTabs()}<div id="editor-panel" role="tabpanel">${tab === 'builder' ? renderBuilder() : tab === 'preview' ? `<div class="preview-notice">${icon('eye')} Так студенты увидят форму. Отправка ответов в предпросмотре отключена.</div>${renderQuestionnaire(current.draft, true)}` : '<div class="loading">Загружаем ответы…</div>'}</div>`;
  shell(content, 'editor');
  document.querySelector('#editor-panel').setAttribute('aria-labelledby', `tab-${tab}`);
  if (tab === 'responses') loadResponses();
}
function renderBuilder() {
  return `<div class="builder-layout"><form id="builder" class="builder-content"><section class="editor-card intro-card"><div class="card-caption"><span class="step-dot">${icon('form')}</span><div><h2>О форме</h2><p>Хорошее знакомство начинается с пары слов.</p></div></div><label class="field-label" for="form-title">Название формы <span class="required">*</span></label><input id="form-title" data-definition="title" value="${esc(current.draft.title)}" required maxlength="160" placeholder="Например, летняя стажировка в команде"><label class="field-label" for="form-description">Описание <span class="optional">необязательно</span></label><textarea id="form-description" data-definition="description" rows="3" maxlength="3000" placeholder="Расскажите о возможности и о том, что будет после отклика">${esc(current.draft.description)}</textarea></section><div class="questions-heading"><h2>Вопросы <span class="subtle-count">${current.draft.fields.length}</span></h2><span>До 40 вопросов</span></div>${current.draft.fields.map(renderFieldEditor).join('')}${!current.draft.fields.length ? `<div class="question-empty">${icon('form')}<strong>Давайте начнём знакомство</strong><p>Добавьте первый вопрос с помощью панели справа.</p></div>` : ''}<button type="button" class="add-question" data-action="add-field" data-type="text">${icon('plus')} Добавить вопрос</button></form><aside class="builder-toolbox"><div class="toolbox-card"><div class="eyebrow">ВАША ФОРМА, ВАШИ ВОПРОСЫ</div><h2>Добавить поле</h2><p>Выберите подходящий тип ответа.</p><div class="field-types">${Object.entries(typeNames).map(([type, label]) => `<button data-action="add-field" data-type="${type}"><span class="type-symbol">${{ text: 'T', email: '@', textarea: '¶', number: '#', select: '▾', radio: '◉', checkbox: '☑' }[type]}</span>${label}${icon('plus')}</button>`).join('')}</div></div><div class="tip-card">${icon('sparkle')}<strong>Каждый вопрос имеет значение</strong><p>Короткую форму чаще заполняют до конца. Спрашивайте только о том, что поможет сделать следующий шаг.</p></div><p class="local-note">Черновик не меняет опубликованную форму. Чтобы применить изменения, обновите публикацию.</p></aside></div>`;
}
function renderFieldEditor(field, index) {
  return `<section class="editor-card question-card" data-field="${field.id}"><div class="question-top"><span class="question-number">ВОПРОС ${String(index + 1).padStart(2, '0')}</span><div class="question-tools"><button type="button" class="icon-button" data-action="move-up" data-id="${field.id}" aria-label="Поднять вопрос ${index + 1}" ${index === 0 ? 'disabled' : ''}>${icon('up')}</button><button type="button" class="icon-button" data-action="move-down" data-id="${field.id}" aria-label="Опустить вопрос ${index + 1}" ${index === current.draft.fields.length - 1 ? 'disabled' : ''}>${icon('down')}</button><button type="button" class="icon-button danger" data-action="remove-field" data-id="${field.id}" aria-label="Удалить вопрос ${index + 1}">${icon('trash')}</button></div></div><div class="question-inputs"><div><label class="field-label" for="label-${field.id}">Текст вопроса <span class="required">*</span></label><input id="label-${field.id}" data-property="label" required maxlength="240" value="${esc(field.label)}"></div><div><label class="field-label" for="type-${field.id}">Тип ответа</label><select id="type-${field.id}" data-property="type">${Object.entries(typeNames).map(([type, label]) => `<option value="${type}" ${field.type === type ? 'selected' : ''}>${label}</option>`).join('')}</select></div></div>${['select', 'radio', 'checkbox'].includes(field.type) ? `<label class="field-label" for="options-${field.id}">Варианты ответа <span class="optional">каждый с новой строки, до 30</span></label><textarea id="options-${field.id}" data-property="options" required rows="3">${esc(field.options.join('\n'))}</textarea>` : ''}<div class="question-bottom"><label class="switch-label"><input type="checkbox" data-property="required" ${field.required ? 'checked' : ''}><span class="switch"></span>Обязательный вопрос</label><span class="optional">${field.type === 'textarea' ? 'До 5 000 символов' : ['text', 'email'].includes(field.type) ? 'До 500 символов' : ''}</span></div></section>`;
}
function setDirty() {
  editorSession.changed();
  const status = document.querySelector('#save-state');
  if (status) status.textContent = 'Есть несохранённые изменения';
}
async function save(showNotice = true) {
  if (tab === 'builder' && !document.querySelector('#builder').reportValidity()) return false;
  const clean = await editorSession.save(api);
  if (!clean) throw new Error('Появились новые правки. Сохраните их перед публикацией.');
  editorError = '';
  editorConflict = false;
  if (showNotice) notify('Черновик сохранён');
  return true;
}
function renderEditorError() {
  if (!editorError) return '';
  return `<div class="editor-alert" role="alert"><p>${esc(editorError)}</p>${editorConflict ? `<div class="heading-actions"><a class="button secondary" href="/admin/${current.id}" target="_blank" rel="noopener">Открыть актуальную версию</a><button class="button secondary" data-action="download-draft">Скачать мои правки</button></div>` : ''}</div>`;
}

function lockControls(root) {
  const controls = [...root.querySelectorAll('input, textarea, select, button')];
  const previous = controls.map(control => [control, control.disabled]);
  for (const control of controls) control.disabled = true;
  root.setAttribute('aria-busy', 'true');
  return () => {
    for (const [control, disabled] of previous) control.disabled = disabled;
    root.removeAttribute('aria-busy');
  };
}

// Browser storage is optional, including when its property getter itself throws.
function browserStorage() {
  try { return sessionStorage; } catch { return null; }
}

function rememberStudentDraft(form) {
  const answers = readAnswers(form, publicDefinition.fields);
  studentDraftDirty = hasAnswers(answers);
  if (studentDraftDirty) saveStudentDraft(browserStorage(), publicSlug, publicDefinition.revision, answers);
  else clearStudentDraft(browserStorage(), publicSlug);
}

function showSubmissionSuccess(already = false) {
  submitted = true;
  studentDraftDirty = false;
  clearStudentDraft(browserStorage(), publicSlug);
  document.querySelector('#main').innerHTML = `<section class="success-card" tabindex="-1"><div class="success-icon">${icon('check')}</div><h1>${already ? 'Вы уже отправили отклик' : 'Ваш отклик отправлен!'}</h1><p>${already ? 'Команда уже получила ваши ответы. Повторное заполнение этой формы в данной вкладке недоступно.' : 'Спасибо, что рассказали о себе. Команда получила ваши ответы и сможет связаться с вами по указанным контактам.'}</p><div class="success-form-title">${icon('form')}${esc(publicDefinition.title)}</div><small>Теперь эту вкладку можно закрыть.</small></section>`;
  document.querySelector('.success-card').focus();
}
function renderQuestionnaire(definition, preview = false) {
  return `<div class="questionnaire ${preview ? 'in-preview' : ''}"><div class="questionnaire-accent"></div><div class="questionnaire-body"><div class="eyebrow">НОВЫЕ ВОЗМОЖНОСТИ НАЧИНАЮТСЯ ЗДЕСЬ</div><h1>${esc(definition.title)}</h1>${definition.description ? `<p class="form-description">${esc(definition.description)}</p>` : ''}${definition.fields.some(field => field.required) ? '<p class="required-note"><span class="required">*</span> Обязательные вопросы</p>' : ''}<form id="student-form" novalidate>${definition.fields.map((field, index) => renderQuestion(field, index, preview)).join('')}<div id="submit-error" class="form-error" role="alert"></div><button class="button primary submit-button" type="submit" ${preview ? 'disabled' : ''}>Отправить отклик ${icon('arrow')}</button><p class="submission-note">Проверьте контакты, чтобы с вами могли связаться.</p></form></div></div>`;
}
function renderQuestion(field, index, preview) {
  const id = `answer-${field.id}`;
  const attrs = `id="${id}" name="${field.id}" ${field.required && field.type !== 'checkbox' ? 'required' : ''} aria-describedby="error-${field.id}" ${preview ? 'tabindex="-1"' : ''}`;
  const label = `<span class="public-question-number">${String(index + 1).padStart(2, '0')}</span>${esc(field.label)}${field.required ? ' <span class="required">*</span>' : ''}`;
  let input;
  if (field.type === 'textarea') input = `<textarea ${attrs} rows="4" maxlength="5000" placeholder="Ваш ответ"></textarea>`;
  else if (field.type === 'select') input = `<select ${attrs}><option value="">Выберите вариант</option>${field.options.map(option => `<option>${esc(option)}</option>`).join('')}</select>`;
  else if (['radio', 'checkbox'].includes(field.type)) input = `<div class="choice-list">${field.options.map((option, i) => `<label class="choice" for="${id}-${i}"><input id="${id}-${i}" name="${field.id}" type="${field.type}" value="${esc(option)}" aria-describedby="error-${field.id}"><span>${esc(option)}</span></label>`).join('')}</div>`;
  else input = `<input ${attrs} type="${field.type}" ${field.type === 'number' ? 'step="any"' : 'maxlength="500"'} placeholder="${field.type === 'email' ? 'you@example.com' : 'Ваш ответ'}" ${field.type === 'email' ? 'autocomplete="email"' : ''}>`;
  return `<${['radio', 'checkbox'].includes(field.type) ? 'fieldset' : 'div'} class="public-question" data-answer="${field.id}">${['radio', 'checkbox'].includes(field.type) ? `<legend>${label}</legend>` : `<label for="${id}">${label}</label>`}${input}<p class="field-error" id="error-${field.id}"></p></${['radio', 'checkbox'].includes(field.type) ? 'fieldset' : 'div'}>`;
}
async function loadResponses() {
  const targetId = current.id;
  try {
    const data = await api(`/api/forms/${targetId}/responses`);
    if (current?.id !== targetId || tab !== 'responses') return;
    current.responsesCount = data.responsesCount;
    const rate = data.views ? Math.round(data.responsesCount / data.views * 100) : 0;
    document.querySelector('#editor-panel').innerHTML = `<div class="responses-layout"><section class="response-main"><div class="section-heading"><div><h2>Отклики <span class="subtle-count">${data.responsesCount}</span></h2><p>Познакомьтесь с теми, кто сделал первый шаг.</p></div><button class="button secondary" data-action="refresh-responses">Обновить</button></div>${data.responses.length ? `<div class="responses-list">${data.responses.map((entry, i) => `<details class="response-card"><summary><span class="response-avatar">${data.responses.length - i}</span><span><strong>${esc(Object.values(entry.answers).find(value => typeof value === 'string' && value) || 'Отклик')}</strong><small>${date(entry.createdAt)} · версия ${entry.revision}</small></span>${icon('down')}</summary><dl>${entry.fields.map(field => `<div><dt>${esc(field.label)}</dt><dd>${esc(Array.isArray(entry.answers[field.id]) ? entry.answers[field.id].join(', ') || 'Без ответа' : entry.answers[field.id] || 'Без ответа')}</dd></div>`).join('')}</dl></details>`).join('')}</div>` : `<div class="response-empty">${icon('people')}<h3>Первый отклик ещё впереди</h3><p>Опубликуйте форму и поделитесь ссылкой.<br>Ответы появятся здесь.</p>${current.published ? '<button class="button secondary" data-action="copy-link">Скопировать ссылку</button>' : '<button class="button primary" data-action="publish">Опубликовать форму</button>'}</div>`}</section><aside class="funnel-card"><span class="eyebrow">ОТ ИНТЕРЕСА К ДЕЙСТВИЮ</span><h2>Воронка заполнения</h2><p>Узнайте, на каком этапе<br>теряются отклики.</p>${[['Открыли форму', data.views], ['Начали заполнять', data.started], ['Отправили отклик', data.responsesCount]].map(([label, count]) => `<div class="funnel-step"><div><span>${label}</span><strong>${count}</strong></div><progress max="${Math.max(data.views, 1)}" value="${count}">${count}</progress></div>`).join('')}<div class="conversion"><strong>${data.views ? `${rate}%` : '—'}</strong><span>конверсия в отклик</span></div><small>Считаем посещения в рамках вкладки браузера. Повторная отправка в одной сессии не создаёт второй отклик. Начало — первое изменение ответа.</small></aside></div>`;
  } catch (error) { if (tab === 'responses') document.querySelector('#editor-panel').innerHTML = `<div class="error-state"><p>${esc(error.message)}</p><button class="button secondary" data-action="refresh-responses">Повторить</button></div>`; }
}
async function loadPublic(slug) {
  publicSlug = slug;
  submitted = false;
  started = false;
  studentDraftDirty = false;
  app.innerHTML = `<div class="public-shell"><header class="public-header">${brand}<span>Пространство новых возможностей</span></header><main id="main"><div class="loading">Загружаем форму…</div></main></div>`;
  try {
    try {
      const key = `forma-session-${slug}`;
      publicSession = browserStorage()?.getItem(key) || publicSession || uuid();
      browserStorage()?.setItem(key, publicSession);
    } catch { publicSession ||= uuid(); }
    publicDefinition = await api(`/api/public/${slug}?sessionId=${encodeURIComponent(publicSession)}`);
    document.title = `${publicDefinition.title} — Форма`;
    if (publicDefinition.submitted) return showSubmissionSuccess(true);
    document.querySelector('#main').innerHTML = `${renderQuestionnaire(publicDefinition)}<div class="public-footer">${icon('check')} Ваш следующий шаг начинается с отклика <span>Создано в <a href="/admin">форме.</a></span></div>`;
    const form = document.querySelector('#student-form');
    const changed = restoreStudentDraft(browserStorage(), slug, form, publicDefinition);
    rememberStudentDraft(form);
    if (changed) document.querySelector('#submit-error').textContent = 'Форма обновилась. Проверьте восстановленные ответы: удалённые вопросы и недоступные варианты не перенесены.';
    api(`/api/public/${slug}/visit`, 'POST', { sessionId: publicSession }).catch(() => {});
  } catch (error) {
    document.querySelector('#main').innerHTML = `<div class="unavailable">${icon('form')}<h1>Пока не можем открыть форму</h1><p>${esc(error.message)}</p><button class="button primary" data-action="reload">Попробовать ещё раз</button></div>`;
  }
}
async function submitStudent(form) {
  if (submitted || busy) return;
  const answers = readAnswers(form, publicDefinition.fields);
  rememberStudentDraft(form);
  const button = form.querySelector('button[type="submit"]');
  busy = true;
  const unlock = lockControls(form);
  button.textContent = 'Отправляем…';
  form.querySelectorAll('.field-error').forEach(element => { element.textContent = ''; });
  form.querySelectorAll('[aria-invalid]').forEach(element => element.removeAttribute('aria-invalid'));
  document.querySelector('#submit-error').textContent = '';
  try {
    await api(`/api/public/${publicSlug}/responses`, 'POST', { sessionId: publicSession, revision: publicDefinition.revision, answers });
    showSubmissionSuccess();
  } catch (error) {
    document.querySelector('#submit-error').textContent = error.message;
    if (error.code === 'FORM_CHANGED') {
      document.querySelector('#submit-error').insertAdjacentHTML('beforeend', '<button type="button" class="button secondary" data-action="refresh-public">Обновить форму и восстановить ответы</button>');
    }
    if (error.fields) {
      for (const [id, message] of Object.entries(error.fields)) {
        document.getElementById(`error-${id}`).textContent = message;
        form.querySelectorAll(`[name="${id}"]`).forEach(input => input.setAttribute('aria-invalid', 'true'));
      }
      form.querySelector('[aria-invalid]')?.focus();
    }
  } finally {
    busy = false;
    unlock();
    button.innerHTML = `Отправить отклик ${icon('arrow')}`;
    form.querySelector('[aria-invalid]')?.focus();
  }
}

app.addEventListener('input', event => {
  const target = event.target;
  if (target.id === 'form-search') {
    document.querySelector('#form-list').innerHTML = renderFormList(forms.filter(form => form.title.toLocaleLowerCase('ru').includes(target.value.toLocaleLowerCase('ru'))));
  }
  if (target.dataset.definition && current) { current.draft[target.dataset.definition] = target.value; setDirty(); }
  if (target.dataset.property && current) {
    const field = current.draft.fields.find(item => item.id === target.closest('[data-field]').dataset.field);
    const property = target.dataset.property;
    field[property] = property === 'required' ? target.checked : property === 'options' ? target.value.split('\n').map(value => value.trim()).filter(Boolean) : target.value;
    if (property === 'type') {
      if (['select', 'radio', 'checkbox'].includes(field.type)) field.options ||= ['Вариант 1', 'Вариант 2'];
      setDirty();
      renderEditor();
      document.getElementById(`type-${field.id}`)?.focus();
    } else setDirty();
  }
  if (target.closest('#student-form') && publicSlug) {
    rememberStudentDraft(target.closest('#student-form'));
    if (!started) {
      started = true;
      api(`/api/public/${publicSlug}/start`, 'POST', { sessionId: publicSession }).catch(() => { started = false; });
    }
  }
});
app.addEventListener('submit', event => {
  event.preventDefault();
  if (event.target.id === 'student-form' && publicSlug) submitStudent(event.target);
});
app.addEventListener('keydown', event => {
  if (busy) return;
  if (!event.target.matches('[role="tab"]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tabs = ['builder', 'preview', 'responses'];
  const index = tabs.indexOf(tab);
  tab = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3];
  renderEditor();
  document.getElementById(`tab-${tab}`).focus();
});
app.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled || busy) return;
  const action = button.dataset.action;
  if (action === 'new') return openCreate();
  if (action === 'close-dialog') return document.querySelector('dialog').close();
  if (action === 'reload') return location.reload();
  if (action === 'refresh-public') return loadPublic(publicSlug);
  if (action === 'download-draft') {
    const url = URL.createObjectURL(new Blob([JSON.stringify(current.draft, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'мои-правки.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  if (['add-field', 'remove-field', 'move-up', 'move-down'].includes(action)) {
    if (action === 'add-field') {
      if (current.draft.fields.length >= 40) return notify('В форме может быть не больше 40 вопросов.', true);
      current.draft.fields.push(newField(button.dataset.type));
    } else {
      const index = current.draft.fields.findIndex(field => field.id === button.dataset.id);
      if (action === 'remove-field') current.draft.fields.splice(index, 1);
      else {
        const destination = index + (action === 'move-up' ? -1 : 1);
        if (destination < 0 || destination >= current.draft.fields.length) return;
        [current.draft.fields[index], current.draft.fields[destination]] = [current.draft.fields[destination], current.draft.fields[index]];
      }
    }
    setDirty(); renderEditor();
    if (action === 'add-field') {
      const input = document.getElementById(`label-${current.draft.fields.at(-1).id}`);
      input.focus(); input.select();
    }
    return;
  }
  if (action === 'tab') { tab = button.dataset.tab; renderEditor(); return; }
  if (action === 'refresh-responses') return loadResponses();
  if (action === 'copy-link') {
    const link = `${location.origin}/f/${current.slug}`;
    try { await navigator.clipboard.writeText(link); notify('Ссылка скопирована'); }
    catch { const anchor = document.querySelector('.share-bar a'); if (anchor) { const selection = getSelection(); const range = document.createRange(); range.selectNodeContents(anchor); selection.removeAllRanges(); selection.addRange(range); } notify('Выделенная ссылка готова к копированию через Ctrl+C'); }
    return;
  }
  if (['save', 'publish'].includes(action) && tab === 'builder' && !document.querySelector('#builder').reportValidity()) return;
  busy = true;
  const unlock = current ? lockControls(document.querySelector('.workspace')) : () => {};
  const originalLabel = button.innerHTML;
  button.disabled = true;
  if (action === 'save') button.textContent = 'Сохраняем…';
  if (action === 'publish') button.textContent = 'Публикуем…';
  try {
    if (action === 'create') await createForm(button.dataset.template);
    if (action === 'save') { if (await save()) renderEditor(); }
    if (action === 'publish') {
      if (!await save(false)) return;
      Object.assign(current, await api(`/api/forms/${current.id}/publish`, 'POST', { draftVersion: current.draftVersion }));
      notify('Форма опубликована. Можно делиться ссылкой!'); renderEditor();
    }
    if (action === 'unpublish') {
      Object.assign(current, await api(`/api/forms/${current.id}/unpublish`, 'POST'));
      notify('Приём ответов закрыт. Полученные отклики сохранены.'); renderEditor();
    }
  } catch (error) {
    if (current) {
      editorError = error.message;
      editorConflict = ['DRAFT_CONFLICT', 'DRAFT_VERSION_REQUIRED'].includes(error.code);
      renderEditor();
    }
    notify(error.message, true);
  }
  finally {
    busy = false;
    unlock();
    button.disabled = false;
    if (button.isConnected) button.innerHTML = originalLabel;
  }
});
window.addEventListener('beforeunload', event => { if (editorSession?.dirty || studentDraftDirty) { event.preventDefault(); event.returnValue = ''; } });

async function init() {
  const path = location.pathname;
  const publicMatch = path.match(/^\/f\/([a-f0-9]{24})\/?$/);
  if (publicMatch) return loadPublic(publicMatch[1]);
  try {
    forms = await api('/api/forms');
    const id = path.match(/^\/admin\/([a-f0-9-]+)\/?$/)?.[1];
    if (id) { current = await api(`/api/forms/${id}`); editorSession = new EditorSession(current); renderEditor(); }
    else renderFormsPage();
  } catch (error) { shell(`<div class="error-state"><h1>Не удалось открыть страницу</h1><p>${esc(error.message)}</p><a class="button primary" href="/admin/forms">К списку форм</a><button class="button secondary" data-action="reload">Повторить</button></div>`); }
}
init();
