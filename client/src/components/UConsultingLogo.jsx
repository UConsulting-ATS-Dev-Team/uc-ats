import React from 'react';
import UConsultingIcon from '../assets/logos/uconsulting-primary.svg';
import UConsultingIconAlt from '../assets/logos/uconsulting-alternate.svg';
import { useThemeControl } from '../context/ThemeContext';

const UConsultingLogo = ({
  size = 'medium',
  showIcon = true,
  className = '',
  style = {}
}) => {
  const { resolvedMode } = useThemeControl();
  const logoSrc = resolvedMode === 'dark' ? UConsultingIconAlt : UConsultingIcon;

  const sizeStyles = {
    small: {
      container: { fontSize: '1rem', gap: '0.5rem' },
      icon: { height: '1.5rem' },
      text: { fontSize: '1rem' }
    },
    medium: {
      container: { fontSize: '1.5rem', gap: '0.75rem' },
      icon: { height: '2.5rem' },
      text: { fontSize: '1.5rem' }
    },
    large: {
      container: { fontSize: '2rem', gap: '1rem' },
      icon: { height: '3rem' },
      text: { fontSize: '2rem' }
    }
  };

  const currentSize = sizeStyles[size] || sizeStyles.medium;

  return (
    <div
      className={`uconsulting-logo ${className}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        ...currentSize.container,
        ...style
      }}
    >
      {showIcon && (
        <img
          src={logoSrc}
          alt="UConsulting Logo"
          style={{
            width: 'auto',
            ...currentSize.icon
          }}
        />
      )}
      <div style={currentSize.text}>
        <span
          style={{
            fontFamily: 'Montserrat, sans-serif',
            fontWeight: 700,
            color: 'var(--logo-u)'
          }}
        >
          U
        </span>
        <span
          style={{
            fontFamily: 'Montserrat, sans-serif',
            fontWeight: 700,
            color: 'var(--logo-text)'
          }}
        >
          Consulting
        </span>
      </div>
    </div>
  );
};

export default UConsultingLogo;
