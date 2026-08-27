import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TalentPoolClients from './TalentPoolClients';
import apiClient from '../utils/api';

vi.mock('./ClientAssignBuilder', () => ({
  default: ({ client }) => <div data-testid="assign-builder">{client.organization}</div>,
}));

const clients = [
  {
    id: 'partner-1',
    organization: 'Acme Recruiting',
    visibility: 'BLIND',
    assignmentCount: 12,
    user: { id: 'u1', fullName: 'Buyer Contact', email: 'buyer@acme.com', isActive: true },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.token = 'test-token';
  apiClient.get = vi.fn(() => Promise.resolve(clients));
  apiClient.post = vi.fn(() => Promise.resolve({ client: clients[0] }));
  apiClient.patch = vi.fn(() => Promise.resolve({ client: clients[0], warnings: {} }));
});

describe('TalentPoolClients', () => {
  it('lists clients with their visibility and share count', async () => {
    render(<TalentPoolClients />);
    await waitFor(() => expect(screen.getByText('Acme Recruiting')).toBeInTheDocument());
    // Appears twice: once as the summary chip, once as the Select's value.
    expect(screen.getAllByText('BLIND').length).toBeGreaterThan(0);
    expect(screen.getByText('12 resumes')).toBeInTheDocument();
  });

  it('creates a client with the details the admin entered', async () => {
    const user = userEvent.setup();
    render(<TalentPoolClients />);
    await waitFor(() => expect(screen.getByText('Acme Recruiting')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /add client/i }));
    await user.type(screen.getByLabelText(/organization/i), 'Globex');
    await user.type(screen.getByLabelText(/contact name/i), 'Jane Buyer');
    await user.type(screen.getByLabelText(/login email/i), 'jane@globex.com');
    await user.type(screen.getByLabelText(/^password/i), 'a-very-long-password');
    await user.click(screen.getByRole('button', { name: /create client/i }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith(
        '/admin/talent-pool/clients',
        expect.objectContaining({
          organization: 'Globex',
          email: 'jane@globex.com',
          visibility: 'BLIND',
        })
      )
    );
  });

  it('explains what each visibility level exposes', async () => {
    render(<TalentPoolClients />);
    await waitFor(() => expect(screen.getByText('Acme Recruiting')).toBeInTheDocument());
    expect(screen.getByText(/Redacted resume only/i)).toBeInTheDocument();
  });

  it('opens the assign builder for a client', async () => {
    const user = userEvent.setup();
    render(<TalentPoolClients />);
    await waitFor(() => expect(screen.getByText('Acme Recruiting')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /assign resumes/i }));
    expect(await screen.findByTestId('assign-builder')).toHaveTextContent('Acme Recruiting');
  });

  it('warns when tightening to BLIND strands already-shared resumes', async () => {
    apiClient.patch = vi.fn(() =>
      Promise.resolve({ client: clients[0], warnings: { blindUnavailable: 3 } })
    );
    const user = userEvent.setup();
    render(<TalentPoolClients />);
    await waitFor(() => expect(screen.getByText('Acme Recruiting')).toBeInTheDocument());

    await user.click(screen.getByLabelText('Visibility'));
    await user.click(await screen.findByRole('option', { name: 'FULL' }));

    await waitFor(() =>
      expect(screen.getByText(/3 already-shared resume\(s\) have no redacted version/i)).toBeInTheDocument()
    );
  });
});
