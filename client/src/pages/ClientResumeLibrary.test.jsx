import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
  assignmentId: 'assign-1aaa-bbbb',
  kind: 'APPLICANT',
  pdfUrl: '/api/client/resumes/assign-1aaa-bbbb/pdf',
  available: true,
  assignedAt: '2026-08-01T00:00:00.000Z',
  graduationYear: '2030',
  major1: 'Business Economics',
  major2: null,
};

const fullItem = {
  ...blindItem,
  assignmentId: 'assign-2ccc-dddd',
  pdfUrl: '/api/client/resumes/assign-2ccc-dddd/pdf',
  firstName: 'Jane',
  lastName: 'Doe',
  gender: 'Female',
  email: 'jane@ucla.edu',
  phoneNumber: '310-555-0100',
  cumulativeGpa: '3.85',
  majorGpa: '3.92',
};

// Matches what GET /api/client/me actually returns: the field lists are derived
// server-side from the same visibility the projection uses, and the page renders
// its controls from them.
const FIELDS_BY_VISIBILITY = {
  BLIND: {
    filterableFields: ['kind', 'graduationYear', 'major'],
    sortableFields: ['graduationYear', 'major', 'kind', 'assignedAt'],
  },
  BASIC: {
    filterableFields: ['kind', 'graduationYear', 'major', 'gender'],
    sortableFields: ['graduationYear', 'major', 'kind', 'assignedAt', 'name', 'gender'],
  },
  FULL: {
    filterableFields: ['kind', 'graduationYear', 'major', 'gender', 'gpa'],
    sortableFields: [
      'graduationYear',
      'major',
      'kind',
      'assignedAt',
      'name',
      'gender',
      'cumulativeGpa',
      'majorGpa',
    ],
  },
};

