import React, { useState, useEffect, useCallback } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import CycleScopeBanner from './CycleScopeBanner';
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
  CheckCircleIcon,
  ChevronRightIcon,
  EnvelopeIcon,
  BriefcaseIcon,
  QuestionMarkCircleIcon
} from '@heroicons/react/24/outline';
import UConsultingLogo from './UConsultingLogo';
import MessageAdminModal from './MessageAdminModal';
import FeatureRequestModal from './FeatureRequestModal';
import MemberTalentNetworkPrompt from './MemberTalentNetworkPrompt';
import MemberAvatar from './MemberAvatar';
import ThemeToggle from './ThemeToggle';
import '../styles/Layout.css';

const FEATURE_REQUEST_NAV = {
  name: 'Request a feature',
  icon: LightBulbIcon,
  isFeatureRequest: true,
};

// Admin nav is grouped by recruiting workflow stage. Sections collapse independently and
// the collapsed set is persisted, so the sidebar stays scoped to whatever is being worked on.
const ADMIN_NAV_SECTIONS = [
  {
    section: 'Pipeline',
    items: [
      { name: 'Applications', href: '/application-list', icon: DocumentTextIcon },
      { name: 'Candidates', href: '/candidate-list', icon: UserGroupIcon },
      { name: 'Document Grading', href: '/admin-document-grading', icon: DocumentTextIcon },
      { name: 'Review Teams', href: '/review-teams', icon: UserGroupIcon },
      { name: 'Staging', href: '/staging', icon: UserGroupIcon },
    ],
  },
  {
    section: 'Interviews',
    items: [
      { name: 'Assigned Interviews', href: '/admin/assigned-interviews', icon: UserGroupIcon2 },
      { name: 'Cases', href: '/cases', icon: PresentationChartBarIcon },
      { name: 'Recruitment Resources', href: '/interview-prep', icon: ClipboardDocumentListIcon },
      { name: 'Get to Know UC', href: '/admin/meeting-slots', icon: ChatBubbleLeftRightIcon },
    ],
  },
  {
    section: 'Engagement',
    items: [
      { name: 'Event Management', href: '/events', icon: CalendarDaysIcon },
      { name: 'Accountability', href: '/accountability', icon: CheckCircleIcon },
    ],
  },
  {
    section: 'Talent Network',
    items: [
      { name: 'Talent Pool Partner Network', href: '/talent-pool', icon: BriefcaseIcon },
    ],
  },
  {
    section: 'Administration',
    items: [
      { name: 'Cycle Management', href: '/cycles', icon: ClipboardDocumentListIcon },
      { name: 'User Management', href: '/user-management', icon: UserIcon },
      { name: 'Master Communications', href: '/master-communications', icon: EnvelopeIcon },
    ],
  },
];

const COLLAPSED_SECTIONS_KEY = 'uc-ats:nav-collapsed-sections';

// Storing the *collapsed* set (rather than the expanded one) means any section added later
// defaults to visible instead of silently hiding behind a stale stored value.
const readCollapsedSections = () => {
  try {
    const stored = window.localStorage.getItem(COLLAPSED_SECTIONS_KEY);
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
};

const Layout = ({ children }) => {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [messageModalOpen, setMessageModalOpen] = useState(false);
  const [featureRequestOpen, setFeatureRequestOpen] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState(readCollapsedSections);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        COLLAPSED_SECTIONS_KEY,
        JSON.stringify([...collapsedSections])
      );
    } catch {
      // Storage unavailable (private browsing, blocked cookies) - collapse still works
      // for this session, it just will not survive a reload.
    }
  }, [collapsedSections]);

  // Navigating into a collapsed section reveals it, so the active page is never hidden.
  // Keyed on pathname only, so manually collapsing the current section still sticks.
  useEffect(() => {
    const owning = ADMIN_NAV_SECTIONS.find((group) =>
      group.items.some((item) => item.href === location.pathname)
    );
    if (!owning) return;
    setCollapsedSections((prev) => {
      if (!prev.has(owning.section)) return prev;
      const next = new Set(prev);
      next.delete(owning.section);
      return next;
    });
  }, [location.pathname]);

  const toggleSection = useCallback((section) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }, []);

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
      { name: 'Talent Network', href: '/member/talent-network', icon: BriefcaseIcon },
      { name: 'Help', href: '/help', icon: QuestionMarkCircleIcon },
      { name: 'Message an Admin', href: '#', icon: ChatBubbleOvalLeftEllipsisIcon, isAction: true },
    ] : user?.role === 'ADMIN' ? [
      ...ADMIN_NAV_SECTIONS,
      { divider: true },
      { name: "What's new", href: '/admin/release-notes', icon: NewspaperIcon },
      { name: 'Help Management', href: '/admin/help', icon: QuestionMarkCircleIcon },
      FEATURE_REQUEST_NAV,
    ] : [
      { name: 'Applications', href: '/application-list', icon: DocumentTextIcon },
      { name: 'Review Teams', href: '/review-teams', icon: UserGroupIcon },
      FEATURE_REQUEST_NAV,
    ])
  ];

  const isCurrentPath = (path) => location.pathname === path;

  const renderNavItem = (item) => {
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
  };

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
              {navigation.map((entry, index) => {
                if (entry.divider) {
                  return <hr key={`nav-divider-${index}`} className="nav-divider" />;
                }

                if (entry.section) {
                  const collapsed = collapsedSections.has(entry.section);
                  const sectionId = `nav-section-${entry.section.replace(/\s+/g, '-').toLowerCase()}`;
                  return (
                    <div key={entry.section} className="nav-section">
                      <button
                        type="button"
                        className="nav-section-header"
                        onClick={() => toggleSection(entry.section)}
                        aria-expanded={!collapsed}
                        aria-controls={collapsed ? undefined : sectionId}
                      >
                        <ChevronRightIcon
                          className={`nav-section-chevron ${collapsed ? '' : 'expanded'}`}
                        />
                        <span className="nav-section-title">{entry.section}</span>
                      </button>
                      {!collapsed && (
                        <div className="nav-section-items" id={sectionId}>
                          {entry.items.map(renderNavItem)}
                        </div>
                      )}
                    </div>
                  );
                }

                return renderNavItem(entry);
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
              <CycleScopeBanner />
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
      {/* Decides for itself whether to show - it is a no-op for anyone who is
          not a member, and for a member who already has a resume. */}
      <MemberTalentNetworkPrompt />
    </div>
  );
};

export default Layout; 