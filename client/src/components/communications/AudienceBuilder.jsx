import React, { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Paper,
  Stack,
  Typography,
  TextField,
  MenuItem,
  ListSubheader,
  Button,
  IconButton,
  Tooltip,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
} from '@mui/material';
import {
  Add as AddIcon,
  Close as CloseIcon,
  PlaylistAdd as PlaylistAddIcon,
  Bookmark as BookmarkIcon,
} from '@mui/icons-material';
import apiClient from '../../utils/api';
import {
  RULES,
  RULE_GROUPS,
  countRules,
  emptyTree,
  makeGroup,
  makeRule,
  presets,
  toServerTree,
  withIds,
} from './audienceRules';

// The filter builder for "Filtered audience": groups of rules combined with
// ALL / ANY, any of which can be flipped to "is not". Saved audiences are named
// trees kept on the server and re-run at send time, so the picker below loads
// one into the editor; editing it afterwards leaves the saved copy alone until
// "Update" is pressed.

const SELECT_PROPS = { MenuProps: { PaperProps: { style: { maxHeight: 320 } } } };

// ---------------------------------------------------------------------------
// Parameter editors
// ---------------------------------------------------------------------------

const dateOnly = (value) => (value ? String(value).slice(0, 10) : '');

function CsvField({ label, value, onChange }) {
  // Kept as text while typing so a trailing comma survives; committed on blur.
  const [text, setText] = useState((value || []).join(', '));
  useEffect(() => setText((value || []).join(', ')), [value]);
  const commit = () => onChange(text.split(',').map((s) => s.trim()).filter(Boolean));
  return (
    <TextField
      size="small"
      label={label}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      sx={{ minWidth: 220 }}
    />
  );
}

function FieldEditor({ field, params, onParam, options }) {
  const value = params[field.key];
  const multi = (items, render) => (
    <TextField
      select
      size="small"
      label={field.label}
      value={value || []}
      onChange={(e) => onParam(field.key, e.target.value)}
      SelectProps={{ multiple: true, ...SELECT_PROPS, renderValue: (sel) => sel.map(render).join(', ') }}
      sx={{ minWidth: 220, maxWidth: 360 }}
    >
      {items.map((item) => (
        <MenuItem key={item.value} value={item.value}>{item.label}</MenuItem>
      ))}
    </TextField>
  );
  const labelOf = (items) => (v) => items.find((i) => i.value === v)?.label || v;

  switch (field.kind) {
    case 'cycles':
      return multi(options.cycles, labelOf(options.cycles));
    case 'events':
      return multi(options.events, labelOf(options.events));
    case 'campaigns':
      return multi(options.campaigns, labelOf(options.campaigns));
    case 'imports':
      return multi(options.imports, labelOf(options.imports));
    case 'multi':
      return multi(field.options, labelOf(field.options));
    case 'select':
      return (
        <TextField
          select
          size="small"
          label={field.label}
          value={value ?? ''}
          onChange={(e) => onParam(field.key, e.target.value)}
          sx={{ minWidth: 200 }}
        >
          {field.options.map((o) => (
            <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
          ))}
        </TextField>
      );
    case 'triBool':
      return (
        <TextField
          select
          size="small"
          label={field.label}
          value={value === true ? 'yes' : value === false ? 'no' : 'any'}
          onChange={(e) => onParam(field.key, e.target.value === 'any' ? undefined : e.target.value === 'yes')}
          sx={{ minWidth: 140 }}
        >
          <MenuItem value="any">Either</MenuItem>
          <MenuItem value="yes">Yes</MenuItem>
          <MenuItem value="no">No</MenuItem>
        </TextField>
      );
    case 'date':
      return (
        <TextField
          size="small"
          type="date"
          label={field.label}
          value={dateOnly(value)}
          InputLabelProps={{ shrink: true }}
          onChange={(e) => {
            const v = e.target.value;
            // "On or before" includes the whole of that day.
            onParam(field.key, v ? `${v}T${field.key.endsWith('To') ? '23:59:59' : '00:00:00'}` : undefined);
          }}
        />
      );
    case 'int':
      return (
        <TextField
          size="small"
          type="number"
          label={field.label}
          value={value ?? ''}
          onChange={(e) => onParam(field.key, e.target.value === '' ? undefined : Number(e.target.value))}
          sx={{ width: 150 }}
        />
      );
    case 'csv':
      return <CsvField label={field.label} value={value} onChange={(v) => onParam(field.key, v)} />;
    default:
      return null;
  }
}

