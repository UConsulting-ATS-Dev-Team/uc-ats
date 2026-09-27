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
  takesSignature: true,
  defaults: { format: 'DESIGNED', banner: 'danger', signatureId: null },
  values: { format: 'DESIGNED', banner: 'danger', signatureId: null },
  formats: ['DESIGNED', 'PLAIN'],
  tones: ['brand', 'success', 'danger', 'warning', 'info'],
  customized: false,
  updatedAt: null,
};

const PREVIEW = { key: 'application-rejection', label: 'Application rejected', subject: 'Update', html: '<p>x</p>' };

const SIGNATURES = [
  { id: 'sig-team', name: 'Recruitment Team', body: 'The team', imageUrl: null, isDefault: true },
  { id: 'sig-vp', name: 'External VP', body: 'Ryan', imageUrl: null, isDefault: false },
];

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(apiClient, 'get').mockImplementation((url) =>
    Promise.resolve(url.endsWith('/signatures') ? SIGNATURES : STYLE)
  );
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
        style: { format: 'PLAIN', banner: 'danger', signatureId: null },
      }),
      // The preview is debounced (350ms); leave room for a busy test run.
      { timeout: 3000 }
    );
    expect(apiClient.put).not.toHaveBeenCalled();
  });

  it('saves what is on screen', async () => {
    renderEditor();
    await userEvent.click(await screen.findByRole('radio', { name: /plain/i }));
    await userEvent.click(screen.getByRole('button', { name: /save style/i }));

    expect(apiClient.put).toHaveBeenCalledWith('/admin/email-templates/application-rejection/style', {
      style: { format: 'PLAIN', banner: 'danger', signatureId: null },
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
    // Nor send a test: that would quietly be the saved style, not this one.
    expect(screen.getByRole('button', { name: /send test to me/i })).toBeDisabled();
    expect(screen.getByText(/fix the header colour to send a test/i)).toBeInTheDocument();
  });

  it('picks a signature by name, naming the default', async () => {
    renderEditor();
    await userEvent.click(await screen.findByLabelText('Signature'));
    const options = within(screen.getByRole('listbox'));

    expect(options.getByText('Default (Recruitment Team)')).toBeInTheDocument();
    await userEvent.click(options.getByText('External VP'));
    await userEvent.click(screen.getByRole('button', { name: /save style/i }));

    expect(apiClient.put.mock.calls[0][1].style.signatureId).toBe('sig-vp');
  });

  it('saves a signature that was since deleted as "use the default", which the server accepts', async () => {
    apiClient.get.mockImplementation((url) =>
      Promise.resolve(
        url.endsWith('/signatures')
          ? SIGNATURES
          : { ...STYLE, values: { ...STYLE.values, signatureId: 'deleted-id' } }
      )
    );
    renderEditor();
    await userEvent.click(await screen.findByRole('radio', { name: /plain/i }));
    await userEvent.click(screen.getByRole('button', { name: /save style/i }));

    expect(apiClient.put.mock.calls[0][1].style.signatureId).toBeNull();
  });

  it('says why a decision letter has no signature choice', async () => {
    apiClient.get.mockImplementation((url) =>
      Promise.resolve(url.endsWith('/signatures') ? SIGNATURES : { ...STYLE, takesSignature: false })
    );
    renderEditor();

    expect(await screen.findByText(/closing is part of its wording/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Signature')).not.toBeInTheDocument();
  });

  it('turns the header colour off for a Plain email, which has no header', async () => {
    renderEditor();
    await userEvent.click(await screen.findByRole('radio', { name: /plain/i }));

    expect(screen.getByText('Plain emails have no header.')).toBeInTheDocument();
  });
});
