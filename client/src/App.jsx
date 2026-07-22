import { useEffect } from 'react';
import { Route, Routes, Navigate } from 'react-router-dom';
import ApplicationList from './pages/ApplicationList';
import ApplicationDetail from './pages/ApplicationDetail';
import Login from './pages/Login';
import SignUp from './pages/SignUp';
import MemberSignUp from './pages/MemberSignUp';
import Layout from './components/Layout';
import CandidateLayout from './components/CandidateLayout';
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
import CandidateList from './pages/CandidateList';
import CandidateDetail from './pages/CandidateDetail';
import NotFound from './pages/NotFound';
import PausedLanding from './pages/PausedLanding';
import './styles/variables.css';
// Protected Route wrapper for admin/member users
const ProtectedRoute = ({ children }) => {
  const { user, loading } = useAuth();
  
  if (loading) {
    return <div>Loading...</div>;
  }
  
  if (!user) {
    return <Navigate to="/login" />;
  }
  
  // Use different layouts based on user role
  if (user.role === 'USER') {
    return <CandidateLayout>{children}</CandidateLayout>;
  }
  
  return <Layout>{children}</Layout>;
};

/** Paused landing for public & candidates; admins/members see their dashboard at /. */
const HomeRoute = () => {
  const { user, loading } = useAuth();

  if (loading) {
    return <div>Loading...</div>;
  }

  if (user?.role === 'ADMIN' || user?.role === 'MEMBER') {
    return (
      <ProtectedRoute>
        {user.role === 'MEMBER' ? <MemberDashboard /> : <Dashboard />}
      </ProtectedRoute>
    );
  }

  return <PausedLanding />;
};

const AppRoutes = () => {
  const { user } = useAuth();
  
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/member-signup" element={<MemberSignUp />} />
      
      <Route path="/" element={<HomeRoute />} />
      
      {/* Protected Routes - Different content based on user role */}
      <Route path="/dashboard" element={
        <ProtectedRoute>
          {user?.role === 'USER' ? <CandidateDashboard /> : 
           user?.role === 'MEMBER' ? <MemberDashboard /> : <Dashboard />}
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

      {/* 404 - Page Not Found */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
};

export default function App() {
  // Apply global Montserrat Light for body, Montserrat Bold for headings
  useEffect(() => {
    document.body.style.fontFamily = 'Montserrat, -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif';
    document.body.style.fontWeight = '300'; // Montserrat Light as default body weight
    document.body.style.backgroundColor = '#ffffff'; // Clean white background
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