function RuleRow({ node, onChange, onRemove, options }) {
  const def = RULES[node.type];
  if (!def) {
    return <Alert severity="warning" onClose={onRemove}>Unknown filter “{node.type}”.</Alert>;
  }
  const onParam = (key, value) => onChange({ ...node, params: { ...node.params, [key]: value } });

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
        <TextField
          select
          size="small"
          value={node.negate ? 'not' : 'is'}
          onChange={(e) => onChange({ ...node, negate: e.target.value === 'not' })}
          sx={{ width: 96 }}
          inputProps={{ 'aria-label': 'Include or exclude' }}
        >
          <MenuItem value="is">Is</MenuItem>
          <MenuItem value="not">Is not</MenuItem>
        </TextField>
        <Typography variant="body2" fontWeight={600} sx={{ minWidth: 150 }}>
          {def.label}
        </Typography>
        {def.fields
          .filter((f) => !f.showIf || f.showIf(node.params))
          .map((field) => (
            <FieldEditor key={field.key} field={field} params={node.params} onParam={onParam} options={options} />
          ))}
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title="Remove filter">
          <IconButton size="small" onClick={onRemove} aria-label="Remove filter">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
    </Paper>
  );
}

function AddRuleMenu({ onAdd }) {
  const items = [];
  for (const group of RULE_GROUPS) {
    items.push(<ListSubheader key={`h-${group}`}>{group}</ListSubheader>);
    for (const [type, def] of Object.entries(RULES)) {
      if (def.group === group) items.push(<MenuItem key={type} value={type}>{def.label}</MenuItem>);
    }
  }
  return (
    <TextField
      select
      size="small"
      label="Add filter"
      value=""
      onChange={(e) => e.target.value && onAdd(e.target.value)}
      SelectProps={SELECT_PROPS}
      sx={{ minWidth: 200 }}
    >
      {items}
    </TextField>
  );
}

function GroupEditor({ node, isRoot, onChange, onRemove, options, depth = 1 }) {
  const setChild = (child) => onChange({ ...node, children: node.children.map((c) => (c.id === child.id ? child : c)) });
  const dropChild = (id) => onChange({ ...node, children: node.children.filter((c) => c.id !== id) });

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.5,
        bgcolor: depth % 2 === 0 ? 'action.hover' : 'background.paper',
        borderColor: node.negate ? 'error.light' : undefined,
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
        {!isRoot && (
          <TextField
            select
            size="small"
            value={node.negate ? 'not' : 'is'}
            onChange={(e) => onChange({ ...node, negate: e.target.value === 'not' })}
            sx={{ width: 150 }}
            inputProps={{ 'aria-label': 'Include or exclude group' }}
          >
            <MenuItem value="is">Include</MenuItem>
            <MenuItem value="not">Exclude</MenuItem>
          </TextField>
        )}
        <TextField
          select
          size="small"
          value={node.op}
          onChange={(e) => onChange({ ...node, op: e.target.value })}
          sx={{ width: 230 }}
          inputProps={{ 'aria-label': 'Match all or any' }}
        >
          <MenuItem value="AND">people matching ALL of</MenuItem>
          <MenuItem value="OR">people matching ANY of</MenuItem>
        </TextField>
        <Box sx={{ flexGrow: 1 }} />
        {!isRoot && (
          <Tooltip title="Remove group">
            <IconButton size="small" onClick={onRemove} aria-label="Remove group">
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      <Stack spacing={1}>
        {node.children.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1 }}>
            No filters yet.
          </Typography>
        )}
        {node.children.map((child) =>
          child.kind === 'group' ? (
            <GroupEditor
              key={child.id}
              node={child}
              onChange={setChild}
              onRemove={() => dropChild(child.id)}
              options={options}
              depth={depth + 1}
            />
          ) : (
            <RuleRow
              key={child.id}
              node={child}
              onChange={setChild}
              onRemove={() => dropChild(child.id)}
              options={options}
            />
          )
        )}
      </Stack>

      <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} alignItems="center">
        <AddRuleMenu onAdd={(type) => onChange({ ...node, children: [...node.children, makeRule(type)] })} />
        {depth < 4 && (
          <Button
            size="small"
            startIcon={<PlaylistAddIcon />}
            onClick={() => onChange({ ...node, children: [...node.children, makeGroup(node.op === 'AND' ? 'OR' : 'AND')] })}
          >
            Add group
          </Button>
        )}
      </Stack>
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Saved audiences + presets
// ---------------------------------------------------------------------------

