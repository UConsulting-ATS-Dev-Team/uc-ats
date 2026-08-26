import { createContext, useContext, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../utils/api';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  // Set token in API client whenever it changes
  useEffect(() => {
    if (token) {
      apiClient.setToken(token);
    }
  }, [token]);

  // Verify token on mount and set user
  useEffect(() => {
    const verifyToken = async () => {
      if (!token) {
        setLoading(false);
        return;
      }

      try {
        const data = await apiClient.get('/auth/verify');
        setUser(data.user);
      } catch (error) {
        console.error('Token verification failed:', error);
        localStorage.removeItem('token');
        setToken(null);
        setUser(null);
      }

      setLoading(false);
    };

    verifyToken();
  }, [token]);

  const login = async (email, password) => {
    try {
      const data = await apiClient.post('/auth/login', { email, password });
      
      localStorage.setItem('token', data.token);
      setToken(data.token);
      setUser(data.user);
      // data.user is returned so the caller can route by role without waiting
      // for context state to settle. Login.jsx is the only caller.
      return { success: true, user: data.user };

    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  const register = async (userData) => {
    try {
      const data = await apiClient.post('/auth/register', userData);

      localStorage.setItem('token', data.token);
      setToken(data.token);
      setUser(data.user);
      return { success: true };

    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  // Public talent-portal signup. Separate from register() because the endpoint
  // is: /auth/register creates a Candidate row for an applicant tracking an
  // application, which is not what a self-registered UCLA student is.
  const registerExternal = async (userData) => {
    try {
      const data = await apiClient.post('/auth/register-external', userData);

      // A session is issued before the email is verified so the portal can show
      // a real "check your inbox" state rather than a dead end.
      localStorage.setItem('token', data.token);
      setToken(data.token);
      setUser(data.user);
      return { success: true, user: data.user };

    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  const registerMember = async (userData) => {
    try {
      const data = await apiClient.post('/auth/register-member', userData);

      localStorage.setItem('token', data.token);
      setToken(data.token);
      setUser(data.user);
      return { success: true };

    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  const logout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
    apiClient.setToken(null);
    navigate('/login');
  };

  const updateUser = (updates) => {
    setUser((prev) => (prev ? { ...prev, ...updates } : updates));
  };

  const refreshUser = async () => {
    if (!token) return;
    try {
      const data = await apiClient.get('/auth/verify');
      setUser(data.user);
    } catch (error) {
      console.error('Failed to refresh user:', error);
    }
  };

  const value = {
    user,
    token,
    loading,
    login,
    register,
    registerExternal,
    registerMember,
    logout,
    updateUser,
    refreshUser
  };

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}; 