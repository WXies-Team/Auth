import type { ApiErrorBody } from './types'

export class ApiError extends Error {
  status: number
  reason?: string
  /** OAuth 错误回执里的应用身份（其它接口为空） */
  app?: string
  appName?: string
  redirectHost?: string
  constructor(
    message: string,
    status: number,
    reason?: string,
    extra?: { app?: string; appName?: string; redirectHost?: string },
  ) {
    super(message)
    this.status = status
    this.reason = reason
    this.app = extra?.app
    this.appName = extra?.appName
    this.redirectHost = extra?.redirectHost
  }
}

let reauthHandler: (() => Promise<boolean>) | null = null

export function setReauthHandler(fn: (() => Promise<boolean>) | null) {
  reauthHandler = fn
}

export function readCookie(name: string): string {
  const prefix = `${name}=`
  for (const part of document.cookie.split('; ')) {
    if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length))
  }
  return ''
}

export function csrfToken(): string {
  return readCookie('__Host-auth_web_csrf')
}

type Options = Omit<RequestInit, 'body'> & {
  body?: unknown
  // 401 时是否尝试全局重新验证后重试一次
  reauth?: boolean
}

async function request<T>(path: string, opts: Options = {}, retried = false): Promise<T> {
  const { body, reauth = true, headers, ...rest } = opts
  const method = (rest.method ?? 'GET').toUpperCase()
  const h = new Headers(headers)
  if (body !== undefined) h.set('Content-Type', 'application/json')
  if (method !== 'GET' && method !== 'HEAD') {
    const token = csrfToken()
    if (token) h.set('X-CSRF-Token', token)
  }

  let res: Response
  try {
    res = await fetch(path, {
      credentials: 'include',
      ...rest,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError('网络连接中断，请检查网络后重试', 0)
  }

  if (!res.ok) {
    let message = res.status === 429 ? '操作过于频繁，请稍后再试' : `请求失败（${res.status}）`
    let reason: string | undefined
    let app: string | undefined
    let appName: string | undefined
    let redirectHost: string | undefined
    try {
      const data = (await res.json()) as ApiErrorBody
      if (data.message) message = data.message
      reason = data.reason
      app = data.app
      appName = data.appName
      redirectHost = data.redirectHost
    } catch {
      // 非 JSON 错误体，保留兜底文案
    }
    if (res.status === 401) {
      const reauthRequired = reason === 'reauth_required' || message.includes('重新验证')
      if (reauthRequired) {
        if (reauth && reauthHandler && !retried) {
          if (await reauthHandler()) return request<T>(path, opts, true)
        }
      } else {
        const authPath =
          path.startsWith('/web/login') ||
          path.startsWith('/web/session') ||
          path.startsWith('/auth/') ||
          path.startsWith('/webauthn/login')
        if (reason === 'session_expired' && !authPath) {
          const next = encodeURIComponent(location.pathname + location.search)
          location.assign(`/web/login?next=${next}`)
        }
      }
    }
    throw new ApiError(message, res.status, reason, { app, appName, redirectHost })
  }

  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

export const api = {
  get: <T>(path: string, opts?: Options) => request<T>(path, { ...opts, method: 'GET' }),
  post: <T>(path: string, body?: unknown, opts?: Options) =>
    request<T>(path, { ...opts, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, opts?: Options) =>
    request<T>(path, { ...opts, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, opts?: Options) =>
    request<T>(path, { ...opts, method: 'PATCH', body }),
  del: <T>(path: string, body?: unknown, opts?: Options) =>
    request<T>(path, { ...opts, method: 'DELETE', body }),
}
