import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import LandingPage from './pages/LandingPage';
import HowItWorksPage from './pages/HowItWorksPage';
import SampleProfilePage from './pages/SampleProfilePage';
import PricingPage from './pages/PricingPage';
import ProgramsPage from './pages/ProgramsPage';
import LoginPage from './pages/LoginPage';
import ClaimPage from './pages/ClaimPage';
import ClaimStaffPage from './pages/ClaimStaffPage';
import SignupInfoPage from './pages/SignupInfoPage';
import { StaffLayout, StaffHomePage, StaffTeamPage, StaffTournamentPage } from './pages/staff/StaffPages';
import { CommandLayout, ProductionQueuePage, NewJobPage, JobDetailPage } from './pages/command/CommandPages';
import FeedViewerPage from './pages/command/FeedViewerPage';
import RadarQueuePage from './pages/command/RadarQueuePage';
import AdminLayout from './components/admin/AdminLayout';
import AdminPlayersPage from './pages/admin/AdminPlayersPage';
import AdminPlayerEditorPage from './pages/admin/AdminPlayerEditorPage';
import AdminTeamsPage from './pages/admin/AdminTeamsPage';
import AdminSeasonsPage from './pages/admin/AdminSeasonsPage';
import AdminTeamEditorPage from './pages/admin/AdminTeamEditorPage';
import AdminTournamentsPage from './pages/admin/AdminTournamentsPage';
import AdminTournamentEditorPage from './pages/admin/AdminTournamentEditorPage';
import AdminImportsPage from './pages/admin/AdminImportsPage';
import PublicProfilePage from './pages/PublicProfilePage';
import TeamDashboardPage from './pages/TeamDashboardPage';
import TournamentDashboardPage from './pages/TournamentDashboardPage';
import BlogPage from './pages/BlogPage';
import BaseballFilmingGuidePage from './pages/BaseballFilmingGuidePage';
import YouthBaseballVideoAnalysisPage from './pages/YouthBaseballVideoAnalysisPage';

const HOME_BY_ROLE = { admin: '/admin', analyst: '/command', reviewer: '/command', player: '/me', staff: '/staff' };

function RoleRoute({ role, children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={HOME_BY_ROLE[user.role] || '/login'} replace />;
  return children;
}

// Internal-only surfaces (Command): any of admin | analyst | reviewer.
function InternalRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (!['admin', 'analyst', 'reviewer'].includes(user.role)) {
    return <Navigate to={HOME_BY_ROLE[user.role] || '/login'} replace />;
  }
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/how-it-works" element={<HowItWorksPage />} />
      <Route path="/sample-profile" element={<SampleProfilePage />} />
      <Route path="/pricing" element={<PricingPage />} />
      <Route path="/programs" element={<ProgramsPage />} />
      <Route path="/blog" element={<BlogPage />} />
      <Route path="/blog/how-to-record-baseball-game-video-analysis" element={<BaseballFilmingGuidePage />} />
      <Route path="/blog/why-youth-baseball-video-analysis-matters"element={<YouthBaseballVideoAnalysisPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupInfoPage />} />
      <Route path="/claim/:token" element={<ClaimPage />} />
      <Route path="/claim-staff/:token" element={<ClaimStaffPage />} />
      <Route path="/p/:slug" element={<PublicProfilePage />} />
      <Route path="/teams/:slug" element={<TeamDashboardPage />} />
      <Route path="/tournaments/:slug" element={<TournamentDashboardPage />} />
      <Route path="/me" element={<RoleRoute role="player"><PublicProfilePage portal /></RoleRoute>} />
      <Route path="/staff" element={<RoleRoute role="staff"><StaffLayout /></RoleRoute>}>
        <Route index element={<StaffHomePage />} />
        <Route path="teams/:teamId" element={<StaffTeamPage />} />
        <Route path="tournaments/:tournamentId" element={<StaffTournamentPage />} />
      </Route>
      <Route path="/command" element={<InternalRoute><CommandLayout /></InternalRoute>}>
        <Route index element={<ProductionQueuePage />} />
        <Route path="new" element={<NewJobPage />} />
        <Route path="jobs/:jobId" element={<JobDetailPage />} />
        <Route path="feeds/:feedId" element={<FeedViewerPage />} />
        <Route path="jobs/:jobId/radar" element={<RadarQueuePage />} />
      </Route>
      <Route path="/admin" element={<RoleRoute role="admin"><AdminLayout /></RoleRoute>}>
        <Route index element={<AdminPlayersPage />} />
        <Route path="players/:playerId" element={<AdminPlayerEditorPage />} />
        <Route path="teams" element={<AdminTeamsPage />} />
        <Route path="teams/:teamId" element={<AdminTeamEditorPage />} />
        <Route path="seasons" element={<AdminSeasonsPage />} />
        <Route path="tournaments" element={<AdminTournamentsPage />} />
        <Route path="tournaments/:tournamentId" element={<AdminTournamentEditorPage />} />
        <Route path="imports" element={<AdminImportsPage />} />
      </Route>
    </Routes>
  );
}

function App() {
  return <BrowserRouter><AuthProvider><AppRoutes /></AuthProvider></BrowserRouter>;
}

export default App;
