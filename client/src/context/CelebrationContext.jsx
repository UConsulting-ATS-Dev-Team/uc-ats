import React, { createContext, useContext, useCallback, useRef, useState, useEffect } from 'react';
import confetti from 'canvas-confetti';
import { isPreviewActive } from '../utils/previewMode';

const CelebrationContext = createContext(null);

const ALLOWED_EVENTS = new Set(['deliberations-completed', 'cycle-closed']);
const CELEBRATION_COOLDOWN_MS = 2000;

const EMOJI_PARTICLES = ['🎉', '✨', '🎊', '🌟', '💫', '🥳', '🎯', '🔥', '🚀', '👏', '🏆', '⭐'];

function getPrefersReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const EmojiConfetti = ({ active }) => {
  if (!active) return null;

  const particles = Array.from({ length: 30 }, (_, i) => {
    const emoji = EMOJI_PARTICLES[Math.floor(Math.random() * EMOJI_PARTICLES.length)];
    const left = Math.random() * 100;
    const delay = Math.random() * 0.5;
    const duration = 2 + Math.random() * 2;
    const size = 20 + Math.random() * 30;

    return (
      <span
        key={i}
        style={{
          position: 'fixed',
          left: `${left}%`,
          top: '-40px',
          fontSize: `${size}px`,
          zIndex: 99999,
          pointerEvents: 'none',
          animation: `celebration-fall ${duration}s ease-in ${delay}s forwards`,
          userSelect: 'none'
        }}
      >
        {emoji}
      </span>
    );
  });

  return (
    <>
      <style>{`
        @keyframes celebration-fall {
          0% {
            transform: translateY(0) rotate(0deg) scale(1);
            opacity: 1;
          }
          80% {
            opacity: 1;
          }
          100% {
            transform: translateY(calc(100vh + 60px)) rotate(${360 + Math.random() * 720}deg) scale(0.5);
            opacity: 0;
          }
        }
      `}</style>
      {particles}
    </>
  );
};

const StaticSuccess = ({ active }) => {
  if (!active) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: '24px',
        transform: 'translateX(-50%)',
        padding: '12px 24px',
        backgroundColor: '#ffffff',
        border: '2px solid #4ecdc4',
        borderRadius: '8px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        zIndex: 99999,
        pointerEvents: 'none',
        fontSize: '1rem',
        fontWeight: 600,
        color: '#2c3e50',
        display: 'flex',
        alignItems: 'center',
        gap: '8px'
      }}
    >
      <span aria-hidden="true">🎉</span>
      <span>Milestone completed</span>
    </div>
  );
};

export const CelebrationProvider = ({ children }) => {
  const [showFallback, setShowFallback] = useState(false);
  const [showStaticSuccess, setShowStaticSuccess] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(getPrefersReducedMotion);
  const fallbackTimeout = useRef(null);
  const staticSuccessTimeout = useRef(null);
  const confettiTimeouts = useRef([]);
  const mountedRef = useRef(true);
  const lastTriggerRef = useRef({ eventName: null, at: 0 });

  const clearAllTimeouts = useCallback(() => {
    if (fallbackTimeout.current) {
      clearTimeout(fallbackTimeout.current);
      fallbackTimeout.current = null;
    }
    if (staticSuccessTimeout.current) {
      clearTimeout(staticSuccessTimeout.current);
      staticSuccessTimeout.current = null;
    }
    confettiTimeouts.current.forEach((id) => clearTimeout(id));
    confettiTimeouts.current = [];
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    setPrefersReducedMotion(getPrefersReducedMotion());

    let mediaQuery = null;
    let handleChange = null;

    if (typeof window !== 'undefined' && window.matchMedia) {
      mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      handleChange = () => setPrefersReducedMotion(mediaQuery.matches);
      if (mediaQuery.addEventListener) {
        mediaQuery.addEventListener('change', handleChange);
      } else if (mediaQuery.addListener) {
        mediaQuery.addListener(handleChange);
      }
    }

    return () => {
      mountedRef.current = false;
      clearAllTimeouts();
      if (mediaQuery && handleChange) {
        if (mediaQuery.removeEventListener) {
          mediaQuery.removeEventListener('change', handleChange);
        } else if (mediaQuery.removeListener) {
          mediaQuery.removeListener(handleChange);
        }
      }
    };
  }, [clearAllTimeouts]);

  const hideStaticSuccess = useCallback(() => {
    if (!mountedRef.current) return;
    setShowStaticSuccess(false);
  }, []);

  const showStaticSuccessState = useCallback(() => {
    if (!mountedRef.current) return;
    clearAllTimeouts();
    setShowStaticSuccess(true);
    staticSuccessTimeout.current = setTimeout(hideStaticSuccess, 2000);
  }, [clearAllTimeouts, hideStaticSuccess]);

  const triggerFallback = useCallback(() => {
    if (!mountedRef.current) return;
    setShowFallback(true);
    clearAllTimeouts();
    fallbackTimeout.current = setTimeout(() => {
      if (mountedRef.current) {
        setShowFallback(false);
      }
    }, 3000);
  }, [clearAllTimeouts]);

  const fireConfetti = useCallback(() => {
    if (!mountedRef.current) return;

    try {
      clearAllTimeouts();

      const fire = (config) => {
        if (!mountedRef.current) return;
        confetti(config);
      };

      fire({
        particleCount: 60,
        spread: 70,
        origin: { x: 0.25, y: 0.5 },
        colors: ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57', '#ff9ff3'],
        ticks: 200
      });

      const id1 = setTimeout(() => {
        fire({
          particleCount: 60,
          spread: 70,
          origin: { x: 0.75, y: 0.5 },
          colors: ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57', '#ff9ff3'],
          ticks: 200
        });
      }, 150);

      const id2 = setTimeout(() => {
        fire({
          particleCount: 100,
          spread: 100,
          origin: { x: 0.5, y: 0.4 },
          colors: ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57', '#ff9ff3'],
          ticks: 200,
          startVelocity: 35,
          gravity: 0.8,
          scalar: 1.2
        });
      }, 300);

      confettiTimeouts.current = [id1, id2];
    } catch {
      triggerFallback();
    }
  }, [clearAllTimeouts, triggerFallback]);

  const triggerCelebration = useCallback((eventName) => {
    if (!mountedRef.current) return;

    if (!ALLOWED_EVENTS.has(eventName)) {
      return;
    }

    const now = Date.now();
    const last = lastTriggerRef.current;
    if (last.eventName === eventName && now - last.at < CELEBRATION_COOLDOWN_MS) {
      return;
    }
    lastTriggerRef.current = { eventName, at: now };

    clearAllTimeouts();

    if (isPreviewActive()) return;

    if (prefersReducedMotion) {
      showStaticSuccessState();
      return;
    }

    fireConfetti();
  }, [prefersReducedMotion, showStaticSuccessState, fireConfetti, clearAllTimeouts]);

  return (
    <CelebrationContext.Provider value={{ triggerCelebration, prefersReducedMotion }}>
      {children}
      <EmojiConfetti active={showFallback} />
      <StaticSuccess active={showStaticSuccess} />
    </CelebrationContext.Provider>
  );
};

export const useCelebration = () => {
  const context = useContext(CelebrationContext);
  if (!context) {
    throw new Error('useCelebration must be used within a CelebrationProvider');
  }
  return context;
};

export default CelebrationContext;