const mockApi = ({ visibility = 'BASIC', items = [], total = items.length, facets } = {}) => {
  apiClient.get = vi.fn((url) => {
    if (url.startsWith('/client/me')) {
      return Promise.resolve({
        organization: 'Acme Recruiting',
        visibility,
        resumeCount: total,
        maxExport: 1000,
        ...FIELDS_BY_VISIBILITY[visibility],
      });
    }
    if (url.startsWith('/client/facets')) {
      return Promise.resolve(
        facets || {
          graduationYear: ['2029', '2030'],
          major: ['Business Economics', 'Statistics'],
          gender: ['Female', 'Male'],
          kind: ['APPLICANT'],
        }
      );
    }
    if (url.startsWith('/client/resumes')) {
      return Promise.resolve({ items, total, limit: 25, offset: 0, notes: [] });
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

const lastResumesCall = () =>
  apiClient.get.mock.calls.map(([url]) => url).filter((url) => url.startsWith('/client/resumes')).pop();

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.token = 'test-token';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ClientResumeLibrary', () => {
  it('renders the assigned resumes with the organization name', async () => {
    mockApi({ items: [fullItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    expect(screen.getByText(/Acme Recruiting/)).toBeInTheDocument();
    expect(screen.getByText(/Business Economics/)).toBeInTheDocument();
  });

  it('renders a blind row without a name and without an assignment handle', async () => {
    mockApi({ visibility: 'BLIND', items: [blindItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Business Economics')).toBeInTheDocument());
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();
    // The reference is not a column partners see - it only labels the row for
    // screen readers and titles the preview.
    expect(screen.queryByText('ASSIGN1A')).not.toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).not.toContain('Ref');
  });

  it('omits the columns a visibility level hides rather than blanking them', async () => {
    mockApi({ visibility: 'BLIND', items: [blindItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Business Economics')).toBeInTheDocument());

    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).not.toContain('Name');
    expect(headers).not.toContain('Gender');
    expect(headers).not.toContain('GPA');
    expect(headers).not.toContain('Email');
    expect(headers).toContain('Class');
  });

  it('shows the identity and contact columns at FULL', async () => {
    mockApi({ visibility: 'FULL', items: [fullItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());

    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Name', 'Gender', 'GPA', 'Email', 'Phone']));
    expect(screen.getByText('jane@ucla.edu')).toBeInTheDocument();
    expect(screen.getByText('3.85')).toBeInTheDocument();
    expect(screen.getByText('3.92')).toBeInTheDocument();
  });

  it('puts email last, where a long address has no column to spill into', async () => {
    mockApi({ visibility: 'FULL', items: [fullItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());

    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers[headers.length - 1]).toBe('Email');
  });

  it('offers no way to download a resume file', async () => {
    mockApi({ items: [fullItem] });
    const { container } = renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());

    // View-only is still the point for the PDFs themselves. The CSV export is
    // metadata, and it goes through a POST, not a download link.
    expect(container.querySelector('a[download]')).toBeNull();
    expect(container.querySelector('a[href^="https://drive.google.com"]')).toBeNull();
  });

  it('opens the preview against the assignment-scoped proxy URL', async () => {
    mockApi({ items: [fullItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Jane Doe'));

    const preview = await screen.findByTestId('preview');
    expect(preview.getAttribute('data-src')).toBe('/api/client/resumes/assign-2ccc-dddd/pdf');
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

    await waitFor(() => expect(screen.getByText('No file')).toBeInTheDocument());

    await userEvent.click(screen.getByText('Business Economics'));
    expect(screen.queryByTestId('preview')).not.toBeInTheDocument();
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

    await waitFor(() => expect(lastResumesCall()).toContain('q=econ'));
  });
});

describe('filtering', () => {
  it('sends a selected graduation year to the server', async () => {
    mockApi({ items: [fullItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText('Graduation year'));
    await userEvent.click(await screen.findByRole('option', { name: '2030' }));

    await waitFor(() => expect(lastResumesCall()).toContain('graduationYear=2030'));
  });

  it('does not offer a gender filter to a blind client', async () => {
    mockApi({ visibility: 'BLIND', items: [blindItem] });
    renderPage();

    await waitFor(() => expect(screen.getByLabelText('Graduation year')).toBeInTheDocument());
    expect(screen.queryByLabelText('Gender')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Min GPA')).not.toBeInTheDocument();
  });

  it('offers the gender filter at BASIC and the GPA range only at FULL', async () => {
    mockApi({ visibility: 'BASIC', items: [fullItem] });
    const { unmount } = renderPage();

    await waitFor(() => expect(screen.getByLabelText('Gender')).toBeInTheDocument());
    expect(screen.queryByLabelText('Min GPA')).not.toBeInTheDocument();
    unmount();

    mockApi({ visibility: 'FULL', items: [fullItem] });
    renderPage();

    await waitFor(() => expect(screen.getByLabelText('Min GPA')).toBeInTheDocument());
  });

  it('starts with both types included and asks for no kind at all', async () => {
    mockApi({ items: [fullItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());

    expect(screen.getByRole('checkbox', { name: 'Members' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Applicants' })).toBeChecked();
    // Both ticked is the whole library, which is no filter rather than an
    // impossible "APPLICANT and MEMBER".
    expect(lastResumesCall()).not.toContain('kind=');
  });

  it('narrows to one type when the other is unticked', async () => {
    mockApi({ items: [fullItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('checkbox', { name: 'Applicants' }));
    await waitFor(() => expect(lastResumesCall()).toContain('kind=MEMBER'));
  });

  it('asks the server for nothing when neither type is ticked', async () => {
    mockApi({ items: [fullItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    const before = apiClient.get.mock.calls.length;

    await userEvent.click(screen.getByRole('checkbox', { name: 'Applicants' }));
    await waitFor(() => expect(lastResumesCall()).toContain('kind=MEMBER'));
    const afterFirst = apiClient.get.mock.calls.length;

    await userEvent.click(screen.getByRole('checkbox', { name: 'Members' }));

    // An empty selection matches nothing. Sending it would drop the kind param
    // entirely and come back with the unfiltered library, which reads as the
    // filter being ignored.
    await waitFor(() => expect(screen.getByText('No type selected')).toBeInTheDocument());
    expect(apiClient.get.mock.calls.length).toBe(afterFirst);
    expect(afterFirst).toBeGreaterThan(before);
  });

  it('returns to the first page when a filter narrows the set', async () => {
    mockApi({ items: [fullItem], total: 200 });
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /go to next page/i }));
    await waitFor(() => expect(lastResumesCall()).toContain('offset=25'));

    await userEvent.click(screen.getByLabelText('Major'));
    await userEvent.click(await screen.findByRole('option', { name: 'Statistics' }));

    // Narrowing while on page 2 would otherwise land on an empty page that
    // reads as "no results" when there are plenty.
    await waitFor(() => expect(lastResumesCall()).toContain('offset=0'));
  });
});

describe('sorting', () => {
  it('toggles direction on the active column and sends it to the server', async () => {
    mockApi({ visibility: 'FULL', items: [fullItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /^name$/i }));
    await waitFor(() => expect(lastResumesCall()).toContain('sort=name&dir=asc'));

    await userEvent.click(screen.getByRole('button', { name: /^name$/i }));
    await waitFor(() => expect(lastResumesCall()).toContain('sort=name&dir=desc'));
  });

  it('sorts by every numeric column a FULL client can see', async () => {
    mockApi({ visibility: 'FULL', items: [fullItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /^major gpa$/i }));
    await waitFor(() => expect(lastResumesCall()).toContain('sort=majorGpa'));

    await userEvent.click(screen.getByRole('button', { name: /^gpa$/i }));
    await waitFor(() => expect(lastResumesCall()).toContain('sort=cumulativeGpa'));

    await userEvent.click(screen.getByRole('button', { name: /^class$/i }));
    await waitFor(() => expect(lastResumesCall()).toContain('sort=graduationYear'));
  });

  it('does not make a hidden column sortable', async () => {
    mockApi({ visibility: 'BLIND', items: [blindItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Business Economics')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^gpa$/i })).not.toBeInTheDocument();
  });
});

describe('selection and export', () => {
  const setupExport = () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'attachment; filename="acme-recruiting-resumes-2026-08-26.csv"' },
      blob: async () => new Blob(['ref,name'], { type: 'text/csv' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    // jsdom implements neither of these, and the export path uses both.
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    });
    return fetchMock;
  };

  it('disables export until something is selected', async () => {
    mockApi({ items: [fullItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /export csv/i })).toBeDisabled();
  });

  it('posts only the selected assignment ids', async () => {
    const fetchMock = setupExport();
    mockApi({ items: [fullItem, { ...blindItem, firstName: 'Sam', lastName: 'Lee' }] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText('Select Jane Doe'));
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /export csv/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/client/resumes/export');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ assignmentIds: ['assign-2ccc-dddd'] });
  });

  it('selects every row on the page from the header checkbox', async () => {
    mockApi({ items: [fullItem, { ...blindItem, firstName: 'Sam', lastName: 'Lee' }] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText('Select all rows on this page'));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Select all rows on this page'));
    expect(screen.getByText('0 selected')).toBeInTheDocument();
  });

  it('checking a row does not open the resume preview', async () => {
    mockApi({ items: [fullItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText('Select Jane Doe'));

    expect(screen.queryByTestId('preview')).not.toBeInTheDocument();
  });

  it('surfaces the server error when an export is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'You can export at most 1000 resumes at a time.' }),
      }))
    );
    mockApi({ items: [fullItem] });
    renderPage();

    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText('Select Jane Doe'));
    await userEvent.click(screen.getByRole('button', { name: /export csv/i }));

    await waitFor(() =>
      expect(screen.getByText(/at most 1000 resumes/i)).toBeInTheDocument()
    );
  });
});

describe('truncation', () => {
  it('reports a bounded result set instead of presenting a prefix as the whole library', async () => {
    apiClient.get = vi.fn((url) => {
      if (url.startsWith('/client/me')) {
        return Promise.resolve({
          organization: 'Acme Recruiting',
          visibility: 'BASIC',
          resumeCount: 5000,
          maxExport: 1000,
          ...FIELDS_BY_VISIBILITY.BASIC,
        });
      }
      if (url.startsWith('/client/facets')) return Promise.resolve({});
      return Promise.resolve({
        items: [fullItem],
        total: 5000,
        truncated: true,
        notes: ['Showing the 2000 most recently shared resumes of 5000. Narrow the filters to see the rest.'],
        limit: 25,
        offset: 0,
      });
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/2000 most recently shared resumes of 5000/i)).toBeInTheDocument()
    );
  });
});
