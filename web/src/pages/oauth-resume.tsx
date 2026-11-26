import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { api } from '@/lib/api'
import type { OAuthInfo } from '@/lib/types'
import { ConsentCard } from './authorize'

export default function OAuthResumePage() {
  const [params] = useSearchParams()
  const tx = params.get('tx') ?? ''
  const { data, isLoading, error } = useQuery({
    queryKey: ['oauth-resume', tx],
    queryFn: () => api.get<OAuthInfo>(`/oauth/resume?format=json&tx=${encodeURIComponent(tx)}`, { reauth: false }),
    retry: false,
    enabled: !!tx,
  })

  return (
    <ConsentCard
      data={data}
      isLoading={isLoading}
      error={error as Error | null}
      next={`/oauth/resume?tx=${encodeURIComponent(tx)}`}
    />
  )
}
