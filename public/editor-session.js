// The UI locks inputs during requests. The edit counter is a second guard against
// an asynchronous response replacing changes made after the request started.
export class EditorSession {
  constructor(form) {
    this.form = form;
    this.dirty = false;
    this.editNumber = 0;
  }

  changed() {
    this.editNumber++;
    this.dirty = true;
  }

  async save(request) {
    const sentEditNumber = this.editNumber;
    const snapshot = structuredClone(this.form.draft);
    const result = await request(`/api/forms/${this.form.id}`, 'PUT', {
      ...snapshot, draftVersion: this.form.draftVersion,
    });
    const newerDraft = this.form.draft;
    Object.assign(this.form, result);
    this.dirty = this.editNumber !== sentEditNumber;
    if (this.dirty) this.form.draft = newerDraft;
    return !this.dirty;
  }
}
