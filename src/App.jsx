import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';
import AdminLayout from './components/admin/AdminLayout';
import AdminPlayersPage from './pages/admin/AdminPlayersPage';
import AdminPlayerEditorPage from './pages/admin/AdminPlayerEditorPage';
import PublicProfilePage from './pages/PublicProfilePage';

/* ── SIDELINED (pre-BE demo app) ─────────────────────────────────────────
 * The original dummy coach dashboard (/app) and film-review admin (/admin)
 * are parked while we stand up the real backend + admin player tooling.
 * The page/shell files remain in src/pages and src/components/app.
 * To restore, re-enable these imports and the routes commented out below.
 *
 * import AppShell from './components/app/AppShell';
 * import AdminShell from './components/app/AdminShell';
 * import DashboardPage from './pages/DashboardPage';
 * import RosterPage from './pages/RosterPage';
 * import FilmRoomPage from './pages/FilmRoomPage';
 * import GameDetailPage from './pages/GameDetailPage';
 * import PlayerDetailPage from './pages/PlayerDetailPage';
 * import AdminFilmQueuePage from './pages/admin/AdminFilmQueuePage';
 * import AdminReviewPage from './pages/admin/AdminReviewPage';
 * ──────────────────────────────────────────────────────────────────────── */

function AdminRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<Navigate to="/login" replace />} />

      {/* Public, shareable player profiles */}
      <Route path="/p/:slug" element={<PublicProfilePage />} />

      {/* Admin: player profile + stat management */}
      <Route
        path="/admin"
        element={
          <AdminRoute>
            <AdminLayout />
          </AdminRoute>
        }
      >
        <Route index element={<AdminPlayersPage />} />
        <Route path="players/:playerId" element={<AdminPlayerEditorPage />} />
      </Route>

      {/* ── SIDELINED routes (see note above) ──────────────────────────
      <Route path="/app" element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
        <Route index element={<DashboardPage />} />
        <Route path="roster" element={<RosterPage />} />
        <Route path="roster/:playerId" element={<PlayerDetailPage />} />
        <Route path="film-room" element={<FilmRoomPage />} />
        <Route path="film-room/:gameId" element={<GameDetailPage />} />
      </Route>
      <Route path="/admin-film" element={<AdminRoute><AdminShell /></AdminRoute>}>
        <Route index element={<AdminFilmQueuePage />} />
        <Route path="review/:filmId" element={<AdminReviewPage />} />
      </Route>
      ─────────────────────────────────────────────────────────────────── */}
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
