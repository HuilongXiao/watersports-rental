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

// 请求耗时统计：记录 client 耗时并读取后端 X-Server-Timing 头，输出到 console。
// 当 localStorage['enable_tracing'] === '1' 时额外 POST 一份 summary 到 /api/_trace
// （后端还需 TRACE_REPORT_ENABLED=1 才会落日志，双重开关，默认都不上报）。
function reportTiming(
  method: string,
  path: string,
  clientMs: number,
  serverTiming: string | null,
  status: number,
) {
  const line = `${method} ${path} — client:${clientMs.toFixed(0)}ms — server ${
    serverTiming ?? 'n/a'
  } (status ${status})`
  console.log(`[timing] ${line}`)

  if (localStorage.getItem('enable_tracing') !== '1') return
  try {
    fetch('/api/_trace', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path,
        method,
        client_timing_ms: Math.round(clientMs),
        server_header: serverTiming,
        extra: { status },
      }),
    }).catch(() => {})
  } catch {
    // 上报失败不影响业务请求
  }
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
  const method = options.method ?? 'GET'
  const clientStart = performance.now()
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  reportTiming(
    method,
    path,
    performance.now() - clientStart,
    res.headers.get('X-Server-Timing'),
    res.status,
  )

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
  const clientStart = performance.now()
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  reportTiming(
    'POST',
    '/api/auth/login',
    performance.now() - clientStart,
    res.headers.get('X-Server-Timing'),
    res.status,
  )
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiError(data.detail ?? '登录失败', res.status)
  }
  return data as { status: string; user: import('./types').User }
}

export function logout() {
  return api.post('/api/auth/logout')
}
