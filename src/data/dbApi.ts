// Read-only client for the local FloWMS services, reached through the vite dev
// proxy (see vite.config.ts). Every call is a GET; the viewer never writes.
// pyro list endpoints: /api/<service>/v0/<resource>?field=v&field__in=a,b
// &recordsPerPage=n&page=n → { statusCode, errors[], payload: { data[], pagination? } }.

export interface DbCredentials {
  token: string;       // FloWMS access token (JWT)
  fingerprint: string; // the atFingerprint cookie issued with it
}

export class DbApiError extends Error {
  status: number;
  code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface PyroError { code?: string; message?: string }
interface PyroResponse<T> {
  statusCode?: number;
  errors?: PyroError[];
  payload?: { data?: T[] | null; pagination?: { lastPage?: number | null; totalRecords?: number } } | null;
}

const PAGE = 1000;

// Session-only storage: survives a reload of this tab, gone when the tab closes.
const TOKEN_KEY = 'wv.db.token';
const FP_KEY = 'wv.db.fingerprint';

export function readStoredCredentials(): DbCredentials | null {
  try {
    const token = sessionStorage.getItem(TOKEN_KEY);
    const fingerprint = sessionStorage.getItem(FP_KEY);
    return token && fingerprint ? { token, fingerprint } : null;
  } catch {
    return null;
  }
}

export function storeCredentials(c: DbCredentials | null): void {
  try {
    if (c) {
      sessionStorage.setItem(TOKEN_KEY, c.token);
      sessionStorage.setItem(FP_KEY, c.fingerprint);
    } else {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(FP_KEY);
    }
  } catch {
    /* storage unavailable: credentials live for this page only */
  }
}

function authHeaders(creds: DbCredentials | null): Record<string, string> {
  if (!creds) return {};
  return { Authorization: `Bearer ${creds.token}`, 'X-At-Fingerprint': creds.fingerprint };
}

async function getPage<T>(url: string, creds: DbCredentials | null): Promise<PyroResponse<T>> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json', ...authHeaders(creds) } });
  } catch (e) {
    throw new DbApiError(0, `Could not reach the dev server (${(e as Error).message}).`);
  }
  const text = await res.text();
  let body: PyroResponse<T> | null = null;
  try {
    body = JSON.parse(text) as PyroResponse<T>;
  } catch {
    body = null;
  }
  if (!body) {
    if (res.status === 404) {
      throw new DbApiError(404, 'The service route is not proxied — DB mode needs the vite dev server (npm run dev) with the local FloWMS services running.');
    }
    throw new DbApiError(res.status, `Unexpected ${res.status} response (${text.slice(0, 80) || 'empty body'}). Is the service running?`);
  }
  if (!res.ok || (body.statusCode && body.statusCode >= 400)) {
    const err = body.errors?.[0];
    const status = res.status || body.statusCode || 500;
    const hint = status === 401 ? 'Token or fingerprint rejected — generate a fresh pair in Postman.' : '';
    throw new DbApiError(status, [err?.message, hint].filter(Boolean).join(' ') || `HTTP ${status}`, err?.code ?? null);
  }
  return body;
}

// Every record of a list endpoint, following pyro's pagination.
export async function getAll<T>(
  service: 'locations' | 'pods' | 'products' | 'jobs',
  resource: string,
  params: Record<string, string | number | boolean>,
  creds: DbCredentials | null,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) q.set(k, String(v));
    q.set('recordsPerPage', String(PAGE));
    q.set('page', String(page));
    const body = await getPage<T>(`/api/${service}/v0/${resource}?${q.toString()}`, creds);
    out.push(...(body.payload?.data ?? []));
    const last = body.payload?.pagination?.lastPage ?? 1;
    if (page >= (last ?? 1)) break;
  }
  return out;
}

// `field__in` lists in batches, so a long id list never overruns a URL.
export async function getByIds<T>(
  service: 'locations' | 'pods' | 'products' | 'jobs',
  resource: string,
  field: string,
  ids: (number | string)[],
  creds: DbCredentials | null,
  extra: Record<string, string | number | boolean> = {},
  chunk = 40,
): Promise<T[]> {
  const uniq = [...new Set(ids)];
  const out: T[] = [];
  for (let i = 0; i < uniq.length; i += chunk) {
    const part = uniq.slice(i, i + chunk);
    out.push(...(await getAll<T>(service, resource, { ...extra, [`${field}__in`]: part.join(',') }, creds)));
  }
  return out;
}

// Cheapest authenticated call: proves the token + fingerprint (or the proxy's own
// server-side credentials) before the full load starts.
export async function probeCredentials(creds: DbCredentials | null): Promise<void> {
  await getPage('/api/locations/v0/segment-definitions?recordsPerPage=1&page=1', creds);
}
