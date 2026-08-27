import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  FolderOpenIcon,
  ArrowRightOnRectangleIcon,
  Bars3Icon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import UConsultingLogo from './UConsultingLogo';
import ThemeToggle from './ThemeToggle';
import '../styles/ClientLayout.css';

// Shell for Talent Partner Network clients. Mirrors CandidateLayout, minus the
// feature-request modal: it POSTs /api/feature-requests, which the containment
// middleware 403s for this role, so the button would only ever fail.
//
// One nav item on purpose. A client has exactly one page.
const ClientLayout = ({ children }) => {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const navigation = [
    { name: 'Resume Library', href: '/partner/resumes', icon: FolderOpenIcon },
  ];

  const isCurrentPath = (path) => location.pathname === path;

  return (
    <div className="client-layout-container">
      <nav className="client-top-nav">
        <div className="nav-container">
          <div className="nav-content">
            <div className="nav-left">
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

              <div className="logo-section">
                <UConsultingLogo size="medium" />
                <div className="logo-subtitle">
                  <p>Talent Partner Network</p>
                </div>
              </div>
            </div>

            <div className="nav-right">
              <div className="user-info">
                <p className="user-name">{user?.fullName}</p>
                <p className="user-role">PARTNER</p>
              </div>
              <ThemeToggle />
              <button onClick={handleLogout} className="logout-btn">
                <ArrowRightOnRectangleIcon className="logout-icon" />
                Logout
              </button>
            </div>
          </div>
        </div>
      </nav>

      <div className="main-layout">
        <div className={`client-sidebar ${sidebarOpen ? 'open' : ''}`}>
          <div className="sidebar-content">
            <nav className="sidebar-nav">
              {navigation.map((item) => {
                const Icon = item.icon;
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

        {sidebarOpen && (
          <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
        )}

        <div className="content-area">
          <main className="main-content">
            <div className="content-container">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
};

export default ClientLayout;
