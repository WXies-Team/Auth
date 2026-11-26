import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import type { Passkey, Profile, SessionInfo, TOTPStatus } from './types'

export function useSessions() {
  return useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.get<{ sessions: SessionInfo[] }>('/api/sessions'),
  })
}

export function usePasskeys() {
  return useQuery({
    queryKey: ['passkeys'],
    queryFn: () => api.get<Passkey[]>('/api/passkeys'),
  })
}

export function useTotp() {
  return useQuery({
    queryKey: ['totp'],
    queryFn: () => api.get<TOTPStatus>('/api/totp'),
  })
}

export function useProfile() {
  return useQuery({
    queryKey: ['profile'],
    queryFn: () => api.get<Profile>('/api/profile'),
  })
}
