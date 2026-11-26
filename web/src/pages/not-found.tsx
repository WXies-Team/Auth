import { Link } from 'react-router-dom'
import { Compass } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function NotFoundPage() {
  return (
    <div className="auth-bg flex min-h-dvh flex-col items-center justify-center p-6 text-center">
      <div className="bg-muted mb-4 flex size-14 items-center justify-center rounded-full">
        <Compass className="size-6" />
      </div>
      <h1 className="text-2xl font-semibold">页面不存在</h1>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm">
        链接可能已过期，或者你输入的地址有误。
      </p>
      <div className="mt-5 flex gap-2">
        <Button asChild>
          <Link to="/web/console">回到控制台</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link to="/web/login">去登录</Link>
        </Button>
      </div>
    </div>
  )
}
