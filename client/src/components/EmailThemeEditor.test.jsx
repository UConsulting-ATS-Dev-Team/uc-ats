// The look every automatic email shares.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EmailThemeEditor from './EmailThemeEditor';
import apiClient from '../utils/api';

const DEFAULTS = {
  brandName: null,
  logoUrl: null,
  headerBackground: '#f8f9fa',
  headerTextColor: '#042742',
  accentColor: '#0C74C1',
  fontFamily: 'arial',
  footerText: 'This is an automated message. Please do not reply to this email.',
};

const THEME = {
  defaults: DEFAULTS,
  values: DEFAULTS,
  fonts: [
    { id: 'arial', label: 'Arial' },
    { id: 'georgia', label: 'Georgia' },
  ],
  customized: false,
  updatedAt: null,
};

const TEMPLATES = [
  { key: 'application-acceptance', label: 'Application advanced' },
  { key: 'password-reset', label: 'Password reset link' },
];

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(apiClient, 'get').mockResolvedValue(THEME);
  vi.spyOn(apiClient, 'post').mockResolvedValue({ key: 'application-acceptance', label: 'Application advanced', subject: 'S', html: '<p>x</p>' });
  vi.spyOn(apiClient, 'put').mockImplementation((url, { theme }) =>
    Promise.resolve({ ...THEME, values: theme, customized: true })
  );
});

describe('EmailThemeEditor', () => {
  it('previews the current theme against a real email', async () => {
    render(<EmailThemeEditor templates={TEMPLATES} />);

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/admin/email-templates/application-acceptance/preview', {
        theme: DEFAULTS,
      })
    );
    expect(await screen.findByTitle('Application advanced draft preview')).toBeInTheDocument();
  });

  it('saves a new button colour for every email', async () => {
    render(<EmailThemeEditor templates={TEMPLATES} />);
    const accent = await screen.findByLabelText('Buttons and links');

    await userEvent.clear(accent);
    await userEvent.type(accent, '#112233');
    await userEvent.click(screen.getByRole('button', { name: /save theme/i }));

    expect(apiClient.put).toHaveBeenCalledWith('/admin/email-templates/theme', {
      theme: { ...DEFAULTS, accentColor: '#112233' },
    });
    expect(await screen.findByText(/every automatic email now uses this theme/i)).toBeInTheDocument();
  });

  it('will not save a colour that is not one', async () => {
    render(<EmailThemeEditor templates={TEMPLATES} />);
    const accent = await screen.findByLabelText('Buttons and links');

    await userEvent.clear(accent);
    await userEvent.type(accent, 'blue');

    expect(screen.getByRole('button', { name: /save theme/i })).toBeDisabled();
  });
});
