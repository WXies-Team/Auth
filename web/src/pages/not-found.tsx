import { Link } from 'react-router-dom'
import { Compass } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'

export default function NotFoundPage() {
  const { t } = useI18n()
  return (
    <div className="auth-bg flex min-h-dvh flex-col items-center justify-center p-6 text-center">
      <div className="bg-muted mb-4 flex size-14 items-center justify-center rounded-full">
        <Compass className="size-6" />
      </div>
      <h1 className="text-2xl font-semibold">{t('notfound.title')}</h1>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm">{t('notfound.description')}</p>
      <div className="mt-5 flex gap-2">
        <Button asChild>
          <Link to="/web/console">{t('notfound.back')}</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link to="/web/login">去登录</Link>
        </Button>
      </div>
    </div>
  )
}
