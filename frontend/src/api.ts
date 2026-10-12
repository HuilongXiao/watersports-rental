export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

type Json = Record<string, unknown>

let activeGroupId: string | null = null

export function setActiveGroupId(id: string | null) {
  activeGroupId = id
}

export function getActiveGroupId() {
  return activeGroupId
}

async function request<T>(
  path: string,
  options: { method?: string; body?: Json } = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  if (options.body) {
    headers['Content-Type'] = 'application/json'
  }
  if (activeGroupId) {
    headers['X-Active-Group'] = activeGroupId
  }
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    // Let the router react to the lost session.
    window.dispatchEvent(new CustomEvent('app:unauthorized'))
  }

  let data: unknown = null
  const text = await res.text()
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }

  if (!res.ok) {
    const detail =
      (data as { detail?: string } | null)?.detail ?? `请求失败（${res.status}）`
    throw new ApiError(detail, res.status)
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: Json) => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: Json) => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: Json) => request<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

export async function login(username: string, password: string) {
  const form = new URLSearchParams()
  form.set('username', username)
  form.set('password', password)
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiError(data.detail ?? '登录失败', res.status)
  }
  return data as { status: string; user: import('./types').User }
}

export function logout() {
  return api.post('/api/auth/logout')
}
