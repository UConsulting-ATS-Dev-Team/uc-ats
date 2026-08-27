import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  HomeIcon, 
  DocumentTextIcon, 
  CalendarDaysIcon,
  ArrowRightOnRectangleIcon,
  Bars3Icon,
  XMarkIcon,
  AcademicCapIcon,
  LightBulbIcon,
  UserGroupIcon,
  PencilSquareIcon,
} from '@heroicons/react/24/outline';
import UConsultingLogo from './UConsultingLogo';
import FeatureRequestModal from './FeatureRequestModal';
import ThemeToggle from './ThemeToggle';
import '../styles/CandidateLayout.css';

const FEATURE_REQUEST_NAV = {
  name: 'Request a feature',
  icon: LightBulbIcon,
  isFeatureRequest: true,
};

const CandidateLayout = ({ children }) => {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [featureRequestOpen, setFeatureRequestOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const navigation = [
    { name: 'Dashboard', href: '/', icon: HomeIcon },
    { name: 'Applications', href: '/applications', icon: DocumentTextIcon },
    { name: 'Applicant Information', href: '/applicant-information', icon: PencilSquareIcon },
    { name: 'Events', href: '/events', icon: CalendarDaysIcon },
    { name: 'Get to Know UC', href: '/get-to-know-uc', icon: UserGroupIcon },
    { name: 'Recruitment Resources', href: '/interview-prep', icon: AcademicCapIcon },
    FEATURE_REQUEST_NAV,
  ];

  const isCurrentPath = (path) => location.pathname === path;

  return (
    <div className="candidate-layout-container">
      {/* Top Navigation Bar */}
      <nav className="candidate-top-nav">
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
              <div className="logo-section">
                <UConsultingLogo size="medium" />
                <div className="logo-subtitle">
                  <p>Application Tracking System</p>
                </div>
              </div>
            </div>

            {/* Right side - User info and logout */}
            <div className="nav-right">
              <div className="user-info">
                <p className="user-name">{user?.fullName}</p>
                <p className="user-role">CANDIDATE</p>
              </div>
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
        <div className={`candidate-sidebar ${sidebarOpen ? 'open' : ''}`}>
          <div className="sidebar-content">
            <nav className="sidebar-nav">
              {navigation.map((item) => {
                const Icon = item.icon;

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

                const current = isCurrentPath(item.href);

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

      <FeatureRequestModal
        open={featureRequestOpen}
        onClose={() => setFeatureRequestOpen(false)}
      />
    </div>
  );
};

export default CandidateLayout;
