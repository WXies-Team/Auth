import { Route, Routes } from 'react-router-dom'
import { AppShell, RequireAdmin, RequireAuth, RequireSuper } from '@/components/layout/app-shell'

import LoginPage from '@/pages/login'
import RegisterPage from '@/pages/register'
import InvitePage from '@/pages/invite'
import SetupPasswordPage from '@/pages/setup-password'
import DeleteCancelPage from '@/pages/delete-cancel'
import AuthorizePage from '@/pages/authorize'
import OAuthResumePage from '@/pages/oauth-resume'
import ConsolePage from '@/pages/console'
import SessionsPage from '@/pages/sessions'
import PasskeysPage from '@/pages/passkeys'
import SecurityPage from '@/pages/security'
import AccountPage from '@/pages/account'
import ConnectionsPage from '@/pages/connections'
import ActivityPage from '@/pages/activity'
import AdminUsersPage from '@/pages/admin/users'
import AdminUserDetailPage from '@/pages/admin/user-detail'
import AdminAccessPage from '@/pages/admin/access'
import AdminSessionsPage from '@/pages/admin/sessions'
import AdminAuditPage from '@/pages/admin/audit'
import AdminConfigPage from '@/pages/admin/config'
import AdminAIPage from '@/pages/admin/ai'
import AdminSystemPage from '@/pages/admin/system'
import NotFoundPage from '@/pages/not-found'


export default function App() {
  return (
    
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
    
  )
}
