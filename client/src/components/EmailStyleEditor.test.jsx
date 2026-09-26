// How one automatic email looks: Designed or Plain, and its header colour.
//
// The editor's promises: it starts on what the email uses today, the preview
// beside it renders the unsaved choice (on the server, never by imitation),
// and Save sends exactly what is on screen.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EmailStyleEditor from './EmailStyleEditor';
import apiClient from '../utils/api';

const STYLE = {
  key: 'application-rejection',
  defaults: { format: 'DESIGNED', banner: 'danger' },
  values: { format: 'DESIGNED', banner: 'danger' },
  formats: ['DESIGNED', 'PLAIN'],
  tones: ['brand', 'success', 'danger', 'warning', 'info'],
  customized: false,
  updatedAt: null,
};

const PREVIEW = { key: 'application-rejection', label: 'Application rejected', subject: 'Update', html: '<p>x</p>' };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(apiClient, 'get').mockResolvedValue(STYLE);
  vi.spyOn(apiClient, 'post').mockResolvedValue(PREVIEW);
  vi.spyOn(apiClient, 'put').mockResolvedValue({ ...STYLE, values: { format: 'PLAIN', banner: 'danger' }, customized: true });
  vi.spyOn(apiClient, 'delete').mockResolvedValue(STYLE);
});

const renderEditor = () =>
  render(<EmailStyleEditor templateKey="application-rejection" previewKey="application-rejection" />);

describe('EmailStyleEditor', () => {
  it('starts on the style the email uses today, with nothing to save', async () => {
    renderEditor();

    expect(await screen.findByRole('radio', { name: /designed/i })).toBeChecked();
    expect(screen.getByRole('button', { name: /save style/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /restore the original/i })).toBeDisabled();
  });

  it('previews the unsaved choice on the server', async () => {
    renderEditor();
    await userEvent.click(await screen.findByRole('radio', { name: /plain/i }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenLastCalledWith('/admin/email-templates/application-rejection/preview', {
        style: { format: 'PLAIN', banner: 'danger' },
      })
    );
    expect(apiClient.put).not.toHaveBeenCalled();
  });

  it('saves what is on screen', async () => {
    renderEditor();
    await userEvent.click(await screen.findByRole('radio', { name: /plain/i }));
    await userEvent.click(screen.getByRole('button', { name: /save style/i }));

    expect(apiClient.put).toHaveBeenCalledWith('/admin/email-templates/application-rejection/style', {
      style: { format: 'PLAIN', banner: 'danger' },
    });
    expect(await screen.findByText(/next one of these emails goes out like this/i)).toBeInTheDocument();
  });

  it('will not save or preview a custom colour that is not a colour', async () => {
    renderEditor();
    await userEvent.click(await screen.findByLabelText('Header colour'));
    await userEvent.click(within(screen.getByRole('listbox')).getByText(/custom colour/i));

    const hex = screen.getByLabelText('Header colour hex');
    await userEvent.clear(hex);
    await userEvent.type(hex, '#12');

    expect(screen.getByRole('button', { name: /save style/i })).toBeDisabled();
    expect(screen.getByText('Like #0C74C1')).toBeInTheDocument();
  });

  it('turns the header colour off for a Plain email, which has no header', async () => {
    renderEditor();
    await userEvent.click(await screen.findByRole('radio', { name: /plain/i }));

    expect(screen.getByText('Plain emails have no header.')).toBeInTheDocument();
  });
});
