export async function api(path, method = 'GET', body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    let response;
    try {
      response = await fetch(path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw new Error('Не удалось связаться с сервером. Введённые данные остались на экране. Попробуйте ещё раз.');
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error('Сервер вернул непонятный ответ. Проверьте, что запущена актуальная версия приложения.'); }
    if (!response.ok) throw Object.assign(new Error(data.error), { fields: data.fields, status: response.status, code: data.code });
    return data;
  } finally { clearTimeout(timeout); }
}
