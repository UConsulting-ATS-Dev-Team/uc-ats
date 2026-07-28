import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AppThemeProvider, useThemeControl } from '../context/ThemeContext';
import ThemeToggle from './ThemeToggle';

function CurrentMode() {
  const { mode, resolvedMode } = useThemeControl();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="resolved">{resolvedMode}</span>
    </div>
  );
}

describe('ThemeToggle', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }));
  });

  it('renders the three mode options', () => {
    render(
      <AppThemeProvider>
        <ThemeToggle />
      </AppThemeProvider>
    );
    expect(screen.getByRole('button', { name: 'System' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Light' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dark' })).toBeInTheDocument();
  });

  it('updates mode to dark when dark is selected', async () => {
    render(
      <AppThemeProvider>
        <ThemeToggle />
        <CurrentMode />
      </AppThemeProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(screen.getByTestId('mode').textContent).toBe('dark');
    expect(screen.getByTestId('resolved').textContent).toBe('dark');
  });

  it('updates mode to light when light is selected', async () => {
    render(
      <AppThemeProvider>
        <ThemeToggle />
        <CurrentMode />
      </AppThemeProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(screen.getByTestId('mode').textContent).toBe('light');
    expect(screen.getByTestId('resolved').textContent).toBe('light');
  });
});
