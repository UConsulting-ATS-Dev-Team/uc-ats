import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  ListItemText,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  FormatListBulleted as FormatListBulletedIcon,
  Link as LinkIcon,
  Send as SendIcon,
} from '@mui/icons-material';
import apiClient from '../../utils/api';
import { buildImessageUrl, toImessageText } from '../../utils/imessage';

// iMessage to members. The admin picks people by name and writes the message;
// Send opens one group conversation in their own Messages app with both filled
// in. The server never delivers anything - it supplies the members and logs
// that a send was opened.
//
// Message body, template and selected members are owned by the caller: Master
// Communications keeps them in the page so drafts can save them, and
// ImessageSendDialog keeps them for one send from elsewhere in the app.

export default function ImessageComposer({
  body,
  onBodyChange,
  templates,
  selectedTemplate,
  onSelectTemplate,
  memberIds,
  onMemberIdsChange,
  cycleId,
  draftControls = null,
  onSent = () => {},
  onError = () => {},
  onSuccess = () => {},
}) {
  const messageRef = useRef(null);
  const [members, setMembers] = useState([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get('/master-communications/imessage/members')
      .then((data) => {
        if (!cancelled) setMembers(Array.isArray(data?.members) ? data.members : []);
      })
      .catch((e) => {
        if (!cancelled) onError(e.message || 'Failed to load members');
      })
      .finally(() => {
        if (!cancelled) setLoadingMembers(false);
      });
    return () => {
      cancelled = true;
    };
    // Loaded once; the member list does not depend on anything on this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  // A draft can name someone who has since been deactivated; they drop out here.
  const selected = useMemo(() => memberIds.map((id) => byId.get(id)).filter(Boolean), [memberIds, byId]);
  const reachable = selected.filter((m) => m.phoneNumber);
  const unreachable = selected.filter((m) => !m.phoneNumber);
  const withoutPhone = members.filter((m) => !m.phoneNumber).length;
  const text = toImessageText(body);

  const insertMarkdown = (prefix, suffix = '') => {
    const el = messageRef.current;
    if (!el) return;
    const start = el.selectionStart || 0;
    const end = el.selectionEnd || 0;
    const chosen = body.substring(start, end) || 'text';
    onBodyChange(body.substring(0, start) + prefix + chosen + suffix + body.substring(end));
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + prefix.length, start + prefix.length + chosen.length);
    }, 0);
  };

  const addAllMembers = () => {
    // Adds to whoever is already picked rather than replacing them.
    onMemberIdsChange([...new Set([...memberIds, ...members.filter((m) => m.phoneNumber).map((m) => m.id)])]);
  };

  const handleSend = async () => {
    if (!reachable.length || !text) return;
    setSending(true);
    // Open Messages first: that is the send. The log is bookkeeping and must not
    // stand between the admin and the conversation if it fails.
    window.location.href = buildImessageUrl(reachable.map((m) => m.phoneNumber), text);
    try {
      await apiClient.post('/master-communications/imessage/log', {
        recipientIds: reachable.map((m) => m.id),
        body: text,
        templateId: selectedTemplate || undefined,
        cycleId: cycleId || undefined,
      });
      onSuccess(`Opened Messages with ${reachable.length} recipient${reachable.length === 1 ? '' : 's'}`);
      onSent();
    } catch (e) {
      onError(`Messages opened, but the send was not logged: ${e.message || 'unknown error'}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <Stack spacing={2} sx={{ mt: 1 }}>
      <Box>
        <Autocomplete
          multiple
          options={members}
          loading={loadingMembers}
          value={selected}
          onChange={(_, value) => onMemberIdsChange(value.map((m) => m.id))}
          getOptionLabel={(m) => m.fullName || m.email}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          getOptionDisabled={(m) => !m.phoneNumber}
          filterSelectedOptions
          renderOption={(props, m) => {
            const { key, ...rest } = props;
            return (
              <li key={m.id} {...rest}>
                <Avatar src={m.profileImage || undefined} sx={{ width: 28, height: 28, mr: 1.5 }}>
                  {m.fullName?.[0]}
                </Avatar>
                <ListItemText
                  primary={m.fullName}
                  secondary={m.phoneNumber ? `${m.email} · ${m.role}` : 'No phone on file'}
                />
              </li>
            );
          }}
          renderTags={(value, getTagProps) =>
            value.map((m, index) => {
              const { key, ...tagProps } = getTagProps({ index });
              return (
                <Chip
                  key={m.id}
                  {...tagProps}
                  avatar={<Avatar src={m.profileImage || undefined}>{m.fullName?.[0]}</Avatar>}
                  label={m.fullName}
                  size="small"
                />
              );
            })
          }
          renderInput={(params) => (
            <TextField
              {...params}
              label="To"
              placeholder={selected.length ? '' : 'Type a member’s name'}
              InputProps={{
                ...params.InputProps,
                endAdornment: (
                  <>
                    {loadingMembers ? <CircularProgress size={18} /> : null}
                    {params.InputProps.endAdornment}
                  </>
                ),
              }}
            />
          )}
        />
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            {reachable.length} recipient{reachable.length === 1 ? '' : 's'}
            {withoutPhone > 0 && ` · ${withoutPhone} member${withoutPhone === 1 ? ' has' : 's have'} no phone on file (add one in User Management)`}
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          <Button size="small" onClick={addAllMembers} disabled={loadingMembers}>
            Add all active members
          </Button>
          {selected.length > 0 && (
            <Button size="small" onClick={() => onMemberIdsChange([])}>
              Clear
            </Button>
          )}
        </Stack>
        {unreachable.length > 0 && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            {unreachable.map((m) => m.fullName).join(', ')}{' '}
            {unreachable.length === 1 ? 'has' : 'have'} no phone on file and will not be in the chat.
          </Alert>
        )}
      </Box>

      <TextField
        select
        fullWidth
        label="Use Template"
        value={selectedTemplate}
        onChange={(e) => onSelectTemplate(e.target.value)}
        helperText={templates.length ? '' : 'No iMessage templates for this cycle yet. Create one in the Templates tab.'}
      >
        <MenuItem value=""><em>None / Custom</em></MenuItem>
        {templates.map((t) => (
          <MenuItem key={t.id} value={t.id}>{t.name}</MenuItem>
        ))}
      </TextField>

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
        <Box>
          <TextField
            inputRef={messageRef}
            label="Message"
            value={body}
            onChange={(e) => onBodyChange(e.target.value)}
            fullWidth
            multiline
            minRows={8}
          />
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
            <Tooltip title="Link">
              <IconButton size="small" onClick={() => insertMarkdown('[', '](https://)')}>
                <LinkIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Bulleted list">
              <IconButton size="small" onClick={() => insertMarkdown('- ', '')}>
                <FormatListBulletedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Typography variant="caption" color="text.secondary">
              iMessage is plain text: links are written out in full and line breaks are kept.
            </Typography>
          </Stack>
        </Box>

        <Paper variant="outlined" sx={{ p: 2, bgcolor: 'grey.50', minHeight: 200 }}>
          <Typography variant="caption" color="text.secondary" display="block" gutterBottom>
            Preview, as it will appear in Messages
          </Typography>
          {text ? (
            <Box
              sx={{
                ml: 'auto',
                maxWidth: '85%',
                width: 'fit-content',
                px: 1.75,
                py: 1,
                borderRadius: '18px',
                bgcolor: '#0a84ff',
                color: '#fff',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                fontSize: 14,
                lineHeight: 1.4,
              }}
            >
              {text}
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary">Nothing to send yet.</Typography>
          )}
        </Paper>
      </Box>

      {draftControls}

      <Box>
        <Button
          variant="contained"
          startIcon={sending ? <CircularProgress size={18} color="inherit" /> : <SendIcon />}
          onClick={handleSend}
          disabled={sending || !reachable.length || !text}
        >
          Send via iMessage
        </Button>
        <Alert severity="info" sx={{ mt: 1.5 }}>
          This opens a new group chat in the Messages app with the recipients and message filled in,
          and you press send there. It needs a Mac or iPhone signed in to iMessage.
        </Alert>
      </Box>
    </Stack>
  );
}
