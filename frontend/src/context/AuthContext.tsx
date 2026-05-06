import { createContext, useState, useContext, ReactNode, useEffect } from 'react';
import { loginUser as apiLogin, logoutUser as apiLogout, registerUser as apiRegister, getCurrentUser as apiGetCurrentUser, updateUserSettings as apiUpdateUserSettings } from '../services/api';
import { CircularProgress, Box } from '@mui/material';

// Define the shape of the context
interface AuthContextType {
  user: any; // In a real app, you'd have a proper User type
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, language: string, email: string) => Promise<void>;
  updateEmail: (email: string) => Promise<void>;
  logout: () => void;
  isLoading: boolean;
}

// Create the context with a default value
const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Create the provider component
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const userData = await apiGetCurrentUser();
        setUser(userData);
      } catch (error) {
        // Not authenticated or error
        setUser(null);
      } finally {
        setIsLoading(false);
      }
    };

    checkAuth();
  }, []);

  const login = async (username: string, password: string) => {
    const userData = await apiLogin(username, password);
    setUser(userData);
  };

  const register = async (username: string, password: string, language: string, email: string) => {
    const userData = await apiRegister(username, password, language, email);
    setUser(userData);
  };

  const updateEmail = async (email: string) => {
    const userData = await apiUpdateUserSettings({ email });
    setUser(userData);
  };

  const logout = async () => {
    await apiLogout();
    setUser(null);
  };

  const value = { user, login, register, updateEmail, logout, isLoading };

  if (isLoading) {
      return (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
              <CircularProgress />
          </Box>
      );
  }

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
