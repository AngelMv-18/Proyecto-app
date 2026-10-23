export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>) { super(message); }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method, credentials: 'same-origin', headers: { 'x-requested-with': 'nova', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'network', 'Sin conexión con el servidor. Revisa tu internet e inténtalo de nuevo.');
  }
  const text = await res.text();
  let data: any = undefined;
  try { data = text ? JSON.parse(text) : undefined; } catch { /* no JSON */ }
  if (!res.ok) {
    const e = data?.error;
    if (res.status === 401 && !url.includes('/auth/')) window.dispatchEvent(new Event('nova:unauthorized'));
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Error ${res.status}`, e?.fields);
  }
  return data as T;
}

export const api = {
  get: <T = any>(u: string) => req<T>('GET', u),
  post: <T = any>(u: string, b: unknown = {}) => req<T>('POST', u, b),
  put: <T = any>(u: string, b: unknown) => req<T>('PUT', u, b),
  patch: <T = any>(u: string, b: unknown) => req<T>('PATCH', u, b),
  del: <T = any>(u: string) => req<T>('DELETE', u),
  upload: async (u: string, file: File) => {
    const res = await fetch(u, { method: 'PUT', credentials: 'same-origin', headers: { 'x-requested-with': 'nova', 'content-type': file.type }, body: file });
    if (!res.ok) { const d = await res.json().catch(() => null); throw new ApiError(res.status, d?.error?.code ?? 'error', d?.error?.message ?? 'No se pudo subir el archivo'); }
  },
};

export const qs = (o: Record<string, any>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
