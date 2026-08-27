import { useEffect, useState } from 'react';
import { Route, Routes, Navigate, useLocation } from 'react-router-dom';
import ApplicationList from './pages/ApplicationList';
import ApplicationDetail from './pages/ApplicationDetail';
import Login from './pages/Login';
import SignUp from './pages/SignUp';
import MemberSignUp from './pages/MemberSignUp';
import Layout from './components/Layout';
import CandidateLayout from './components/CandidateLayout';
import ClientLayout from './components/ClientLayout';
import { AuthProvider, useAuth } from './context/AuthContext';
import { DataProvider } from './context/DataContext';
import { CelebrationProvider } from './context/CelebrationContext';
import CandidateManagement from './pages/CandidateManagement';
import CycleManagement from './pages/CycleManagement';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Dashboard from './pages/Dashboard';
import MemberDashboard from './pages/MemberDashboard';
import DocumentGrading from './pages/DocumentGrading';
import AdminDocumentGrading from './pages/AdminDocumentGrading';
import AssignedInterviews from './pages/AssignedInterviews';
import AdminAssignedInterviews from './pages/AdminAssignedInterviews';
import InterviewInterface from './pages/InterviewInterface';
import MemberInterviewInterface from './pages/MemberInterviewInterface';
import FirstRoundInterviewInterface from './pages/FirstRoundInterviewInterface';
import FinalRoundInterviewInterface from './pages/FinalRoundInterviewInterface';
import Candidates from './pages/Candidates';
import Staging from './pages/Staging';
import Cases from './pages/Cases';
import TalentPoolPartnerNetwork from './pages/TalentPoolPartnerNetwork';
import CaseTagging from './pages/CaseTagging';
import CandidateDashboard from './pages/CandidateDashboard';
import ReviewTeams from './pages/ReviewTeams';
import UserManagement from './pages/UserManagement';
import EventManagement from './pages/EventManagement';
import CandidateEvents from './pages/CandidateEvents';
import MemberEvents from './pages/MemberEvents';
import CandidateApplications from './pages/CandidateApplications';
import CandidateGTKUC from './pages/CandidateGTKUC';
import InterviewPreparation from './pages/InterviewPreparation';
import InterviewDetail from './pages/InterviewDetail';
import CoffeeChatsPublic from './pages/CoffeeChatsPublic';
import MemberMeetingSlots from './pages/MemberMeetingSlots';
import AdminMeetingSlots from './pages/AdminMeetingSlots';
import ReleaseNotes from './pages/ReleaseNotes';
import CandidateList from './pages/CandidateList';
import CandidateDetail from './pages/CandidateDetail';
import MasterCommunications from './pages/MasterCommunications';
import Profile from './pages/Profile';
import ClientResumeLibrary from './pages/ClientResumeLibrary';
import TalentSignUp from './pages/TalentSignUp';
import VerifyEmail from './pages/VerifyEmail';
import CandidateOnboarding from './pages/CandidateOnboarding';
import TalentProfile from './pages/TalentProfile';
import NotFound from './pages/NotFound';
import apiClient from './utils/api';
import { readOnboardingRequired, cacheOnboardingRequired } from './utils/onboardingStatus';
import './styles/variables.css';
/**
 * Sends a candidate with no application on file to the onboarding module.
 *
 * Wraps candidate pages rather than living inside each one: the module exists
 * precisely because we know nothing about this person, so there is no candidate
 * page that has anything useful to show until it is done.
 */
const CandidateOnboardingGate = ({ children }) => {
  const { user } = useAuth();
  const location = useLocation();
  // Read fresh on every render rather than mirrored into state. Mirroring is
  // what made submitting the form loop: the page marks onboarding done and
  // navigates away, and a gate holding its own stale "required" would redirect
  // straight back. State here exists only to re-render once the fetch lands.
  const required = readOnboardingRequired(user?.id);
  const [, setResolved] = useState(0);

  useEffect(() => {
    if (!user?.id || readOnboardingRequired(user.id) !== null) return;

    let cancelled = false;
    apiClient
      .get('/candidate/onboarding/status')
      .then((data) => {
        if (cancelled) return;
        cacheOnboardingRequired(user.id, data.required);
        setResolved((n) => n + 1);
      })
      .catch(() => {
        // A failed check must not lock a candidate out of their own dashboard.
        // Erring towards "not required" costs an un-onboarded profile; erring
        // the other way strands everyone behind a form whenever the call fails.
        if (cancelled) return;
        cacheOnboardingRequired(user.id, false);
        setResolved((n) => n + 1);
      });

    return () => {
      cancelled = true;
    };
  }, [user?.id, location.pathname]);

  // The module itself is never gated on its own answer.
  if (location.pathname === '/onboarding') return children;

  if (required === null) return <div>Loading...</div>;
  if (required) return <Navigate to="/onboarding" replace />;
  return children;
};

