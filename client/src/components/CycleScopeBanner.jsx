import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import apiClient from '../utils/api';
import { useAuth } from '../context/AuthContext';

// Admins can be working in a different recruiting cycle than members and candidates
// see. Nothing else on screen says which one they are in, and admin writes (events,
// interviews, review teams) are stamped with the admin cycle — so a silent split is
// how you build a round of interviews nobody can see.
//
// Renders nothing at all when the pointers agree, which is the normal case.
export default function CycleScopeBanner() {
  const { user } = useAuth();
  const [scope, setScope] = useState(null);

  const load = useCallback(async () => {
    if (user?.role !== 'ADMIN') return;
    try {
      const cycle = await apiClient.get('/admin/cycles/active');
      setScope(cycle?.audiencesSplit ? cycle : null);
    } catch {
      // A banner is never worth breaking the page over.
      setScope(null);
    }
  }, [user?.role]);

  useEffect(() => {
    load();
    window.addEventListener('cycleActivated', load);
    return () => window.removeEventListener('cycleActivated', load);
  }, [load]);

  if (!scope) return null;

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '0.625rem 0.875rem',
        marginBottom: '1rem',
        border: '1px solid #f0b429',
        borderRadius: '0.375rem',
        background: '#fff8e6',
        color: '#5c4400',
        fontSize: '0.875rem'
      }}
    >
      <span>
        You are working in <strong>{scope.name}</strong>. Members and candidates see{' '}
        <strong>{scope.candidateCycle?.name}</strong>. Events, interviews and review teams you
        create here will not be visible to them.
      </span>
      <Link to="/cycles" style={{ color: '#5c4400', fontWeight: 600 }}>
        Manage cycles
      </Link>
    </div>
  );
}
