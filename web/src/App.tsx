import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import { AppShell, RequireAdmin, RequireAuth, RequireSuper } from '@/components/layout/app-shell'
import { Skeleton } from '@/components/ui/skeleton'

const LoginPage = lazy(() => import('@/pages/login'))
const InvitePage = lazy(() => import('@/pages/invite'))
const SetupPasswordPage = lazy(() => import('@/pages/setup-password'))
const AuthorizePage = lazy(() => import('@/pages/authorize'))
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

function Loading() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-3 p-6">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  )
}

export default function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/web/login" element={<LoginPage />} />
        <Route path="/web/invite" element={<InvitePage />} />
        <Route path="/web/setup-password" element={<SetupPasswordPage />} />
        <Route path="/oauth/authorize" element={<AuthorizePage />} />

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
