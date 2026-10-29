import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

// Single-process transaction queue. A failed write never replaces in-memory data.
export async function createStore(filename) {
  await mkdir(dirname(filename), { recursive: true });
  let state;
  try {
    state = JSON.parse(await readFile(filename, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.forms)) throw new Error('Неверный формат хранилища');
    // Existing databases keep their forms and responses. The new draft counter starts at 1.
    for (const form of state.forms) form.draftVersion ??= 1;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { version: 1, forms: [] };
  }
  let queue = Promise.resolve();
  return {
    read: () => structuredClone(state),
    update(operation) {
      const transaction = queue.then(async () => {
        const next = structuredClone(state);
        const result = operation(next);
        await writeFile(`${filename}.tmp`, JSON.stringify(next, null, 2), 'utf8');
        await rename(`${filename}.tmp`, filename);
        state = next;
        return structuredClone(result);
      });
      queue = transaction.catch(() => {});
      return transaction;
    },
  };
}
