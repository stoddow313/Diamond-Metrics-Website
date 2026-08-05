import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import LandingPage from './pages/LandingPage';
import HowItWorksPage from './pages/HowItWorksPage';
import SampleProfilePage from './pages/SampleProfilePage';
import ProgramsPage from './pages/ProgramsPage';
import LoginPage from './pages/LoginPage';
import ClaimPage from './pages/ClaimPage';
import ClaimStaffPage from './pages/ClaimStaffPage';
import SignupInfoPage from './pages/SignupInfoPage';
import { StaffLayout, StaffHomePage, StaffTeamPage, StaffTournamentPage } from './pages/staff/StaffPages';
import AdminLayout from './components/admin/AdminLayout';
import AdminPlayersPage from './pages/admin/AdminPlayersPage';
import AdminPlayerEditorPage from './pages/admin/AdminPlayerEditorPage';
import AdminTeamsPage from './pages/admin/AdminTeamsPage';
import AdminTeamEditorPage from './pages/admin/AdminTeamEditorPage';
import AdminTournamentsPage from './pages/admin/AdminTournamentsPage';
import AdminTournamentEditorPage from './pages/admin/AdminTournamentEditorPage';
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

const HOME_BY_ROLE = { admin: '/admin', player: '/me', staff: '/staff' };

function RoleRoute({ role, children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={HOME_BY_ROLE[user.role] || '/login'} replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/how-it-works" element={<HowItWorksPage />} />
      <Route path="/sample-profile" element={<SampleProfilePage />} />
      <Route path="/programs" element={<ProgramsPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupInfoPage />} />
      <Route path="/claim/:token" element={<ClaimPage />} />
      <Route path="/claim-staff/:token" element={<ClaimStaffPage />} />

      {/* Public, shareable player profiles */}
      <Route path="/p/:slug" element={<PublicProfilePage />} />

      {/* Player portal: claimed accounts see their own profile in isolation */}
      <Route
        path="/me"
        element={
          <RoleRoute role="player">
            <PublicProfilePage portal />
          </RoleRoute>
        }
      />

      {/* Staff portal: coaches/directors see assigned teams and tournaments */}
      <Route
        path="/staff"
        element={
          <RoleRoute role="staff">
            <StaffLayout />
          </RoleRoute>
        }
      >
        <Route index element={<StaffHomePage />} />
        <Route path="teams/:teamId" element={<StaffTeamPage />} />
        <Route path="tournaments/:tournamentId" element={<StaffTournamentPage />} />
      </Route>

      {/* Admin: player profile + stat management */}
      <Route
        path="/admin"
        element={
          <RoleRoute role="admin">
            <AdminLayout />
          </RoleRoute>
        }
      >
        <Route index element={<AdminPlayersPage />} />
        <Route path="players/:playerId" element={<AdminPlayerEditorPage />} />
        <Route path="teams" element={<AdminTeamsPage />} />
        <Route path="teams/:teamId" element={<AdminTeamEditorPage />} />
        <Route path="tournaments" element={<AdminTournamentsPage />} />
        <Route path="tournaments/:tournamentId" element={<AdminTournamentEditorPage />} />
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
