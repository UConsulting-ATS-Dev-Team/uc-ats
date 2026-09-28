import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Renders its children for admins only. Sits inside ProtectedRoute, which has
 * already dealt with signed-out, partner and talent accounts.
 *
 * A member is sent to `memberFallback`, the member-side page for the same job
 * (the admin application queue's is /candidates), so a stale bookmark or link
 * lands somewhere useful. Anyone else goes home.
 */
const AdminOnly = ({ children, memberFallback = '/' }) => {
  const { user, loading } = useAuth();

  if (loading) return <div>Loading...</div>;
  if (user?.role === 'ADMIN') return children;
  if (user?.role === 'MEMBER') return <Navigate to={memberFallback} replace />;
  return <Navigate to="/" replace />;
};

export default AdminOnly;
