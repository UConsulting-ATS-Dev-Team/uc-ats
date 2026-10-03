import { Fragment, useMemo, useState } from 'react';
import {
  Chip,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Typography
} from '@mui/material';
import { DECISION_COLORS, decisionLabel } from '../../utils/liveVoteSelection';
import { DOC_LABELS, DOC_TYPES, score } from '../../utils/reviewDelib';

// Step 3: every candidate the team graded. An admin running the session clicks a
// row to open it for everyone; members see which row is open.

const SORTERS = {
  name: (row) => row.name.toLowerCase(),
  total: (row) => row.total ?? -Infinity,
  resume: (row) => row.perDoc?.resume?.avg ?? -Infinity,
  coverLetter: (row) => row.perDoc?.coverLetter?.avg ?? -Infinity,
  video: (row) => row.perDoc?.video?.avg ?? -Infinity,
  flags: (row) => row.outlierCount * 10 + row.splitDocs
};

export default function AllCandidatesTable({ candidates, currentApplicationId, canOpen, onOpen }) {
  const [sort, setSort] = useState({ by: 'total', desc: true });

  const rows = useMemo(() => {
    const key = SORTERS[sort.by];
    return [...candidates].sort((a, b) => {
      // Sealed rows have nothing to discuss: last whichever way a column sorts.
      if (Boolean(a.locked) !== Boolean(b.locked)) return a.locked ? 1 : -1;
      const x = key(a);
      const y = key(b);
      if (x === y) return a.name.localeCompare(b.name);
      return (x < y ? -1 : 1) * (sort.desc ? -1 : 1);
    });
  }, [candidates, sort]);

  const header = (id, label, align = 'right') => (
    <TableCell align={align} sortDirection={sort.by === id ? (sort.desc ? 'desc' : 'asc') : false}>
      <TableSortLabel
        active={sort.by === id}
        direction={sort.by === id && !sort.desc ? 'asc' : 'desc'}
        onClick={() => setSort((current) => ({ by: id, desc: current.by === id ? !current.desc : id !== 'name' }))}
      >
        {label}
      </TableSortLabel>
    </TableCell>
  );

  return (
    <Paper variant="outlined">
      <TableContainer sx={{ maxHeight: { md: 520 } }}>
        <Table size="small" stickyHeader aria-label="Candidates this team graded">
          <TableHead>
            <TableRow>
              {header('name', 'Candidate', 'left')}
              {DOC_TYPES.map((type) => <Fragment key={type}>{header(type, DOC_LABELS[type])}</Fragment>)}
              {header('total', 'Total')}
              {header('flags', 'Disagreement', 'left')}
              <TableCell>Decision</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => {
              const selected = row.applicationId === currentApplicationId;
              const clickable = canOpen && !row.locked;
              return (
                <TableRow
                  key={row.applicationId}
                  hover={clickable}
                  selected={selected}
                  onClick={clickable ? () => onOpen(row.applicationId) : undefined}
                  onKeyDown={clickable ? (event) => { if (event.key === 'Enter') onOpen(row.applicationId); } : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  aria-selected={selected}
                  sx={{ cursor: clickable ? 'pointer' : 'default' }}
                >
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: selected ? 700 : 500 }}>{row.name}</Typography>
                    {row.major && <Typography variant="caption" color="text.secondary">{row.major}</Typography>}
                  </TableCell>
                  {row.locked ? (
                    <TableCell colSpan={6}>
                      <Chip size="small" label="Sealed" variant="outlined" />
                    </TableCell>
                  ) : (
                    <>
                      {DOC_TYPES.map((type) => {
                        const doc = row.perDoc[type];
                        return (
                          <TableCell key={type} align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: doc.has ? 'text.primary' : 'text.disabled' }}>
                            {doc.has || doc.n ? score(doc.avg) : '–'}
                            {doc.overridden && <Typography component="span" variant="caption" color="primary" title="Includes an override"> *</Typography>}
                          </TableCell>
                        );
                      })}
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{score(row.total)}</TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={0.5}>
                          {row.outlierCount > 0 && <Chip size="small" color="error" label={`${row.outlierCount} outlier${row.outlierCount === 1 ? '' : 's'}`} />}
                          {row.splitDocs > 0 && <Chip size="small" color="warning" label={`${row.splitDocs} split`} />}
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={decisionLabel(row.resumeDecision)}
                          color={row.resumeDecision ? DECISION_COLORS[row.resumeDecision] : 'default'}
                          variant={row.resumeDecision ? 'filled' : 'outlined'}
                        />
                      </TableCell>
                    </>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 2, py: 1 }}>
        Averages per document; * includes an admin override.{canOpen ? ' Click a candidate to open it for everyone.' : ''}
      </Typography>
    </Paper>
  );
}
