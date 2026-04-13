import { createContext, useContext, useState } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('dm_user');
    return stored ? JSON.parse(stored) : null;
  });

  function login(email, password) {
    if (email === 'admin@diamondmetrics.ai' && password === 'admin') {
      const adminUser = { email: 'admin@diamondmetrics.ai', name: 'Admin', role: 'admin' };
      localStorage.setItem('dm_user', JSON.stringify(adminUser));
      setUser(adminUser);
      return 'admin';
    }

    if (email === 'user@diamondmetrics.ai' && password === 'diamonduser') {
      const coachUser = { email: 'user@diamondmetrics.ai', name: 'Will Stoddard', teamName: 'Westlake Thunder', role: 'coach' };
      localStorage.setItem('dm_user', JSON.stringify(coachUser));
      setUser(coachUser);
      return 'coach';
    }

    return null;
  }

  function logout() {
    localStorage.removeItem('dm_user');
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