// Protected Route wrapper for admin/member users
const ProtectedRoute = ({ children }) => {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div>Loading...</div>;
  }
  
  if (!user) {
    return <Navigate to="/login" />;
  }
  
  // Talent Partner Network clients have exactly one page. Without this they
  // fall through to the admin Layout below - not a data leak, since every API
  // call 403s for them, but it would show them a sidebar full of staff tooling.
  if (user.role === 'CLIENT') {
    if (location.pathname !== '/partner/resumes') {
      return <Navigate to="/partner/resumes" replace />;
    }
    return <ClientLayout>{children}</ClientLayout>;
  }

  // Self-registered talent accounts get the same treatment as clients, and for
  // the same reason. They are role USER, so without this they would fall
  // through to CandidateLayout and be handed a nav bar of Applications, Events,
  // Get To Know UC and Interview Prep - every one of which is empty for someone
  // who never applied. The page itself carries its own header and sign-out.
  if (user.isExternalTalent) {
    if (location.pathname !== '/talent/profile') {
      return <Navigate to="/talent/profile" replace />;
    }
    return children;
  }

  // Use different layouts based on user role
  if (user.role === 'USER') {
    return (
      <CandidateOnboardingGate>
        <CandidateLayout>{children}</CandidateLayout>
      </CandidateOnboardingGate>
    );
  }

  return <Layout>{children}</Layout>;
};

/** Role-appropriate landing at /; signed-out visitors go to the login page. */
const HomeRoute = () => {
  const { user, loading } = useAuth();

  if (loading) {
    return <div>Loading...</div>;
  }

  if (user?.role === 'CLIENT') {
    return <Navigate to="/partner/resumes" replace />;
  }

  // A self-registered talent account has no application to track and no
  // dashboard to land on - its profile is the whole app for them.
  if (user?.isExternalTalent) {
    return <Navigate to="/talent/profile" replace />;
  }

  if (user?.role === 'ADMIN' || user?.role === 'MEMBER') {
    return (
      <ProtectedRoute>
        {user.role === 'MEMBER' ? <MemberDashboard /> : <Dashboard />}
      </ProtectedRoute>
    );
  }

  // Recruitment is open, so there is no paused landing to show: a candidate
  // lands on their dashboard and a signed-out visitor on the login page.
  if (user) {
    return (
      <ProtectedRoute>
        <CandidateDashboard />
      </ProtectedRoute>
    );
  }

  return <Navigate to="/login" replace />;
};

