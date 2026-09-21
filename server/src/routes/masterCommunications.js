import express from 'express';
import multer from 'multer';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { dedupeMailingListCsv } from '../services/mailingListDedup.js';
import { OUTCOMES } from '../utils/mailingListImport.js';
import {
  listDrafts,
  createDraft,
  updateDraft,
  deleteDraft,
  listTemplates,
  createTemplate,
  listLogs,
  previewMasterCommunication,
  listImessageMembers,
  logImessageSend,
  sendMasterCommunication,
  sendTestCommunication,
  scheduleMessage,
  listScheduledMessages,
  cancelScheduledMessage,
} from '../services/masterCommunications.js';
import {
  listCommunications,
  listCommunicationFacets,
  COMMUNICATION_CATEGORIES,
  COMMUNICATION_CHANNELS,
  COMMUNICATION_STATUSES,
} from '../services/communicationLog.js';
import {
  getDecisionBatch,
  listDecisionBatches,
  previewDecisionEmail,
  requeueFailedDecisionEmails,
  sendDecisionEmails,
  sendDecisionTest,
  setMessagesExcluded,
  updateDecisionTemplate,
} from '../services/decisionBatches.js';

const router = express.Router();

router.get('/templates', requireAuth, requireAdmin, async (req, res) => {
  try {
    const templates = await listTemplates({ cycleId: req.query.cycleId });
    res.json(templates);
  } catch (err) {
    console.error('[GET /api/master-communications/templates]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to list templates' });
  }
});

router.post('/templates', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, subject, body, channel, cycleId } = req.body || {};
    const template = await createTemplate({
      name,
      subject,
      body,
      channel,
      cycleId,
      createdBy: req.user.id,
    });
    res.status(201).json(template);
  } catch (err) {
    console.error('[POST /api/master-communications/templates]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to create template' });
  }
});

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------
// Shared across admins on purpose: comms here are written by one person and
// often finished by another, so there is no per-author scoping on these.

router.get('/drafts', requireAuth, requireAdmin, async (req, res) => {
  try {
    const drafts = await listDrafts({ cycleId: req.query.cycleId });
    res.json({ drafts });
  } catch (error) {
    console.error('[GET /api/master-communications/drafts]', error);
    res.status(error.status || 500).json({ error: error.message || 'Failed to load drafts' });
  }
});

router.post('/drafts', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, channel, audience, filters, subject, body, cycleId } = req.body || {};
    const draft = await createDraft({
      name,
      channel,
      audience,
      filters,
      subject,
      body,
      cycleId,
      createdById: req.user.id,
    });
    res.status(201).json({ draft });
  } catch (error) {
    console.error('[POST /api/master-communications/drafts]', error);
    res.status(error.status || 500).json({ error: error.message || 'Failed to save draft' });
  }
});

router.patch('/drafts/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const draft = await updateDraft({
      id: req.params.id,
      updatedById: req.user.id,
      ...(req.body || {}),
    });
    res.json({ draft });
  } catch (error) {
    console.error('[PATCH /api/master-communications/drafts/:id]', error);
    res.status(error.status || 500).json({ error: error.message || 'Failed to update draft' });
  }
});

router.delete('/drafts/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await deleteDraft({ id: req.params.id }));
  } catch (error) {
    console.error('[DELETE /api/master-communications/drafts/:id]', error);
    res.status(error.status || 500).json({ error: error.message || 'Failed to delete draft' });
  }
});

// ---------------------------------------------------------------------------
// Decision emails
// ---------------------------------------------------------------------------
// Queued by Process All Decisions on Staging, which sends nothing itself. They
// leave only from here: an admin reviews one outcome's wording and recipients
// and approves that send (see services/decisionBatches.js).

const decisionRoute = (label, handler) => async (req, res) => {
  try {
    res.json(await handler(req));
  } catch (error) {
    if (!error.status) console.error(`[${label}]`, error);
    res.status(error.status || 500).json({ error: error.message || 'Decision email request failed' });
  }
};

router.get('/decision-batches', requireAuth, requireAdmin, decisionRoute(
  'GET /api/master-communications/decision-batches',
  (req) => listDecisionBatches({ cycleId: req.query.cycleId })
));

router.get('/decision-batches/:id', requireAuth, requireAdmin, decisionRoute(
  'GET /api/master-communications/decision-batches/:id',
  (req) => getDecisionBatch(req.params.id)
));

router.patch('/decision-batches/:id/templates', requireAuth, requireAdmin, decisionRoute(
  'PATCH /api/master-communications/decision-batches/:id/templates',
  (req) => updateDecisionTemplate({ batchId: req.params.id, ...(req.body || {}) })
));

