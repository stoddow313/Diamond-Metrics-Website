import { createContext, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken } from '../lib/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(() => !!getToken());

  // Validate any stored token against the API on load.
  useEffect(() => {
    if (!getToken()) return;
    api.me()
      .then(({ admin }) => setUser(admin))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(email, password) {
    const { token, admin } = await api.login(email, password);
    setToken(token);
    setUser(admin);
    return admin;
  }

  async function logout() {
    try { await api.logout(); } catch { /* token may already be invalid */ }
    setToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- standard context hook pairing
export function useAuth() {
  return useContext(AuthContext);
}