const AppRoutes = () => {
  const { user } = useAuth();
  
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/member-signup" element={<MemberSignUp />} />
      {/* Public talent-network signup, open to any UCLA student. The verify
          page is public too: the emailed link usually opens in whichever
          browser the mail client hands it to, not the one that signed up. */}
      <Route path="/talent/signup" element={<TalentSignUp />} />
      <Route path="/talent/verify" element={<VerifyEmail audience="talent" />} />
      {/* The candidate half of the same link. Public for the same reason: the
          email is usually opened in a browser that has no session. */}
      <Route path="/verify-email" element={<VerifyEmail audience="candidate" />} />
      
      <Route path="/" element={<HomeRoute />} />
      
      {/* Protected Routes - Different content based on user role */}
      <Route path="/dashboard" element={
        <ProtectedRoute>
          {user?.role === 'USER' ? <CandidateDashboard /> : 
           user?.role === 'MEMBER' ? <MemberDashboard /> : <Dashboard />}
        </ProtectedRoute>
      } />

      {/* Onboarding for a candidate with no application on file. Inside
          ProtectedRoute so the gate above can let it through unchallenged. */}
      <Route path="/onboarding" element={
        <ProtectedRoute>
          <CandidateOnboarding />
        </ProtectedRoute>
      } />

      {/* Admin/Member Routes */}
      <Route path="/candidate-management" element={<Navigate to="/application-list" />} />
      <Route
        path="/cycles"
        element={
          <ProtectedRoute>
            <CycleManagement />
          </ProtectedRoute>
        }
      />
      
      <Route
        path="/application-list"
        element={
          <ProtectedRoute>
            <ApplicationList />
          </ProtectedRoute>
        }
      />
      
      <Route
        path="/application/:id"
        element={
          <ProtectedRoute>
            <ApplicationDetail />
          </ProtectedRoute>
        }
      />
      
      <Route
        path="/talent-pool"
        element={
          <ProtectedRoute>
            <TalentPoolPartnerNetwork />
          </ProtectedRoute>
        }
      />

      <Route
        path="/review-teams"
        element={
          <ProtectedRoute>
            <ReviewTeams />
          </ProtectedRoute>
        }
      />

      <Route
        path="/cases"
        element={
          <ProtectedRoute>
            <Cases />
          </ProtectedRoute>
        }
      />

      <Route
        path="/cases/:id/tags"
        element={
          <ProtectedRoute>
            <CaseTagging />
          </ProtectedRoute>
        }
      />
      
      <Route
        path="/user-management"
        element={
          <ProtectedRoute>
            <UserManagement />
          </ProtectedRoute>
        }
      />

      <Route
        path="/profile"
        element={
          <ProtectedRoute>
            {user?.role === 'USER' ? <Navigate to="/" /> : <Profile />}
          </ProtectedRoute>
        }
      />
      
      <Route
        path="/events"
        element={
          <ProtectedRoute>
            {user?.role === 'USER' ? <CandidateEvents /> : 
             user?.role === 'MEMBER' ? <MemberEvents /> : <EventManagement />}
          </ProtectedRoute>
        }
      />
      
      {/* Member-specific routes */}
      <Route
        path="/document-grading"
        element={
          <ProtectedRoute>
            <DocumentGrading />
          </ProtectedRoute>
        }
      />
      
      {/* Admin-specific routes */}
      <Route
        path="/admin-document-grading"
        element={
          <ProtectedRoute>
            <AdminDocumentGrading />
          </ProtectedRoute>
        }
      />
      
      <Route
        path="/assigned-interviews"
        element={
          <ProtectedRoute>
            <AssignedInterviews />
          </ProtectedRoute>
        }
      />
      
      <Route
        path="/candidates"
        element={
          <ProtectedRoute>
            <Candidates />
          </ProtectedRoute>
        }
      />
      
      <Route
        path="/candidate-list"
        element={
          <ProtectedRoute>
            <CandidateList />
          </ProtectedRoute>
        }
      />
      
      <Route
        path="/candidate-detail/:id"
        element={
          <ProtectedRoute>
            <CandidateDetail />
          </ProtectedRoute>
        }
      />
      
      <Route
        path="/staging"
        element={
          <ProtectedRoute>
            <Staging />
          </ProtectedRoute>
        }
      />
      
      <Route
        path="/interviews/:id"
        element={
          <ProtectedRoute>
            <InterviewDetail />
          </ProtectedRoute>
        }
      />
      
      <Route
        path="/admin/assigned-interviews"
        element={
          <ProtectedRoute>
            <AdminAssignedInterviews />
          </ProtectedRoute>
        }
      />
      
      
      <Route
        path="/admin/interview-interface"
        element={
          <ProtectedRoute>
            <InterviewInterface />
          </ProtectedRoute>
        }
      />
      
      <Route
        path="/member/interview-interface"
        element={
          <ProtectedRoute>
            <MemberInterviewInterface />
          </ProtectedRoute>
        }
      />
      
      <Route
        path="/member/first-round-interview"
        element={
          <ProtectedRoute>
            <FirstRoundInterviewInterface />
          </ProtectedRoute>
        }
      />
      
      <Route
        path="/admin/final-round-interview"
        element={
          <ProtectedRoute>
            <FinalRoundInterviewInterface />
          </ProtectedRoute>
        }
      />
      
      <Route
        path="/member/final-round-interview"
        element={
          <ProtectedRoute>
            <FinalRoundInterviewInterface />
          </ProtectedRoute>
        }
      />
      
      {/* Candidate-specific routes */}
      <Route
        path="/applications"
        element={
          <ProtectedRoute>
            <CandidateApplications />
          </ProtectedRoute>
        }
      />
      
      <Route
        path="/interview-prep"
        element={
          <ProtectedRoute>
            <InterviewPreparation />
          </ProtectedRoute>
        }
      />

      <Route
        path="/get-to-know-uc"
        element={
          <ProtectedRoute>
            <CandidateGTKUC />
          </ProtectedRoute>
        }
      />
      
      {/* External talent portal - one page, its own shell, no nav chrome:
          these accounts have nothing else in the app to navigate to. */}
      <Route
        path="/talent/profile"
        element={
          <ProtectedRoute>
            <TalentProfile />
          </ProtectedRoute>
        }
      />

      {/* Talent Partner Network client portal - one page, its own shell */}
      <Route
        path="/partner/resumes"
        element={
          <ProtectedRoute>
            <ClientResumeLibrary />
          </ProtectedRoute>
        }
      />

      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      {/* Public meeting signup page */}
      <Route path="/meet" element={<CoffeeChatsPublic />} />
      {/* Member meeting slots management */}
      <Route
        path="/member/meeting-slots"
        element={
          <ProtectedRoute>
            <MemberMeetingSlots />
          </ProtectedRoute>
        }
      />
      {/* Admin GTKUC slot + attendance management */}
      <Route
        path="/admin/meeting-slots"
        element={
          <ProtectedRoute>
            <AdminMeetingSlots />
          </ProtectedRoute>
        }
      />

      {/* Admin release notes */}
      <Route
        path="/admin/release-notes"
        element={
          <ProtectedRoute>
            <ReleaseNotes />
          </ProtectedRoute>
        }
      />

      {/* Master Communications */}
      <Route
        path="/master-communications"
        element={
          <ProtectedRoute>
            <MasterCommunications />
          </ProtectedRoute>
        }
      />

      {/* 404 - Page Not Found */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
};

export default function App() {
  // Apply global Montserrat Light for body
  useEffect(() => {
    document.body.style.fontFamily = 'Montserrat, -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif';
    document.body.style.fontWeight = '300';
  }, []);

  return (
    <AuthProvider>
      <DataProvider>
        <CelebrationProvider>
          <AppRoutes />
        </CelebrationProvider>
      </DataProvider>
    </AuthProvider>
  );
}