export type ApiErrorBody = { message: string; reason?: string }

export type WebSession = {
  uid: number
  email: string
  role: 'user' | 'admin' | 'super'
  csrfToken: string
  totpEnabled: boolean
  passkeyCount: number
  passwordSet: boolean
  isRoot: boolean
}

export type LoginResponse = {
  status?: '2fa_required' | string
  loginToken?: string
  methods?: string[]
  token?: string
  email?: string
  mustChangePassword?: boolean
  deletePendingCancelled?: boolean
}

export type SessionInfo = {
  id: string
  app: string
  device: string
  ip: string
  ipRegion: string
  createdAt: number
  lastSeenAt: number
  expiresAt?: number
  idleExpiresAt?: number
  current: boolean
}

export type Passkey = {
  id: number
  name: string
  createdAt: number
  lastUsedAt: number
  current: boolean
  backupEligible: boolean
  backupState: boolean
}

export type TOTPStatus = {
  enabled: boolean
  createdAt: number
  recoveryTotal?: number
  recoveryLeft?: number
}

export type TOTPSetup = { secret: string; otpauthUri: string; qrPng: string }

export type Profile = {
  nickname: string
  avatarColor: number
  avatarImage: string | null
  updatedAt: number
  loginNotify: boolean
}

export type Page<T> = { items: T[]; total: number }

export type UserBanInfo = { app: string; untilMs: number; reason?: string }

export type AdminInvite = {
  id: string
  email: string
  app: string
  createdAt: number
  expiresAt: number
  state: 'pending' | 'accepted' | 'revoked' | 'expired'
}

export type AdminUser = {
  uid: number
  email: string
  role: 'user' | 'admin' | 'super'
  createdAt: number
  totpEnabled: boolean
  passkeyCount: number
  scopeCount: number
  nickname: string
  avatarColor: number
  hasAvatar: boolean
  ban?: UserBanInfo
  isRoot: boolean
}

export type BanInfo = { app: string; until: number; reason: string }

export type AdminUserDetail = AdminUser & {
  hasPassword: boolean
  scopes: string[]
  sessions: SessionInfo[]
  passkeys: Passkey[]
  bans: BanInfo[]
  avatarImage: string
}

export type ProjectMember = { uid: number; email: string }

export type AdminProject = {
  app: string
  name: string
  restricted: boolean
  mfaRequired: boolean
  allowedDomains: string[]
  sessionDays: number
  members: ProjectMember[]
  admins: ProjectMember[]
  clientId: string
  redirectUris: string[] | null
}

export type AdminSession = {
  id: string
  uid: number
  email: string
  app: string
  device: string
  ip: string
  ipRegion: string
  createdAt: number
  lastSeenAt: number
  expiresAt?: number
  idleExpiresAt?: number
  nickname: string
  avatarColor: number
}

export type SessionAggregate = { name: string; count: number }

export type SessionPage = {
  items: AdminSession[]
  total: number
  totalUsers: number
  apps: SessionAggregate[]
  regions: SessionAggregate[]
}

export type AuditRow = {
  id: number
  ts: number
  actorUid: number
  actorEmail: string
  action: string
  result: 'ok' | 'fail'
  targetUid: number
  ip: string
  userAgent: string
  detail?: Record<string, string>
}

export type ConfigItem = {
  key: string
  secret: boolean
  configured: boolean
  value?: string
  hint?: string
}

export type AIUsageDay = { date: string; count: number }
export type AIUsageUser = {
  uid: number
  email: string
  today: number
  range: number
  share: number
  limitToday: number
}
export type AIUsage = {
  today: number
  yesterday: number
  activeToday: number
  global: { used: number; limit: number } | null
  defaultsUsed: number
  days: AIUsageDay[]
  users: AIUsageUser[]
}

export type ConnectedApp = {
  app: string
  name: string
  scopes: string[]
  createdAt: number
  lastUsedAt: number
}

export type SystemStatus = {
  version: string
  startedAt: number
  uptimeSeconds: number
  dbOK: boolean
  dbLatencyMs: number
  mailConfigured: boolean
  jwtConfigured: boolean
  passkeysConfigured: boolean
  counts: { users: number; sessions: number; passkeys: number; totp: number }
}

export type InviteInfo = { email: string; app: string; appName: string }
export type SetupInfo = { email: string }

export type OAuthInfo = {
  tx: string
  app: string
  appName: string
  redirectHost: string
  email: string
  scopes: string[]
}

export type TrustedDevice = {
  id: number
  label: string
  createdAt: number
  lastUsedAt: number
  expiresAt: number
  current: boolean
}
