import { useMemo, useState } from 'react';
import {
  Box,
  Chip,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { change, fmtDay, fmtPct } from './formatters';

/**
 * One number with its label, and how it moved against the previous period.
 * `lowerIsBetter` flips the colour for things like latency and error rates.
 */
export function StatTile({ label, value, caption, after, before, lowerIsBetter = false }) {
  const delta = change(after, before);
  let color = 'default';
  if (delta !== null && Math.abs(delta) >= 0.05) {
    const better = lowerIsBetter ? delta < 0 : delta > 0;
    color = better ? 'success' : 'error';
  }
  return (
    <Paper variant="outlined" sx={{ p: 2, flex: 1, minWidth: 150 }}>
      <Typography variant="subtitle2" color="text.secondary">
        {label}
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="h4" component="div">
          {value}
        </Typography>
        {delta !== null && (
          <Chip
            size="small"
            color={color}
            variant="outlined"
            label={`${delta > 0 ? '+' : ''}${fmtPct(delta, 0)}`}
            title="Compared with the day before"
          />
        )}
      </Box>
      {caption && (
        <Typography variant="caption" color="text.secondary">
          {caption}
        </Typography>
      )}
    </Paper>
  );
}

export function SectionTitle({ children, subtitle }) {
  return (
    <Box sx={{ mt: 4, mb: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box sx={{ width: 4, height: 22, bgcolor: 'primary.main', borderRadius: 1 }} />
        <Typography variant="h6">{children}</Typography>
      </Box>
      {subtitle && (
        <Typography variant="body2" color="text.secondary" sx={{ ml: 1.5, mt: 0.5 }}>
          {subtitle}
        </Typography>
      )}
    </Box>
  );
}

export function EmptyState({ children }) {
  return (
    <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}>
      <Typography color="text.secondary">{children}</Typography>
    </Paper>
  );
}

/**
 * A line per series over days. `series` is [{ key, label, color }] and each
 * row of `data` is { day, [key]: number }. Today's point is partial and marked
 * so in the tooltip.
 */
export function TrendChart({ data, series, height = 260, format = (v) => v }) {
  const theme = useTheme();
  const rows = useMemo(() => data.map((d) => ({ ...d, label: d.partial ? `${fmtDay(d.day)} (so far)` : fmtDay(d.day) })), [data]);
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={theme.palette.divider} />
          <XAxis dataKey="label" tick={{ fontSize: 12, fill: theme.palette.text.secondary }} />
          <YAxis tick={{ fontSize: 12, fill: theme.palette.text.secondary }} tickFormatter={format} width={56} />
          <Tooltip
            formatter={(v, name) => [v === null ? '—' : format(v), name]}
            contentStyle={{ background: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}
          />
          <Legend />
          {series.map((s) => (
            <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </Paper>
  );
}

/**
 * A small sortable table. `columns` is [{ key, label, align, render, sortValue }].
 */
export function SortableTable({ columns, rows, initialSort, initialDirection = 'desc', empty = 'Nothing yet.', maxRows = 50, rowKey }) {
  const [sortKey, setSortKey] = useState(initialSort || columns[0]?.key);
  const [direction, setDirection] = useState(initialDirection);

  const sorted = useMemo(() => {
    const column = columns.find((c) => c.key === sortKey);
    const value = column?.sortValue || ((row) => row[sortKey]);
    return [...rows].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      const cmp = x > y ? 1 : -1;
      return direction === 'asc' ? cmp : -cmp;
    });
  }, [rows, columns, sortKey, direction]);

  if (!rows.length) return <EmptyState>{empty}</EmptyState>;

  const onSort = (key) => {
    if (key === sortKey) setDirection(direction === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(key);
      setDirection('desc');
    }
  };

  return (
    <TableContainer component={Paper} variant="outlined">
      <Table size="small">
        <TableHead>
          <TableRow>
            {columns.map((c) => (
              <TableCell key={c.key} align={c.align || 'left'} sortDirection={sortKey === c.key ? direction : false}>
                <TableSortLabel active={sortKey === c.key} direction={sortKey === c.key ? direction : 'desc'} onClick={() => onSort(c.key)}>
                  {c.label}
                </TableSortLabel>
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {sorted.slice(0, maxRows).map((row, i) => (
            <TableRow key={rowKey ? rowKey(row) : i} hover>
              {columns.map((c) => (
                <TableCell key={c.key} align={c.align || 'left'} sx={c.mono ? { fontFamily: 'monospace', fontSize: 13 } : undefined}>
                  {c.render ? c.render(row) : row[c.key]}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {sorted.length > maxRows && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', p: 1 }}>
          Showing {maxRows} of {sorted.length}.
        </Typography>
      )}
    </TableContainer>
  );
}
