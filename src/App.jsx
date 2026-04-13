import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';
import AppShell from './components/app/AppShell';
import AdminShell from './components/app/AdminShell';
import DashboardPage from './pages/DashboardPage';
import RosterPage from './pages/RosterPage';
import FilmRoomPage from './pages/FilmRoomPage';
import GameDetailPage from './pages/GameDetailPage';
import PlayerDetailPage from './pages/PlayerDetailPage';
import AdminFilmQueuePage from './pages/admin/AdminFilmQueuePage';
import AdminReviewPage from './pages/admin/AdminReviewPage';

function ProtectedRoute({ children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function AdminRoute({ children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'admin') return <Navigate to="/app" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<Navigate to="/login" replace />} />
      <Route
        path="/app"
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="roster" element={<RosterPage />} />
        <Route path="roster/:playerId" element={<PlayerDetailPage />} />
        <Route path="film-room" element={<FilmRoomPage />} />
        <Route path="film-room/:gameId" element={<GameDetailPage />} />
      </Route>
      <Route
        path="/admin"
        element={
          <AdminRoute>
            <AdminShell />
          </AdminRoute>
        }
      >
        <Route index element={<AdminFilmQueuePage />} />
        <Route path="review/:filmId" element={<AdminReviewPage />} />
      </Route>
    </Routes>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
