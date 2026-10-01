import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DocumentPreviewModal from './DocumentPreviewModal';

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ token: 't' }) }));

describe('DocumentPreviewModal', () => {
  it('renders on <body>, outside whatever card opened it', () => {
    // A transformed ancestor (a card with a hover lift) would otherwise become the
    // fixed overlay's containing block and pull the preview off-centre.
    const { container } = render(
      <div style={{ transform: 'translateY(-2px)' }}>
        <DocumentPreviewModal kind="text" title="Taylor Kim – Short Answer" text="Hello" onClose={() => {}} />
      </div>
    );

    expect(screen.getByText('Taylor Kim – Short Answer')).toBeInTheDocument();
    expect(container.textContent).not.toContain('Taylor Kim – Short Answer');
  });

  it('still closes from its button', () => {
    const onClose = vi.fn();
    render(<DocumentPreviewModal kind="text" title="Preview" text="Hello" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
