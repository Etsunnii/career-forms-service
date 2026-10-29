export function readAnswers(form, fields) {
  const data = new FormData(form);
  const answers = Object.create(null);
  for (const field of fields) answers[field.id] = field.type === 'checkbox' ? data.getAll(field.id) : data.get(field.id) ?? '';
  return answers;
}

export function hasAnswers(answers) {
  return Object.values(answers).some(value => Array.isArray(value) ? value.length > 0 : value.trim().length > 0);
}

export function saveStudentDraft(storage, slug, revision, answers) {
  try { storage.setItem(`forma-draft-${slug}`, JSON.stringify({ revision, answers })); }
  catch { /* A blocked or full browser storage must not break filling the form. */ }
}

export function clearStudentDraft(storage, slug) {
  try { storage.removeItem(`forma-draft-${slug}`); } catch { /* optional storage */ }
}

export function restoreStudentDraft(storage, slug, form, definition) {
  let saved;
  try { saved = JSON.parse(storage.getItem(`forma-draft-${slug}`)); } catch { return false; }
  if (!saved || typeof saved.answers !== 'object' || !saved.answers) return false;
  for (const field of definition.fields) {
    const value = saved.answers[field.id];
    const controls = form.querySelectorAll(`[name="${field.id}"]`);
    for (const control of controls) {
      if (field.type === 'checkbox') control.checked = Array.isArray(value) && value.includes(control.value);
      else if (field.type === 'radio') control.checked = value === control.value;
      else if (typeof value === 'string') {
        control.value = field.type === 'select' && !field.options.includes(value) ? '' : value;
      }
    }
  }
  return saved.revision !== definition.revision;
}
