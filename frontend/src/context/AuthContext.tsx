import { createContext, useState, useContext, ReactNode } from 'react';
import { loginUser as apiLogin, logoutUser as apiLogout } from '../services/api';

// Define the shape of the context
interface AuthContextType {
  user: any; // In a real app, you'd have a proper User type
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

// Create the context with a default value
const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Create the provider component
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<any>(null);

  const login = async (username: string, password: string) => {
    const userData = await apiLogin(username, password);
    setUser(userData);
    // In a real app, you might also store a token in localStorage
  };

  const logout = async () => {
    await apiLogout();
    setUser(null);
    // In a real app, you would also clear any stored tokens
  };

  const value = { user, login, logout };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// Create a custom hook for easy access to the context
export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
