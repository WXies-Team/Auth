import { Toaster as SonnerToaster } from 'sonner'
import { useTheme } from '@/lib/theme'

export function Toaster() {
  const { theme } = useTheme()
  return (
    <SonnerToaster
      theme={theme}
      position="top-center"
      richColors
      closeButton
      toastOptions={{ duration: 4000 }}
    />
  )
}
