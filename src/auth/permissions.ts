export const PERMISSIONS = [
  { key: 'projects.view', label: 'View projects', group: 'Projects' },
  { key: 'projects.edit', label: 'Edit projects and models', group: 'Projects' },
  { key: 'viewer', label: '3D viewer', group: 'Projects' },
  { key: 'drawings', label: 'Drawings', group: 'Design' },
  { key: 'panels', label: 'Panels, groups, and status', group: 'Design' },
  { key: 'estimate.view', label: 'View estimates', group: 'Estimate' },
  { key: 'estimate.edit', label: 'Edit estimates', group: 'Estimate' },
  { key: 'logistics', label: 'Logistics', group: 'Delivery' },
  { key: 'production', label: 'CNC and production', group: 'Delivery' },
  { key: 'alerts', label: 'Alerts', group: 'Workspace' },
  { key: 'admin', label: 'Administration', group: 'Workspace' },
] as const

export type PermissionKey = (typeof PERMISSIONS)[number]['key']

export const WORKSPACE_ROLES = [
  'DESIGNER',
  'ESTIMATOR',
  'LOGISTICS',
  'PRODUCTION',
  'ADMIN',
  'VIEWER',
] as const

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  DESIGNER: 'Designer',
  ESTIMATOR: 'Estimator',
  LOGISTICS: 'Logistics',
  PRODUCTION: 'Production',
  ADMIN: 'Admin',
  VIEWER: 'Viewer',
}

const ALL_KEYS = PERMISSIONS.map((item) => item.key)

const ROLE_DEFAULTS: Record<WorkspaceRole, PermissionKey[]> = {
  DESIGNER: ['projects.view', 'projects.edit', 'viewer', 'drawings', 'panels', 'alerts'],
  ESTIMATOR: ['projects.view', 'drawings', 'estimate.view', 'estimate.edit', 'alerts'],
  LOGISTICS: ['projects.view', 'logistics', 'alerts'],
  PRODUCTION: ['projects.view', 'viewer', 'panels', 'production', 'alerts'],
  VIEWER: ['projects.view', 'viewer', 'drawings', 'alerts'],
  ADMIN: ALL_KEYS,
}

const KNOWN = new Set<string>(ALL_KEYS)

export function canonicalRole(role: string | null | undefined): WorkspaceRole {
  const value = (role || '').toUpperCase()
  if (value === 'MANAGER') return 'DESIGNER'
  if ((WORKSPACE_ROLES as readonly string[]).includes(value)) return value as WorkspaceRole
  return 'VIEWER'
}

export function defaultPermissions(role: string | null | undefined): PermissionKey[] {
  return [...ROLE_DEFAULTS[canonicalRole(role)]]
}

function expand(keys: PermissionKey[]): PermissionKey[] {
  const set = new Set(keys)
  if (set.has('projects.edit') || set.has('viewer') || set.has('drawings') || set.has('panels') || set.has('logistics') || set.has('production') || set.has('estimate.view') || set.has('estimate.edit')) {
    set.add('projects.view')
  }
  if (set.has('estimate.edit')) set.add('estimate.view')
  return ALL_KEYS.filter((key) => set.has(key))
}

/** A missing list means “use the role defaults”. An explicit list is kept, including unchecked items. Admin always has every page. */
export function resolvePermissions(role: string | null | undefined, stored: unknown): PermissionKey[] {
  if (canonicalRole(role) === 'ADMIN') return [...ALL_KEYS]
  if (!Array.isArray(stored)) return defaultPermissions(role)
  const picked = stored.filter((key): key is PermissionKey => typeof key === 'string' && KNOWN.has(key))
  return expand(picked)
}

export function isWorkspaceRole(role: string): boolean {
  return (WORKSPACE_ROLES as readonly string[]).includes(role.toUpperCase()) || role.toUpperCase() === 'MANAGER'
}
