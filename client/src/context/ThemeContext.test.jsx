import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AppThemeProvider, useThemeControl } from './ThemeContext';

const STORAGE_KEY = 'uc-ats-theme-mode-v1';

function ModeDisplay() {
  const { mode, resolvedMode } = useThemeControl();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="resolved">{resolvedMode}</span>
    </div>
  );
}

function ModeSwitcher() {
  const { mode, setMode } = useThemeControl();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <button onClick={() => setMode('dark')}>Dark</button>
      <button onClick={() => setMode('light')}>Light</button>
      <button onClick={() => setMode('system')}>System</button>
    </div>
  );
}

describe('AppThemeProvider', () => {
  let originalMatchMedia;

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    vi.restoreAllMocks();
  });

  const mockMatchMedia = (matches) => {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }));
  };

  it('defaults to system preference when no stored value exists', () => {
    mockMatchMedia(false);
    render(
      <AppThemeProvider>
        <ModeDisplay />
      </AppThemeProvider>
    );
    expect(screen.getByTestId('mode').textContent).toBe('system');
    expect(screen.getByTestId('resolved').textContent).toBe('light');
  });

  it('resolves to dark when system prefers dark and mode is system', () => {
    mockMatchMedia(true);
    render(
      <AppThemeProvider>
        <ModeDisplay />
      </AppThemeProvider>
    );
    expect(screen.getByTestId('resolved').textContent).toBe('dark');
  });

  it('reads an explicit stored preference over system', () => {
    window.localStorage.setItem(STORAGE_KEY, 'dark');
    mockMatchMedia(false);
    render(
      <AppThemeProvider>
        <ModeDisplay />
      </AppThemeProvider>
    );
    expect(screen.getByTestId('mode').textContent).toBe('dark');
    expect(screen.getByTestId('resolved').textContent).toBe('dark');
  });

  it('persists explicit mode changes to localStorage', async () => {
    mockMatchMedia(false);
    render(
      <AppThemeProvider>
        <ModeSwitcher />
      </AppThemeProvider>
    );
    fireEvent.click(screen.getByText('Dark'));
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('dark'));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('switches live without reloading and keeps the explicit choice', async () => {
    mockMatchMedia(false);
    render(
      <AppThemeProvider>
        <ModeSwitcher />
      </AppThemeProvider>
    );
    fireEvent.click(screen.getByText('Dark'));
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('dark'));
    fireEvent.click(screen.getByText('Light'));
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('light'));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('light');
  });

  it('re-applies system mode when the system preference changes', async () => {
    const listeners = [];
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: (_event, listener) => listeners.push(listener),
      removeEventListener: vi.fn(),
      addListener: (listener) => listeners.push(listener),
      removeListener: vi.fn(),
    }));

    window.localStorage.setItem(STORAGE_KEY, 'system');
    render(
      <AppThemeProvider>
        <ModeDisplay />
      </AppThemeProvider>
    );
    expect(screen.getByTestId('resolved').textContent).toBe('light');

    listeners.forEach((listener) => listener({ matches: true }));
    await waitFor(() => expect(screen.getByTestId('resolved').textContent).toBe('dark'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('does not override an explicit choice when system preference changes', async () => {
    const listeners = [];
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: (_event, listener) => listeners.push(listener),
      removeEventListener: vi.fn(),
      addListener: (listener) => listeners.push(listener),
      removeListener: vi.fn(),
    }));

    window.localStorage.setItem(STORAGE_KEY, 'light');
    render(
      <AppThemeProvider>
        <ModeDisplay />
      </AppThemeProvider>
    );
    expect(screen.getByTestId('resolved').textContent).toBe('light');
    listeners.forEach((listener) => listener({ matches: true }));
    await waitFor(() => expect(screen.getByTestId('resolved').textContent).toBe('light'));
  });

  it('subscribes to system media only when mode is system and cleans up on change/unmount', async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener,
      removeEventListener,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }));

    window.localStorage.setItem(STORAGE_KEY, 'dark');
    const { unmount } = render(
      <AppThemeProvider>
        <ModeSwitcher />
      </AppThemeProvider>
    );

    expect(addEventListener).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('System'));
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('system'));
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Light'));
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('light'));
    expect(removeEventListener).toHaveBeenCalledTimes(1);

    addEventListener.mockClear();
    removeEventListener.mockClear();
    fireEvent.click(screen.getByText('System'));
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('system'));
    expect(addEventListener).toHaveBeenCalledTimes(1);

    unmount();
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });
});
