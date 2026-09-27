import { Alert, AlertTitle, Box, Chip, Stack } from '@mui/material';
import { useTheme } from '@mui/material/styles';

import { fmtNum, fmtPct, fmtWhen } from './formatters';
import { SectionTitle, SortableTable, StatTile, TrendChart } from './parts';

const CATEGORY_LABELS = {
  ACCOUNT: 'Account',
  APPLICATION_DECISION: 'Application decisions',
  OFFER_LETTER: 'Offer letters',
  EVENT: 'Events',
  MEETING: 'Get to Know UC',
  INTERVIEW_SLOT: 'Interview scheduling',
  REVIEWER_REMINDER: 'Reviewer reminders',
  ACCOUNTABILITY_REMINDER: 'Accountability reminders',
  MASTER_COMMUNICATION: 'Master Communications',
  DECISION_BATCH: 'Decision batches',
  TEST: 'Test sends',
  OTHER: 'Other',
};
const categoryLabel = (c) => CATEGORY_LABELS[c] || c;

// SES reviews an account at 5% bounces and 0.1% complaints.
const rateChip = (rate, warnAt) =>
  rate === null ? '—' : <Chip size="small" variant="outlined" color={rate >= warnAt ? 'error' : 'default'} label={fmtPct(rate)} />;

export default function EmailTab({ data }) {
  const theme = useTheme();
  const total = data.categories.reduce(
    (t, c) => ({
      sent: t.sent + c.sent,
      delivered: t.delivered + c.delivered,
      bounced: t.bounced + c.bounced,
      complained: t.complained + c.complained,
      failed: t.failed + c.failed,
      clicked: t.clicked + c.clicked,
    }),
    { sent: 0, delivered: 0, bounced: 0, complained: 0, failed: 0, clicked: 0 }
  );
  const rate = (a, b) => (b ? a / b : null);

  return (
    <Box>
      {!data.trackingActive && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <AlertTitle>Click tracking is not reporting yet</AlertTitle>
          Clicks and opens arrive from Amazon SES once the configuration set&apos;s SNS event destination has the
          <strong> Click</strong> and <strong>Open</strong> event types turned on (see CLAUDE.md, Site analytics). Sending
          and delivery below work without it. Password reset, verification, invite and unsubscribe links are never
          tracked.
        </Alert>
      )}
      {!data.deliveryReporting && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Every email in this range is still &quot;Sent&quot;: SES delivery events are not reaching the server, so
          bounces and deliveries below are unknown. Check SES_CONFIGURATION_SET and SES_SNS_TOPIC_ARN.
        </Alert>
      )}

      <SectionTitle subtitle="Every email the ATS sent in the range, automatic and bulk.">Delivery</SectionTitle>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} useFlexGap flexWrap="wrap">
        <StatTile label="Sent" value={fmtNum(total.sent)} />
        <StatTile label="Delivered" value={fmtPct(rate(total.delivered, total.sent))} caption={`${fmtNum(total.delivered)} emails`} />
        <StatTile
          label="Bounced"
          value={fmtPct(rate(total.bounced, total.sent))}
          caption={`${fmtNum(total.bounced)} · SES reviews at 5%`}
        />
        <StatTile
          label="Marked as spam"
          value={fmtPct(rate(total.complained, total.sent), 2)}
          caption={`${fmtNum(total.complained)} · SES reviews at 0.1%`}
        />
        <StatTile label="Clicked" value={fmtPct(rate(total.clicked, total.delivered))} caption={`${fmtNum(total.clicked)} people, bots excluded`} />
      </Stack>

      <SectionTitle>Per day</SectionTitle>
      <TrendChart
        data={data.perDay}
        series={[
          { key: 'sent', label: 'Sent', color: theme.palette.primary.main },
          { key: 'delivered', label: 'Delivered', color: theme.palette.success.main },
          { key: 'clicked', label: 'Clicked', color: theme.palette.info.main },
          { key: 'problems', label: 'Bounced, spam or failed', color: theme.palette.error.main },
        ]}
      />

      <SectionTitle subtitle="Which automatic emails reach people and get acted on. Click rate is people who clicked out of those delivered.">
        By kind of email
      </SectionTitle>
      <SortableTable
        rows={data.categories}
        rowKey={(r) => r.category}
        initialSort="sent"
        empty="No email sent in this range."
        columns={[
          { key: 'category', label: 'Email', render: (r) => categoryLabel(r.category) },
          { key: 'sent', label: 'Sent', align: 'right', render: (r) => fmtNum(r.sent) },
          { key: 'deliveryRate', label: 'Delivered', align: 'right', render: (r) => fmtPct(r.deliveryRate) },
          { key: 'bounceRate', label: 'Bounced', align: 'right', render: (r) => rateChip(r.bounceRate, 0.05) },
          { key: 'complaintRate', label: 'Spam', align: 'right', render: (r) => rateChip(r.complaintRate, 0.001) },
          { key: 'failed', label: 'Failed to send', align: 'right', render: (r) => fmtNum(r.failed) },
          { key: 'opened', label: 'Opened', align: 'right', render: (r) => fmtNum(r.opened) },
          { key: 'clickRate', label: 'Clicked', align: 'right', render: (r) => (r.clickRate === null ? '—' : `${fmtNum(r.clicked)} (${fmtPct(r.clickRate)})`) },
        ]}
      />

      <SectionTitle subtitle="Buttons and links in emails, by how many people followed them. Landing errors are browser errors on that page per view, so a broken button stands out.">
        Email links
      </SectionTitle>
      <SortableTable
        rows={data.topLinks}
        rowKey={(r) => `${r.link}|${r.category}`}
        initialSort="humanClicks"
        empty={data.trackingActive ? 'No email links clicked in this range.' : 'Waiting for SES click tracking.'}
        columns={[
          { key: 'link', label: 'Link', mono: true, render: (r) => r.landingPath || r.link },
          { key: 'category', label: 'In', render: (r) => categoryLabel(r.category) },
          { key: 'people', label: 'People', align: 'right', render: (r) => fmtNum(r.people) },
          { key: 'humanClicks', label: 'Clicks', align: 'right', render: (r) => fmtNum(r.humanClicks) },
          { key: 'botClicks', label: 'Scanners', align: 'right', render: (r) => fmtNum(r.botClicks) },
          {
            key: 'landingErrorRate',
            label: 'Landing errors',
            align: 'right',
            render: (r) => (r.landingErrorRate === null ? '—' : rateChip(r.landingErrorRate, 0.02)),
          },
          { key: 'lastClicked', label: 'Last', render: (r) => fmtWhen(r.lastClicked) },
        ]}
      />

      <SectionTitle subtitle="Security products open every link in a message the moment it arrives. Those clicks are counted here and left out of the rates above.">
        Link scanners
      </SectionTitle>
      <SortableTable
        rows={data.bots.topUserAgents}
        rowKey={(r) => r.userAgent}
        initialSort="count"
        empty="No scanner clicks in this range."
        columns={[
          { key: 'userAgent', label: 'User agent', mono: true },
          { key: 'count', label: 'Clicks', align: 'right', render: (r) => fmtNum(r.count) },
        ]}
      />
    </Box>
  );
}
