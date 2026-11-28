import { Link } from 'react-router-dom'
import { FileQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { AuthLayout } from '@/components/layout/app-shell'
import { useI18n } from '@/lib/i18n'

export default function NotFoundPage() {
  const { t } = useI18n()
  return (
    <AuthLayout>
      <Card>
        <CardContent className="flex flex-col items-center gap-3 px-4 py-8 text-center sm:px-6">
          <div className="bg-muted flex size-14 items-center justify-center rounded-full">
            <FileQuestion className="size-6" />
          </div>
          <h1 className="text-2xl font-semibold">{t('notfound.title')}</h1>
          <p className="text-muted-foreground max-w-sm text-sm">{t('notfound.description')}</p>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <Button asChild>
              <Link to="/web/console">{t('notfound.back')}</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/web/login">去登录</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </AuthLayout>
  )
}
