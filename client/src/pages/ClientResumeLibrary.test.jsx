import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ClientResumeLibrary from './ClientResumeLibrary';
import apiClient from '../utils/api';

vi.mock('../components/AccessControl', () => ({ default: ({ children }) => children }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'client-1', role: 'CLIENT', fullName: 'Acme Recruiting' }, token: 't' }),
}));
vi.mock('../components/DocumentPreviewModal', () => ({
  default: ({ src, title }) => (
    <div data-testid="preview" data-src={src}>
      {title}
    </div>
  ),
}));

const blindItem = {
  assignmentId: 'assign-1',
  kind: 'APPLICANT',
  pdfUrl: '/api/client/resumes/assign-1/pdf',
  available: true,
  graduationYear: '2030',
  major1: 'Business Economics',
  major2: null,
};

const fullItem = {
  ...blindItem,
  assignmentId: 'assign-2',
  pdfUrl: '/api/client/resumes/assign-2/pdf',
  firstName: 'Jane',
  lastName: 'Doe',
  gender: 'Female',
  email: 'jane@ucla.edu',
  cumulativeGpa: '3.85',
};

const mockApi = ({ visibility = 'BASIC', items = [], total = items.length } = {}) => {
  apiClient.get = vi.fn((url) => {
    if (url.startsWith('/client/me')) {
      return Promise.resolve({ organization: 'Acme Recruiting', visibility, resumeCount: total });
    }
    if (url.startsWith('/client/resumes')) {
      return Promise.resolve({ items, total, limit: 24, offset: 0 });
    }
    return Promise.resolve({});
  });
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <ClientResumeLibrary />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.token = 'test-token';
});

describe('ClientResumeLibrary', () => {
  it('renders the assigned resumes with the organization name', async () => {
    mockApi({ items: [fullItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    expect(screen.getByText(/Acme Recruiting/)).toBeInTheDocument();
    expect(screen.getByText(/Business Economics/)).toBeInTheDocument();
  });

  it('renders a blind row without a name', async () => {
    mockApi({ visibility: 'BLIND', items: [blindItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Candidate')).toBeInTheDocument());
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();
  });

  it('offers no way to download a resume', async () => {
    mockApi({ items: [fullItem] });
    const { container } = renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());

    // View-only is the whole point: no download control, and nothing that
    // hands the browser a file directly.
    expect(screen.queryByText(/download/i)).not.toBeInTheDocument();
    expect(container.querySelector('a[download]')).toBeNull();
    expect(container.querySelector('a[href^="https://drive.google.com"]')).toBeNull();
  });

  it('opens the preview against the assignment-scoped proxy URL', async () => {
    mockApi({ items: [fullItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Jane Doe'));

    const preview = await screen.findByTestId('preview');
    expect(preview.getAttribute('data-src')).toBe('/api/client/resumes/assign-2/pdf');
  });

  it('shows an empty state when nothing has been shared yet', async () => {
    mockApi({ items: [] });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/No resumes have been shared yet/i)).toBeInTheDocument()
    );
  });

  it('marks an unavailable resume rather than opening a pane that 404s', async () => {
    mockApi({ visibility: 'BLIND', items: [{ ...blindItem, available: false }] });
    renderPage();

    await waitFor(() => expect(screen.getByText(/Resume not available/i)).toBeInTheDocument());
  });

  it('tells a blind client the search does not cover names', async () => {
    mockApi({ visibility: 'BLIND', items: [blindItem] });
    renderPage();

    await waitFor(() =>
      expect(screen.getByPlaceholderText(/Search by major or graduation year/i)).toBeInTheDocument()
    );
  });

  it('sends the search term to the server', async () => {
    mockApi({ items: [fullItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    await userEvent.type(screen.getByPlaceholderText(/Search by name/i), 'econ');
    await userEvent.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() =>
      expect(apiClient.get).toHaveBeenCalledWith(expect.stringContaining('q=econ'))
    );
  });
});
