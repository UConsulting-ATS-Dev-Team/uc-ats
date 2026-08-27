import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ClientLayout from './ClientLayout';

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'client-1', role: 'CLIENT', fullName: 'Acme Recruiting' },
    logout: vi.fn(),
  }),
}));
vi.mock('./ThemeToggle', () => ({ default: () => <div /> }));
vi.mock('./UConsultingLogo', () => ({ default: () => <div /> }));

const renderLayout = () =>
  render(
    <MemoryRouter>
      <ClientLayout>
        <div>portal content</div>
      </ClientLayout>
    </MemoryRouter>
  );

describe('ClientLayout', () => {
  it('exposes exactly one destination', () => {
    const { container } = renderLayout();
    const links = [...container.querySelectorAll('a[href]')];
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('/partner/resumes');
  });

  it('links to nothing in the staff console', () => {
    const { container } = renderLayout();
    const hrefs = [...container.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));

    for (const href of hrefs) {
      expect(href).not.toMatch(
        /staging|application-list|user-management|review-teams|talent-pool|cases|events/
      );
    }
  });

  it('does not offer the feature-request modal, which the API blocks for this role', () => {
    renderLayout();
    expect(screen.queryByText(/request a feature/i)).not.toBeInTheDocument();
  });

  it('renders its children and labels the role', () => {
    renderLayout();
    expect(screen.getByText('portal content')).toBeInTheDocument();
    expect(screen.getByText('PARTNER')).toBeInTheDocument();
  });
});
