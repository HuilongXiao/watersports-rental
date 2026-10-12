import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, setActiveGroupId, login as apiLogin, logout as apiLogout } from './api'
import type { Group, User } from './types'

interface AuthState {
  user: User | null
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
  activeGroup: string | null
  activeGroupName: string | null
  setActiveGroup: (id: string | null, name: string | null) => void
  groups: Group[]
}

const AuthContext = createContext<AuthState>(null as unknown as AuthState)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeGroup, setActiveGroup] = useState<string | null>(null)
  const [activeGroupName, setActiveGroupName] = useState<string | null>(null)
  const [groups, setGroups] = useState<Group[]>([])

  const refresh = async () => {
    try {
      const me = await api.get<User>('/api/auth/me')
      setUser(me)
      // Only superuser uses the group switcher; reset state for other roles.
      if (me.role !== 'superuser') {
        setActiveGroup(null)
        setActiveGroupName(null)
        setActiveGroupId(null)
        setGroups([])
      }
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    const onUnauthorized = () => setUser(null)
    window.addEventListener('app:unauthorized', onUnauthorized)
    return () => window.removeEventListener('app:unauthorized', onUnauthorized)
  }, [])

  // When the user becomes a superuser, fetch the groups list for the switcher.
  useEffect(() => {
    if (user?.role !== 'superuser') {
      return
    }
    let cancelled = false
    api
      .get<Group[]>('/api/groups')
      .then((list) => {
        if (!cancelled) {
          setGroups(list)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGroups([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [user?.role])

  const handleSetActiveGroup = (id: string | null, name: string | null) => {
    setActiveGroup(id)
    setActiveGroupName(name)
    setActiveGroupId(id)
  }

  const login = async (username: string, password: string) => {
    const result = await apiLogin(username, password)
    setUser(result.user)
    // Reset switcher state on every fresh login.
    setActiveGroup(null)
    setActiveGroupName(null)
    setActiveGroupId(null)
  }

  const logout = async () => {
    await apiLogout()
    setUser(null)
    setActiveGroup(null)
    setActiveGroupName(null)
    setActiveGroupId(null)
    setGroups([])
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        logout,
        refresh,
        activeGroup,
        activeGroupName,
        setActiveGroup: handleSetActiveGroup,
        groups,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext)
}