router.patch('/decision-batches/:id/messages', requireAuth, requireAdmin, decisionRoute(
  'PATCH /api/master-communications/decision-batches/:id/messages',
  (req) => setMessagesExcluded({
    batchId: req.params.id,
    messageIds: req.body?.messageIds,
    excluded: Boolean(req.body?.excluded),
  })
));

router.post('/decision-batches/:id/preview', requireAuth, requireAdmin, decisionRoute(
  'POST /api/master-communications/decision-batches/:id/preview',
  (req) => previewDecisionEmail({ batchId: req.params.id, outcome: req.body?.outcome, messageId: req.body?.messageId })
));

router.post('/decision-batches/:id/test', requireAuth, requireAdmin, decisionRoute(
  'POST /api/master-communications/decision-batches/:id/test',
  (req) => sendDecisionTest({ batchId: req.params.id, outcome: req.body?.outcome, user: req.user })
));

router.post('/decision-batches/:id/send', requireAuth, requireAdmin, decisionRoute(
  'POST /api/master-communications/decision-batches/:id/send',
  (req) => sendDecisionEmails({
    batchId: req.params.id,
    outcome: req.body?.outcome,
    expectedCount: req.body?.expectedCount,
    sentBy: req.user.id,
  })
));

router.post('/decision-batches/:id/retry', requireAuth, requireAdmin, decisionRoute(
  'POST /api/master-communications/decision-batches/:id/retry',
  (req) => requeueFailedDecisionEmails({ batchId: req.params.id, outcome: req.body?.outcome })
));

router.get('/logs', requireAuth, requireAdmin, async (req, res) => {
  try {
    const logs = await listLogs({
      cycleId: req.query.cycleId,
      limit: req.query.limit,
    });
    res.json(logs);
  } catch (err) {
    console.error('[GET /api/master-communications/logs]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to list logs' });
  }
});

/**
 * Everything this system has ever sent, one row per recipient - the automated
 * mail as well as what an admin composed here. `/logs` above stays what it was:
 * the campaign-level record of a bulk send.
 */
router.get('/communications', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await listCommunications({
      cycleId: req.query.cycleId,
      channel: req.query.channel,
      category: req.query.category,
      status: req.query.status,
      trigger: req.query.trigger,
      search: req.query.search,
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json(result);
  } catch (err) {
    console.error('[GET /api/master-communications/communications]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to list communications' });
  }
});

// What the filters can offer: the full vocabulary, plus the values actually
// present so the dropdowns can show counts and hide what never happened.
router.get('/communications/facets', requireAuth, requireAdmin, async (req, res) => {
  try {
    const present = await listCommunicationFacets({ cycleId: req.query.cycleId });
    res.json({
      ...present,
      known: {
        channels: COMMUNICATION_CHANNELS,
        categories: COMMUNICATION_CATEGORIES,
        statuses: COMMUNICATION_STATUSES,
      },
    });
  } catch (err) {
    console.error('[GET /api/master-communications/communications/facets]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to load filters' });
  }
});

router.get('/schedule', requireAuth, requireAdmin, async (req, res) => {
  try {
    const messages = await listScheduledMessages({
      cycleId: req.query.cycleId,
      status: req.query.status,
      limit: req.query.limit,
    });
    res.json(messages);
  } catch (err) {
    console.error('[GET /api/master-communications/schedule]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to list scheduled messages' });
  }
});

router.post('/schedule', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { channel, audience, filters, subject, body, cycleId, templateId, scheduledAt } = req.body || {};

    if (!channel || !audience || !body || !scheduledAt) {
      return res.status(400).json({ error: 'channel, audience, body, and scheduledAt are required' });
    }

    if (channel === 'email' && !subject) {
      return res.status(400).json({ error: 'subject is required for email' });
    }

    const result = await scheduleMessage({
      channel,
      audience,
      filters,
      subject,
      body,
      cycleId,
      templateId,
      sentBy: req.user.id,
      scheduledAt,
    });
    res.status(201).json(result);
  } catch (err) {
    console.error('[POST /api/master-communications/schedule]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to schedule message' });
  }
});

router.delete('/schedule/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await cancelScheduledMessage({
      id: req.params.id,
      sentBy: req.user.id,
    });
    res.json(result);
  } catch (err) {
    console.error('[DELETE /api/master-communications/schedule/:id]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to cancel scheduled message' });
  }
});

router.post('/preview', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { audience, filters } = req.body || {};
    if (!audience) {
      return res.status(400).json({ error: 'audience is required' });
    }
    const result = await previewMasterCommunication({ audience, filters });
    res.json(result);
  } catch (err) {
    console.error('[POST /api/master-communications/preview]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to preview recipients' });
  }
});

