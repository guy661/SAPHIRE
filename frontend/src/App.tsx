import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import DashboardDetailPage from './pages/DashboardDetailPage';
import ChatPage from './pages/ChatPage';
import DashboardSettingsPage from './pages/DashboardSettingsPage';
import MainLayout from './layouts/MainLayout';

// This component handles routes that are only accessible when a user is logged IN.
// It renders the MainLayout which contains the sidebar and header.
const ProtectedLayout = () => {
  const { user } = useAuth();
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  // The MainLayout contains an <Outlet> for the nested routes to render in.
  return <MainLayout />; 
};

// This component handles public routes (like login) that should not be seen by logged-in users.
const PublicRoute = () => {
    const { user } = useAuth();
    if (user) {
        return <Navigate to="/" replace />;
    }
    return <Outlet />;
};

function App() {
  const { user } = useAuth();

  return (
      <Routes>
        <Route element={<PublicRoute />}>
          <Route path="/login" element={<LoginPage />} />
        </Route>

        {/* All protected routes are now children of the ProtectedLayout */}
        <Route element={<ProtectedLayout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/dashboard/:id" element={<DashboardDetailPage />} />
          <Route path="/dashboard/:dashboardId/edit" element={<ChatPage />} />
          <Route path="/dashboard/:dashboardId/settings" element={<DashboardSettingsPage />} />
          {/* Add other protected routes here, e.g., /settings */}
        </Route>
        
        {/* Fallback route */}
        <Route 
          path="*"
          element={<Navigate to={user ? "/" : "/login"} replace />}
        />
      </Routes>
  );
}

export default App;
