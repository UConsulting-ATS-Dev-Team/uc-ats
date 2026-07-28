import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import CandidateGroupCopyModal from './CandidateGroupCopyModal';
import apiClient from '../utils/api';

vi.mock('../utils/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

describe('CandidateGroupCopyModal', () => {
  const interview = { id: 'iv-1', title: 'Coffee Chat', cycleId: 'cycle-1' };
  const applicationGroups = [
    { id: 'dest-1', name: 'Existing Group', applicationIds: ['app-1'] }
  ];
  const onClose = vi.fn();
  const onCopy = vi.fn();

  const candidateGroups = [
    { id: 'group-1', name: 'Team Alpha', applications: [{ id: 'app-1' }, { id: 'app-2' }] }
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('alert', vi.fn());
    apiClient.get.mockResolvedValue(candidateGroups);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderModal() {
    return render(
      <CandidateGroupCopyModal
        interview={interview}
        applicationGroups={applicationGroups}
        onClose={onClose}
        onCopy={onCopy}
      />
    );
  }

  it('loads candidate groups and lets the admin select source and destination', async () => {
    renderModal();

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith('/review-teams');
    });

    await waitFor(() => {
      expect(screen.getByText('Team Alpha (2 candidates)')).toBeInTheDocument();
    });

    expect(screen.getByText('Create new application group')).toBeInTheDocument();
    expect(screen.getByText('Existing Group (1 candidates)')).toBeInTheDocument();
  });

  it('previews additions, duplicates, and skipped candidates', async () => {
    apiClient.post.mockResolvedValue({
      additionCount: 1,
      duplicateCount: 1,
      skippedCount: 1,
      additions: [{ applicationId: 'app-2', name: 'Bob Baker', email: 'bob@example.com' }],
      duplicates: [{ applicationId: 'app-1', name: 'Alice Anderson', email: 'alice@example.com' }],
      skipped: [{ candidateId: 'c-3', name: 'Carol Chen', reason: 'no_application_in_cycle' }],
    });

    renderModal();

    await waitFor(() => {
      expect(screen.getByText('Team Alpha (2 candidates)')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Source Candidate Group'), { target: { value: 'group-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(
        '/admin/interviews/iv-1/copy-candidate-group-preview',
        { sourceGroupId: 'group-1', destinationGroupId: undefined }
      );
    });

    await waitFor(() => {
      expect(screen.getByText('1 addition(s)')).toBeInTheDocument();
      expect(screen.getByText('1 duplicate(s)')).toBeInTheDocument();
      expect(screen.getByText('1 skipped / ineligible')).toBeInTheDocument();
    });
  });

  it('commits the copy and calls onCopy with the result', async () => {
    const result = {
      interview: { id: 'iv-1', title: 'Coffee Chat', cycleId: 'cycle-1' },
      destinationGroup: { id: 'new-group', name: 'Team Alpha', applicationIds: ['app-2'] },
      additionCount: 1,
      duplicateCount: 0,
      skippedCount: 0,
    };

    apiClient.post
      .mockResolvedValueOnce({
        additionCount: 1,
        duplicateCount: 0,
        skippedCount: 0,
        additions: [{ applicationId: 'app-2', name: 'Bob Baker', email: 'bob@example.com' }],
        duplicates: [],
        skipped: [],
      })
      .mockResolvedValueOnce(result);

    renderModal();

    await waitFor(() => {
      expect(screen.getByText('Team Alpha (2 candidates)')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Source Candidate Group'), { target: { value: 'group-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    await waitFor(() => {
      expect(screen.getByText('1 addition(s)')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Copy Candidates' }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenLastCalledWith(
        '/admin/interviews/iv-1/copy-candidate-group',
        { sourceGroupId: 'group-1', destinationGroupId: undefined }
      );
      expect(onCopy).toHaveBeenCalledWith(result);
    });
  });

  it('displays an error when the preview request fails', async () => {
    apiClient.post.mockRejectedValue(new Error('Cycle mismatch'));

    renderModal();

    await waitFor(() => {
      expect(screen.getByText('Team Alpha (2 candidates)')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Source Candidate Group'), { target: { value: 'group-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    await waitFor(() => {
      expect(screen.getByText('Cycle mismatch')).toBeInTheDocument();
    });
  });

  it('closes when the cancel button is clicked', async () => {
    renderModal();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});