router.post('/send', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { audience, channel, filters, subject, body, cycleId, templateId } = req.body || {};

    if (!audience || !channel || !body) {
      return res.status(400).json({ error: 'audience, channel, and body are required' });
    }

    if (channel === 'email' && !subject) {
      return res.status(400).json({ error: 'subject is required for email' });
    }

    const result = await sendMasterCommunication({
      audience,
      channel,
      filters,
      subject,
      body,
      sentBy: req.user.id,
      cycleId,
      templateId,
    });
    res.json(result);
  } catch (err) {
    console.error('[POST /api/master-communications/send]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to send communication' });
  }
});

router.post('/test', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { audience, filters, subject, body } = req.body || {};

    if (!audience || !subject || !body) {
      return res.status(400).json({ error: 'audience, subject, and body are required' });
    }

    const result = await sendTestCommunication({
      audience,
      filters,
      subject,
      body,
      user: req.user,
    });
    res.json(result);
  } catch (err) {
    console.error('[POST /api/master-communications/test]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to send test email' });
  }
});

// ---------------------------------------------------------------------------
// iMessage (members only)
// ---------------------------------------------------------------------------
// The message itself leaves from the admin's Messages app via an sms:// link;
// these routes only supply the people and record the send.

router.get('/imessage/members', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json({ members: await listImessageMembers() });
  } catch (err) {
    console.error('[GET /api/master-communications/imessage/members]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to load members' });
  }
});

router.post('/imessage/log', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { recipientIds, body, templateId, cycleId } = req.body || {};
    const result = await logImessageSend({ recipientIds, body, templateId, cycleId, sentBy: req.user.id });
    res.status(201).json(result);
  } catch (err) {
    if (!err.status) console.error('[POST /api/master-communications/imessage/log]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to log iMessage' });
  }
});

// Mailing list -------------------------------------------------------------
//
// The recruiting-interest mailing list is being retired. An admin uploads the
// export here and gets back what survives dedup against the ATS, plus a full
// account of what was dropped and why. Nothing is written: the server holds the
// file only for the length of the request, and the survivors go back in the
// response for the browser to save.
//
// scripts/import-mailing-list-csv.js is the same operation from the command
// line, and uploads to Drive instead of downloading.

const CSV_MAX_BYTES = 5 * 1024 * 1024;

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CSV_MAX_BYTES },
  fileFilter(req, file, cb) {
    // On the extension alone, deliberately. The browser-reported type is wrong
    // in both directions - Windows sends .csv as application/vnd.ms-excel, and
    // anything at all can claim to be text/csv - so accepting either one lets a
    // PDF through to be parsed into garbage rows. What the admin picked in the
    // file dialog is the honest signal.
    if (/\.csv$/i.test(file.originalname || '')) cb(null, true);
    else cb(new Error('Mailing list must be a .csv file'));
  },
});

// There is no global Express error handler in this app, so an unwrapped multer
// rejection returns an HTML 500 the client renders as "Server Error (500):
// <!doctype html...". Same wrapper as talent.js and member.js.
function csvUploadMiddleware(req, res, next) {
  csvUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Mailing list must be 5MB or smaller' });
    }
    return res.status(400).json({ error: err.message || 'Invalid file upload' });
  });
}

router.post('/mailing-list/dedupe', requireAuth, requireAdmin, csvUploadMiddleware, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const emailColumnOverride = req.body?.emailColumn || undefined;
    const run = await dedupeMailingListCsv({
      content: req.file.buffer.toString('utf-8'),
      emailColumnOverride,
    });

    if (!run.headers.length) {
      return res.status(400).json({ error: 'That file has no rows in it' });
    }

    // A file whose email column cannot be found is not an error. The admin gets
    // the headers back and picks the column by hand, which is the browser's
    // version of the script's --email-col.
    if (!run.emailColumn) {
      return res.json({
        fileName: req.file.originalname,
        headers: run.headers,
        emailColumn: null,
        rows: run.records.length,
        // Says which of the two happened: a bad guess the admin made, or no
        // guess this code could make. The UI wording differs.
        overrideMissed: Boolean(emailColumnOverride),
      });
    }

    res.json({
      fileName: req.file.originalname,
      headers: run.headers,
      emailColumn: run.emailColumn,
      rows: run.records.length,
      knownAddresses: run.knownAddresses,
      summary: run.summary,
      keptCount: run.kept.length,
      // Every dropped row with its line number and reason, so the run can be
      // reconciled against the source spreadsheet. A bare survivor count
      // cannot be checked by anyone.
      dropped: run.results
        .filter((r) => r.outcome !== OUTCOMES.KEPT)
        .map(({ line, email, raw, outcome, sources, firstSeenAt }) => ({
          line, email, raw, outcome, sources, firstSeenAt,
        })),
      csv: run.csv,
    });
  } catch (err) {
    console.error('[POST /api/master-communications/mailing-list/dedupe]', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to read that mailing list' });
  }
});

export default router;
