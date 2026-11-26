import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { api } from './api'
import type { LoginResponse } from './types'

type Ceremony = { publicKey: unknown; ceremonyId: number }

export async function loginWithPasskey(): Promise<LoginResponse> {
  const opts = await api.post<Ceremony>('/webauthn/login/options', {})
  const response = await startAuthentication({ optionsJSON: opts.publicKey as never })
  return api.post<LoginResponse>('/webauthn/login/finish', { ceremonyId: opts.ceremonyId, response })
}

export async function registerPasskey(): Promise<void> {
  const opts = await api.post<Ceremony>('/webauthn/register/options', {})
  const response = await startRegistration({ optionsJSON: opts.publicKey as never })
  await api.post('/webauthn/register/finish', { ceremonyId: opts.ceremonyId, response })
}

export async function reauthWithPasskey(): Promise<void> {
  const opts = await api.post<Ceremony>('/web/reauth/webauthn/options', {}, { reauth: false })
  const response = await startAuthentication({ optionsJSON: opts.publicKey as never })
  await api.post(
    '/web/reauth/webauthn/finish',
    { ceremonyId: opts.ceremonyId, response },
    { reauth: false },
  )
}
