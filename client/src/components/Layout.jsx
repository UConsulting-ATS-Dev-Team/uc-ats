import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  HomeIcon, 
  DocumentTextIcon, 
  UserGroupIcon, 
  ArrowRightOnRectangleIcon,
  Bars3Icon,
  XMarkIcon,
  ClipboardDocumentListIcon,
  ChartBarIcon,
  UserIcon,
  Cog6ToothIcon,
  CalendarDaysIcon,
  UserGroupIcon as UserGroupIcon2,
  ChatBubbleLeftRightIcon,
  ChatBubbleOvalLeftEllipsisIcon,
  LightBulbIcon,
  PresentationChartBarIcon,
  NewspaperIcon,
  EnvelopeIcon
} from '@heroicons/react/24/outline';
import UConsultingLogo from './UConsultingLogo';
import MessageAdminModal from './MessageAdminModal';
import FeatureRequestModal from './FeatureRequestModal';
import MemberAvatar from './MemberAvatar';
import ThemeToggle from './ThemeToggle';
import '../styles/Layout.css';

const FEATURE_REQUEST_NAV = {
  name: 'Request a feature',
  icon: LightBulbIcon,
  isFeatureRequest: true,
};

const Layout = ({ children }) => {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [messageModalOpen, setMessageModalOpen] = useState(false);
  const [featureRequestOpen, setFeatureRequestOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const navigation = [
    { name: 'Dashboard', href: '/', icon: HomeIcon },
    ...(user?.role === 'MEMBER' ? [
      { name: 'Document Grading', href: '/document-grading', icon: DocumentTextIcon },
      { name: 'Events', href: '/events', icon: CalendarDaysIcon },
      { name: 'Assigned Interviews', href: '/assigned-interviews', icon: UserGroupIcon2 },
      { name: 'Applications', href: '/candidates', icon: DocumentTextIcon },
      { name: 'Get to Know UC', href: '/member/meeting-slots', icon: ChatBubbleLeftRightIcon },
      { name: 'Message an Admin', href: '#', icon: ChatBubbleOvalLeftEllipsisIcon, isAction: true },
    ] : user?.role === 'ADMIN' ? [
      { name: 'Applications', href: '/application-list', icon: DocumentTextIcon },
      { name: 'Candidates', href: '/candidate-list', icon: UserGroupIcon },
      { name: 'Document Grading', href: '/admin-document-grading', icon: DocumentTextIcon },
      { name: 'Review Teams', href: '/review-teams', icon: UserGroupIcon },
      { name: 'Cycle Management', href: '/cycles', icon: ClipboardDocumentListIcon },
      { name: 'Assigned Interviews', href: '/admin/assigned-interviews', icon: UserGroupIcon2 },
      { name: 'Cases', href: '/cases', icon: PresentationChartBarIcon },
      { name: 'Recruitment Resources', href: '/interview-prep', icon: ClipboardDocumentListIcon },
      { name: 'Event Management', href: '/events', icon: CalendarDaysIcon },
      { name: 'Get to Know UC', href: '/admin/meeting-slots', icon: ChatBubbleLeftRightIcon },
      { name: 'Staging', href: '/staging', icon: UserGroupIcon },
      { name: 'User Management', href: '/user-management', icon: UserIcon },
      { name: 'Master Communications', href: '/master-communications', icon: EnvelopeIcon },
      { name: "What's new", href: '/admin/release-notes', icon: NewspaperIcon },
      FEATURE_REQUEST_NAV,
    ] : [
      { name: 'Applications', href: '/application-list', icon: DocumentTextIcon },
      { name: 'Review Teams', href: '/review-teams', icon: UserGroupIcon },
      FEATURE_REQUEST_NAV,
    ])
  ];

  const isCurrentPath = (path) => location.pathname === path;

  return (
    <div className="layout-container">
      {/* Top Navigation Bar */}
      <nav className="top-nav">
        <div className="nav-container">
          <div className="nav-content">
            <div className="nav-left">
              {/* Mobile menu button */}
              <button
                type="button"
                className="mobile-menu-btn"
                onClick={() => setSidebarOpen(!sidebarOpen)}
              >
                {sidebarOpen ? (
                  <XMarkIcon style={{ width: '1.5rem', height: '1.5rem' }} />
                ) : (
                  <Bars3Icon style={{ width: '1.5rem', height: '1.5rem' }} />
                )}
              </button>
              
              {/* Logo and title */}
              <Link to="/" className="logo-section">
                <UConsultingLogo size="medium" />
                <div className="logo-subtitle">
                  <p>Application Tracking System</p>
                </div>
              </Link>
            </div>

            {/* Right side - User info and logout */}
            <div className="nav-right">
              <Link to="/profile" className="profile-link" aria-label="Edit profile">
                <MemberAvatar member={user} size={32} />
                <div className="user-info">
                  <p className="user-name">{user?.fullName}</p>
                  <p className="user-role">
                    {user?.role === 'MEMBER' ? 'UC MEMBER' : user?.role}
                  </p>
                </div>
              </Link>
              <ThemeToggle />
              <button
                onClick={handleLogout}
                className="logout-btn"
              >
                <ArrowRightOnRectangleIcon className="logout-icon" />
                Logout
              </button>
            </div>
          </div>
        </div>
      </nav>

      <div className="main-layout">
        {/* Sidebar */}
        <div className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
          <div className="sidebar-content">
            
            
            <nav className="sidebar-nav">
              {navigation.map((item) => {
                const Icon = item.icon;
                const current = isCurrentPath(item.href);
                
                if (item.isFeatureRequest) {
                  return (
                    <button
                      key={item.name}
                      type="button"
                      onClick={() => {
                        setFeatureRequestOpen(true);
                        setSidebarOpen(false);
                      }}
                      className="nav-item"
                    >
                      <Icon className="nav-icon" />
                      {item.name}
                    </button>
                  );
                }

                if (item.isAction) {
                  return (
                    <button
                      key={item.name}
                      type="button"
                      onClick={() => {
                        setMessageModalOpen(true);
                        setSidebarOpen(false);
                      }}
                      className="nav-item"
                    >
                      <Icon className="nav-icon" />
                      {item.name}
                    </button>
                  );
                }
                
                return (
                  <Link
                    key={item.name}
                    to={item.href}
                    className={`nav-item ${current ? 'active' : ''}`}
                    onClick={() => setSidebarOpen(false)}
                  >
                    <Icon className="nav-icon" />
                    {item.name}
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>

        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <div 
            className="sidebar-overlay"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Main content */}
        <div className="content-area">
          <main className="main-content">
            <div className="content-container">
              {children}
            </div>
          </main>
        </div>
      </div>

      {/* Message Admin Modal */}
      <MessageAdminModal 
        open={messageModalOpen} 
        onClose={() => setMessageModalOpen(false)} 
      />
      <FeatureRequestModal
        open={featureRequestOpen}
        onClose={() => setFeatureRequestOpen(false)}
      />
    </div>
  );
};

export default Layout; 