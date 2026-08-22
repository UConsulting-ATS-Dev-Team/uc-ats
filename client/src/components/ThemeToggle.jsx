import React from 'react';
import { ToggleButtonGroup, ToggleButton } from '@mui/material';
import {
  ComputerOutlined as SystemIcon,
  LightModeOutlined as LightIcon,
  DarkModeOutlined as DarkIcon,
} from '@mui/icons-material';
import { useThemeControl } from '../context/ThemeContext';

const MODES = [
  { value: 'system', label: 'System', icon: SystemIcon },
  { value: 'light', label: 'Light', icon: LightIcon },
  { value: 'dark', label: 'Dark', icon: DarkIcon },
];

export default function ThemeToggle({ size = 'small', exclusive = true, ...props }) {
  const { mode, setMode } = useThemeControl();

  return (
    <ToggleButtonGroup
      value={mode}
      exclusive={exclusive}
      onChange={(_event, nextMode) => nextMode && setMode(nextMode)}
      aria-label="Theme mode"
      size={size}
      {...props}
      sx={{
        ...(props.sx || {}),
        '& .MuiToggleButton-root': {
          px: { xs: 1, sm: 1.5 },
          minWidth: { xs: 36, sm: 44 },
          minHeight: { xs: 36, sm: 36 },
        },
      }}
    >
      {MODES.map(({ value, label, icon: Icon }) => (
        <ToggleButton
          key={value}
          value={value}
          aria-label={label}
          title={label}
        >
          <Icon fontSize="small" aria-hidden="true" />
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
