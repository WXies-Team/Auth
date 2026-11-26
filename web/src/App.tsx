import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import { AppShell, RequireAdmin, RequireAuth, RequireSuper } from '@/components/layout/app-shell'
import { Skeleton } from '@/components/ui/skeleton'

const LoginPage = lazy(() => import('@/pages/login'))
const RegisterPage = lazy(() => import('@/pages/register'))
const InvitePage = lazy(() => import('@/pages/invite'))
const SetupPasswordPage = lazy(() => import('@/pages/setup-password'))
const DeleteCancelPage = lazy(() => import('@/pages/delete-cancel'))
const AuthorizePage = lazy(() => import('@/pages/authorize'))
const OAuthResumePage = lazy(() => import('@/pages/oauth-resume'))
const ConsolePage = lazy(() => import('@/pages/console'))
const SessionsPage = lazy(() => import('@/pages/sessions'))
const PasskeysPage = lazy(() => import('@/pages/passkeys'))
const SecurityPage = lazy(() => import('@/pages/security'))
const AccountPage = lazy(() => import('@/pages/account'))
const ConnectionsPage = lazy(() => import('@/pages/connections'))
const ActivityPage = lazy(() => import('@/pages/activity'))
const AdminUsersPage = lazy(() => import('@/pages/admin/users'))
const AdminUserDetailPage = lazy(() => import('@/pages/admin/user-detail'))
const AdminAccessPage = lazy(() => import('@/pages/admin/access'))
const AdminSessionsPage = lazy(() => import('@/pages/admin/sessions'))
const AdminAuditPage = lazy(() => import('@/pages/admin/audit'))
const AdminConfigPage = lazy(() => import('@/pages/admin/config'))
const AdminAIPage = lazy(() => import('@/pages/admin/ai'))
const AdminSystemPage = lazy(() => import('@/pages/admin/system'))
const NotFoundPage = lazy(() => import('@/pages/not-found'))

// 公开页（登录/注册/邀请…）的懒加载兜底：按 AuthLayout 的形状画（品牌 + 一张
// 表单卡），不再用「一条标题 + 两个大灰块」这种和登录页无关的形状。
// 控制台内部页的懒加载由 AppShell 里的局部 Suspense 接住，外壳不会消失。
function AuthPageSkeleton() {
  return (
    <div className="auth-bg flex min-h-dvh flex-col items-center justify-center p-4" aria-hidden="true">
      <div className="mb-6 flex items-center gap-2">
        <img src="/favicon.svg" alt="" className="size-8" />
        <span className="text-lg font-semibold tracking-tight">Auth</span>
      </div>
      <div className="bg-card w-full max-w-sm space-y-4 rounded-xl border p-6">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-3.5 w-48" />
        <div className="space-y-2 pt-2">
          <Skeleton className="h-3.5 w-10" />
          <Skeleton className="h-9 w-full" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-10" />
          <Skeleton className="h-9 w-full" />
        </div>
        <Skeleton className="h-9 w-full" />
      </div>
    </div>
  )
}

export default function App() {
  return (
    <Suspense fallback={<AuthPageSkeleton />}>
      <Routes>
        <Route path="/web/login" element={<LoginPage />} />
        <Route path="/web/register" element={<RegisterPage />} />
        <Route path="/web/invite" element={<InvitePage />} />
        <Route path="/web/setup-password" element={<SetupPasswordPage />} />
        <Route path="/web/delete-cancel" element={<DeleteCancelPage />} />
        <Route path="/oauth/authorize" element={<AuthorizePage />} />
        <Route path="/oauth/resume" element={<OAuthResumePage />} />

        <Route element={<RequireAuth />}>
          <Route element={<AppShell />}>
            <Route path="/web/console" element={<ConsolePage />} />
            <Route path="/web/console/sessions" element={<SessionsPage />} />
            <Route path="/web/console/passkeys" element={<PasskeysPage />} />
            <Route path="/web/console/security" element={<SecurityPage />} />
            <Route path="/web/console/account" element={<AccountPage />} />
            <Route path="/web/console/connections" element={<ConnectionsPage />} />
            <Route path="/web/console/activity" element={<ActivityPage />} />

            <Route element={<RequireAdmin />}>
              <Route path="/web/admin/access" element={<AdminAccessPage />} />
              <Route path="/web/admin/sessions" element={<AdminSessionsPage />} />
              <Route path="/web/admin/audit" element={<AdminAuditPage />} />
              <Route path="/web/admin/ai-usage" element={<AdminAIPage />} />
              <Route element={<RequireSuper />}>
                <Route path="/web/admin" element={<AdminUsersPage />} />
                <Route path="/web/admin/users/:uid" element={<AdminUserDetailPage />} />
                <Route path="/web/admin/config" element={<AdminConfigPage />} />
                <Route path="/web/admin/system" element={<AdminSystemPage />} />
              </Route>
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  )
}
