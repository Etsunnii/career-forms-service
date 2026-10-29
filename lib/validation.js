export class HttpError extends Error {
  constructor(status, message, fields, code) {
    super(message);
    this.status = status;
    this.fields = fields;
    this.code = code;
  }
}

export const types = ['text', 'email', 'textarea', 'number', 'select', 'radio', 'checkbox'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value, max, name, required = false) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) {
    throw new HttpError(400, `Проверьте поле «${name}» (максимум ${max} символов).`);
  }
  return value.trim();
}

export function validateDefinition(body, publishing = false) {
  if (!object(body)) throw new HttpError(400, 'Неверный формат формы.');
  const title = text(body.title, 160, 'Название', true);
  const description = text(body.description ?? '', 3000, 'Описание');
  if (!Array.isArray(body.fields) || body.fields.length > 40 || (publishing && !body.fields.length)) {
    throw new HttpError(400, 'Добавьте от 1 до 40 вопросов перед публикацией.');
  }
  const ids = new Set();
  const fields = body.fields.map(field => {
    if (!object(field) || !types.includes(field.type) || typeof field.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(field.id) || ids.has(field.id)) {
      throw new HttpError(400, 'Неверный тип или идентификатор вопроса.');
    }
    ids.add(field.id);
    const result = {
      id: field.id,
      type: field.type,
      label: text(field.label, 240, 'Текст вопроса', true),
      required: field.required === true,
    };
    if (['select', 'radio', 'checkbox'].includes(field.type)) {
      if (!Array.isArray(field.options) || field.options.length < 1 || field.options.length > 30) throw new HttpError(400, 'У вопроса должно быть от 1 до 30 вариантов.');
      result.options = field.options.map(option => text(option, 160, 'Вариант ответа', true));
      if (new Set(result.options).size !== result.options.length) throw new HttpError(400, 'Варианты ответа не должны повторяться.');
    }
    return result;
  });
  return { title, description, fields };
}

export function validateAnswers(fields, input) {
  if (!object(input)) throw new HttpError(400, 'Неверный формат ответов.');
  const answers = Object.create(null);
  const errors = Object.create(null);
  for (const field of fields) {
    const value = Object.hasOwn(input, field.id) ? input[field.id] : undefined;
    if (field.type === 'checkbox') {
      if (value !== undefined && (!Array.isArray(value) || value.some(item => !field.options.includes(item)) || new Set(value).size !== value.length)) {
        errors[field.id] = 'Выберите варианты из списка.';
      } else if (field.required && !value?.length) {
        errors[field.id] = 'Выберите хотя бы один вариант.';
      } else answers[field.id] = value ?? [];
      continue;
    }
    if (value !== undefined && typeof value !== 'string') {
      errors[field.id] = 'Введите текстовый ответ.';
      continue;
    }
    const answer = (value ?? '').trim();
    const max = field.type === 'textarea' ? 5000 : 500;
    if (field.required && !answer) errors[field.id] = 'Заполните обязательное поле.';
    else if (answer.length > max) errors[field.id] = `Максимум ${max} символов.`;
    else if (answer && field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answer)) errors[field.id] = 'Введите корректный email.';
    else if (answer && field.type === 'number' && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(answer) || !Number.isFinite(Number(answer)))) errors[field.id] = 'Введите число.';
    else if (answer && ['select', 'radio'].includes(field.type) && !field.options.includes(answer)) errors[field.id] = 'Выберите вариант из списка.';
    else answers[field.id] = answer;
  }
  if (Object.keys(errors).length) throw new HttpError(400, 'Проверьте ответы на вопросы.', errors);
  return answers;
}