function SaveDialog({ open, onClose, onSave }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
    }
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Save audience</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField autoFocus label="Name" value={name} onChange={(e) => setName(e.target.value)} fullWidth />
          <TextField
            label="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            fullWidth
            multiline
            minRows={2}
          />
          <Typography variant="caption" color="text.secondary">
            Saved audiences keep the filters, not the people. Each send reaches whoever matches on the day.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!name.trim()} onClick={() => onSave({ name: name.trim(), description })}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Controlled: the parent owns `tree` and `savedAudienceId`, because drafts and
 * sends need both. `savedAudienceId` is only set while the tree is exactly the
 * saved one - any edit clears it, so a send never claims to be a saved
 * audience it no longer matches.
 */
export default function AudienceBuilder({ tree, savedAudienceId, onChange, cycles = [], events = [], onError, onSuccess }) {
  const [saved, setSaved] = useState([]);
  const [remote, setRemote] = useState({ campaigns: [], mailingListImports: [] });
  const [saveOpen, setSaveOpen] = useState(false);

  const loadSaved = async () => {
    try {
      const data = await apiClient.get('/master-communications/audiences');
      setSaved(data.audiences || []);
    } catch (e) {
      onError?.(e.message || 'Failed to load saved audiences');
    }
  };

  useEffect(() => {
    loadSaved();
    apiClient
      .get('/master-communications/audience-options')
      .then((data) => setRemote({ campaigns: data.campaigns || [], mailingListImports: data.mailingListImports || [] }))
      .catch(() => {});
  }, []);

  const options = useMemo(() => {
    const cycleName = Object.fromEntries(cycles.map((c) => [c.id, c.name]));
    return {
      cycles: cycles.map((c) => ({ value: c.id, label: c.name })),
      events: [...events]
        .sort((a, b) => new Date(b.eventStartDate) - new Date(a.eventStartDate))
        .map((e) => ({
          value: e.id,
          label: `${e.eventName}${cycleName[e.cycleId] ? ` · ${cycleName[e.cycleId]}` : ''}`,
        })),
      campaigns: remote.campaigns.map((c) => ({
        value: c.id,
        label: `${c.subject || '(no subject)'} · ${new Date(c.sentAt).toLocaleDateString()} · ${c.recipientCount}`,
      })),
      imports: remote.mailingListImports.map((i) => ({ value: i.sourceFile, label: `${i.sourceFile} (${i.count})` })),
    };
  }, [cycles, events, remote]);

  const activeCycleIds = useMemo(() => cycles.filter((c) => c.isActive).map((c) => c.id), [cycles]);
  const presetList = useMemo(() => presets({ activeCycleIds }), [activeCycleIds]);
  const current = saved.find((s) => s.id === savedAudienceId) || null;

  const edit = (root) => onChange({ tree: { ...tree, root }, savedAudienceId: null });

  const pickSaved = (id) => {
    if (!id) {
      onChange({ tree, savedAudienceId: null });
      return;
    }
    const audience = saved.find((s) => s.id === id);
    if (audience) onChange({ tree: withIds(audience.filters), savedAudienceId: audience.id });
  };

  const pickPreset = (key) => {
    const preset = presetList.find((p) => p.key === key);
    if (preset) onChange({ tree: { version: 2, root: preset.build() }, savedAudienceId: null });
  };

  const saveAs = async ({ name, description }) => {
    try {
      const data = await apiClient.post('/master-communications/audiences', {
        name,
        description,
        filters: toServerTree(tree),
      });
      setSaveOpen(false);
      await loadSaved();
      onChange({ tree, savedAudienceId: data.audience.id });
      onSuccess?.(`Saved audience "${name}"`);
    } catch (e) {
      onError?.(e.message || 'Failed to save audience');
    }
  };

  // "Update" is offered after picking a saved audience and editing it: the
  // editor then holds changes the saved copy does not have.
  const [editingSavedId, setEditingSavedId] = useState(null);
  useEffect(() => {
    if (savedAudienceId) setEditingSavedId(savedAudienceId);
  }, [savedAudienceId]);
  const editingSaved = saved.find((s) => s.id === editingSavedId) || null;

  const updateSaved = async () => {
    if (!editingSaved) return;
    try {
      await apiClient.patch(`/master-communications/audiences/${editingSaved.id}`, { filters: toServerTree(tree) });
      await loadSaved();
      onChange({ tree, savedAudienceId: editingSaved.id });
      onSuccess?.(`Updated "${editingSaved.name}"`);
    } catch (e) {
      onError?.(e.message || 'Failed to update audience');
    }
  };

  const deleteSaved = async () => {
    if (!current || !window.confirm(`Delete the saved audience "${current.name}"? Drafts using it keep their own copy of the filters.`)) return;
    try {
      await apiClient.delete(`/master-communications/audiences/${current.id}`);
      setEditingSavedId(null);
      onChange({ tree, savedAudienceId: null });
      await loadSaved();
      onSuccess?.(`Deleted "${current.name}"`);
    } catch (e) {
      onError?.(e.message || 'Failed to delete audience');
    }
  };

  const ruleCount = countRules(tree.root);

  return (
    <Box>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }} sx={{ mb: 1.5 }}>
        <TextField
          select
          size="small"
          label="Saved audience"
          value={savedAudienceId || ''}
          onChange={(e) => pickSaved(e.target.value)}
          SelectProps={SELECT_PROPS}
          sx={{ minWidth: 260 }}
        >
          <MenuItem value=""><em>None: build below</em></MenuItem>
          {saved.map((s) => (
            <MenuItem key={s.id} value={s.id}>
              <Stack>
                <span>{s.name}</span>
                {s.description && (
                  <Typography variant="caption" color="text.secondary">{s.description}</Typography>
                )}
              </Stack>
            </MenuItem>
          ))}
        </TextField>

        <TextField
          select
          size="small"
          label="Start from a preset"
          value=""
          onChange={(e) => pickPreset(e.target.value)}
          SelectProps={SELECT_PROPS}
          sx={{ minWidth: 240 }}
        >
          {presetList.map((p) => (
            <MenuItem key={p.key} value={p.key} sx={{ whiteSpace: 'normal', maxWidth: 420 }}>
              <Stack>
                <span>{p.label}</span>
                <Typography variant="caption" color="text.secondary">{p.description}</Typography>
              </Stack>
            </MenuItem>
          ))}
        </TextField>

        <Box sx={{ flexGrow: 1 }} />

        {current && <Chip icon={<BookmarkIcon />} color="primary" variant="outlined" label={current.name} />}
        {!savedAudienceId && editingSaved && (
          <Button size="small" variant="outlined" onClick={updateSaved} disabled={ruleCount === 0}>
            Update “{editingSaved.name}”
          </Button>
        )}
        <Button size="small" variant="outlined" onClick={() => setSaveOpen(true)} disabled={ruleCount === 0}>
          Save as new
        </Button>
        {current && (
          <Button size="small" color="error" onClick={deleteSaved}>
            Delete
          </Button>
        )}
        {ruleCount > 0 && (
          <Button size="small" onClick={() => onChange({ tree: emptyTree(), savedAudienceId: null })}>
            Clear
          </Button>
        )}
      </Stack>

      {current?.lastUsedAt && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
          Last sent {new Date(current.lastUsedAt).toLocaleDateString()} to {current.lastUsedCount} people.
        </Typography>
      )}

      <GroupEditor node={tree.root} isRoot onChange={edit} options={options} />

      <SaveDialog open={saveOpen} onClose={() => setSaveOpen(false)} onSave={saveAs} />
    </Box>
  );
}
