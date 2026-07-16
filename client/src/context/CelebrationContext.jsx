import React, { createContext, useContext, useCallback, useRef, useState } from 'react';
import { isPreviewActive } from '../utils/previewMode';

const CelebrationContext = createContext(null);

// --- Emoji Fallback Confetti (CSS-only, no canvas-confetti needed) ---
const EMOJI_PARTICLES = ['🎉', '✨', '🎊', '🌟', '💫', '🥳', '🎯', '🔥', '🚀', '👏', '🏆', '⭐'];

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

export const CelebrationProvider = ({ children }) => {
  const [showFallback, setShowFallback] = useState(false);
  const fallbackTimeout = useRef(null);

  const triggerCelebration = useCallback(() => {
    // Never let a celebration pop over the exhibit during candidate preview.
    if (isPreviewActive()) return;
    // Try canvas-confetti first
    try {
      // Dynamically import to avoid issues if the module fails to load
      import('canvas-confetti').then(({ default: confetti }) => {

        // Fire from left
        confetti({
          particleCount: 60,
          spread: 70,
          origin: { x: 0.25, y: 0.5 },
          colors: ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57', '#ff9ff3'],
          ticks: 200
        });

        // Fire from right
        setTimeout(() => {
          confetti({
            particleCount: 60,
            spread: 70,
            origin: { x: 0.75, y: 0.5 },
            colors: ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57', '#ff9ff3'],
            ticks: 200
          });
        }, 150);

        // Center burst
        setTimeout(() => {
          confetti({
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
      }).catch(() => {
        // canvas-confetti failed to load, use fallback
        triggerFallback();
      });
    } catch {
      triggerFallback();
    }
  }, []);

  const triggerFallback = useCallback(() => {
    setShowFallback(true);
    if (fallbackTimeout.current) clearTimeout(fallbackTimeout.current);
    fallbackTimeout.current = setTimeout(() => {
      setShowFallback(false);
    }, 3000);
  }, []);

  return (
    <CelebrationContext.Provider value={{ triggerCelebration }}>
      {children}
      <EmojiConfetti active={showFallback} />
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
