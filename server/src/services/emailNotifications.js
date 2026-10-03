import nodemailer from 'nodemailer';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { formatEmailDateTime, formatEmailTime } from '../utils/timezoneUtils.js';
import { describeRoster } from '../utils/candidateRoster.js';
import { eventInviteFor } from './eventInvites.js';
import { recordCommunication } from './communicationLog.js';
import { markUntrackedLinks, sesTagValue } from './emailLinkTracking.js';
import {
  SLOT_EMAIL_TYPES,
  defaultCopy,
  resolveEmailCopy,
  slotCopyKey,
} from './emailTemplateCopy.js';
import { copySubject } from './emailCopyRender.js';
import { composeEmail, htmlToPlainText, part } from './emailLayout.js';

// Single reusable SES client. Credentials (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)
// are picked up automatically from the environment by the AWS SDK credential chain.
const sesClient = new SESv2Client({ region: process.env.AWS_REGION });

// Escape candidate-controlled strings before interpolating into HTML email bodies.
const escapeHtml = (value) => {
  if (value === null || value === undefined) return value;
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

const createTransporter = () => {
  // Send through the Amazon SES v2 API over HTTPS (port 443) rather than SMTP,
  // so email works regardless of the host's outbound SMTP port policy.
  return nodemailer.createTransport({
    SES: { sesClient, SendEmailCommand }
  });
};

// Email templates
//
// Each builder says what its email contains and hands that to composeEmail
// (emailLayout.js), which draws it in the admin's theme and format. No builder
// writes layout HTML. The one exception is the escaped HTML a builder composes
// from data for a card line (an attendee list, a struck-out old time), which
// the layout places without re-escaping.

// "Date & Time" / "Duration" rows as every meeting card has always shown them.
const meetingTimeRows = (startTime, endTime) => [
  { label: 'Date & Time', value: formatEmailDateTime(startTime) },
  endTime ? { label: 'Duration', value: `${formatEmailTime(startTime)} - ${formatEmailTime(endTime)}` } : null,
];

const eventConfirmationEmail = async (key, candidateName, eventName, eventDate, eventLocation) => {
  const copy = await resolveEmailCopy(key);
  const values = { candidateName, eventName, eventDate, eventLocation };

  return composeEmail(key, {
    subject: copySubject(copy.subject, values),
    values,
    parts: [
      part.heading(copy.heading),
      part.greeting(copy.greeting),
      part.copy(copy.intro),
      part.card({
        title: 'Event Details',
        rows: [
          { label: 'Event', value: eventName },
          eventLocation ? { label: 'Location', value: eventLocation } : null,
        ],
      }),
      part.copy(copy.outro),
      part.signOff(copy.signOff),
    ],
  });
};

const createRSVPConfirmationEmail = (...args) => eventConfirmationEmail('rsvp-confirmation', ...args);

const createAttendanceConfirmationEmail = (...args) => eventConfirmationEmail('attendance-confirmation', ...args);

// Send email function
// `to` is usually one address, but nodemailer also accepts an array or a
// comma-separated string. The log wants one row per person either way.
const addressesOf = (to) => {
  const raw = Array.isArray(to) ? to : String(to ?? '').split(',');
  return raw.map((a) => a.trim()).filter(Boolean);
};

/**
 * The one place mail leaves this server, and therefore the one place it is
 * recorded. Every send - the automated ones and the ones an admin typed - lands
 * in communication_logs, which is what Master Communications reads back.
 *
 * `meta` labels the row: `category` and `trigger` say what kind of message this
 * was and whether a person or the system decided to send it, and
 * `triggeredById` / `cycleId` / `messageLogId` tie it to whoever pressed the
 * button and to the campaign it belonged to. Leaving `meta` off still logs the
 * send, just as an automated OTHER - no caller has to be updated for the log to
 * be complete.
 */
const sendEmail = async (to, subject, html, attachments = [], meta = {}) => {
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  const { recipientName = null, attemptKey = null, listUnsubscribeUrl = null, replyTo = null, ...context } = meta || {};

  // Never rejects. recordCommunication already swallows its own write failures,
  // but the mail is gone by the time this runs: if logging could throw here, a
  // delivered message would be reported as failed and something upstream would
  // send it a second time.
  const record = (status, extra) =>
    Promise.all(
      addressesOf(to).map((recipient) =>
        recordCommunication({
          channel: 'email',
          recipient,
          recipientName,
          subject,
          body: html,
          hasAttachments,
          status,
          // Scoped to the address: one send to two people is two rows, and a
          // retry of either updates only its own.
          attemptKey: attemptKey ? `${attemptKey}|${recipient}` : null,
          ...context,
          ...extra,
        })
      )
    ).catch((e) => {
      console.error('[emailNotifications] failed to log a send:', e);
    });

  try {
    const transporter = createTransporter();

    const mailOptions = {
      from: `"UConsulting ATS" <${process.env.EMAIL_FROM}>`,
      replyTo: replyTo || process.env.EMAIL_REPLY_TO,
      to: to,
      subject: subject,
      // Credential links (reset, verify, invite, unsubscribe) are kept out of
      // SES click tracking; see emailLinkTracking.js.
      html: markUntrackedLinks(html),
      // Every message goes as multipart/alternative. An HTML-only email is a
      // spam signal to Gmail and unreadable in a text client, and deriving the
      // text from the HTML means the two can never disagree.
      text: htmlToPlainText(html)
    };

    if (hasAttachments) {
      mailOptions.attachments = attachments;
    }

    // RFC 8058 one-click unsubscribe, for Master Communications marketing mail
    // only (services/emailSuppression.js). Gmail and Yahoo show their own
    // Unsubscribe button from these and POST to the URL; bulk senders without
    // them are more likely to land in spam.
    if (listUnsubscribeUrl) {
      mailOptions.headers = {
        'List-Unsubscribe': `<${listUnsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      };
    }

    // The configuration set is what makes SES report deliveries, bounces and
    // complaints back to /api/webhooks/ses. Without it the row stays SENT.
    if (process.env.SES_CONFIGURATION_SET) {
      mailOptions.ses = {
        ConfigurationSetName: process.env.SES_CONFIGURATION_SET,
        // Comes back on every delivery, bounce, open and click event, so the
        // Email tab can group engagement by kind of email even for a message
        // whose log row is gone.
        EmailTags: [{ Name: 'category', Value: sesTagValue(context.category) }],
      };
    }

    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent successfully:', info.messageId);
    await record('SENT', { providerMessageId: info.messageId ?? null });
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Error sending email:', error);
    // A failed send is the row an admin most wants to find, so it is logged too.
    await record('FAILED', { error: error.message });
    return { success: false, error: error.message };
  }
};

/**
 * Send RSVP confirmation email.
 *
 * `event` is optional and carries the row itself - id, eventStartDate, eventEndDate.
 * Given it, the confirmation also attaches a calendar invite, so the reader does not
 * have to copy the date out of the email by hand. Left out, the mail goes exactly as
 * it always has; every existing caller keeps working untouched.
 */
export const sendRSVPConfirmation = async (candidateEmail, candidateName, eventName, eventDate, eventLocation, event = null) => {
  try {
    const emailContent = await createRSVPConfirmationEmail(candidateName, eventName, eventDate, eventLocation);
    const invite = event
      ? eventInviteFor({ event, recipientEmail: candidateEmail, recipientName: candidateName })
      : null;
    const result = await sendEmail(
      candidateEmail,
      emailContent.subject,
      emailContent.html,
      invite ? [invite] : [],
      { category: 'EVENT', recipientName: candidateName }
    );

    if (result.success) {
      console.log(`RSVP confirmation email sent to ${candidateEmail} for event: ${eventName}`);
    } else {
      console.error(`Failed to send RSVP confirmation email to ${candidateEmail}:`, result.error);
    }
    
    return result;
  } catch (error) {
    console.error('Error in sendRSVPConfirmation:', error);
    return { success: false, error: error.message };
  }
};

// Send attendance confirmation email
export const sendAttendanceConfirmation = async (candidateEmail, candidateName, eventName, eventDate, eventLocation) => {
  try {
    const emailContent = await createAttendanceConfirmationEmail(candidateName, eventName, eventDate, eventLocation);
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html, [], { category: 'EVENT', recipientName: candidateName });
    
    if (result.success) {
      console.log(`Attendance confirmation email sent to ${candidateEmail} for event: ${eventName}`);
    } else {
      console.error(`Failed to send attendance confirmation email to ${candidateEmail}:`, result.error);
    }
    
    return result;
  } catch (error) {
    console.error('Error in sendAttendanceConfirmation:', error);
    return { success: false, error: error.message };
  }
};

// Helper function to format event date
export const formatEventDate = (date) => {
  return formatEmailDateTime(date);
};

// Confirms that a synced form response is on file. Nothing has been decided
// yet, so it says only that it arrived and what happens next.
const createApplicationReceivedEmail = async (candidateName, cycleName) => {
  const key = 'application-received';
  const copy = await resolveEmailCopy(key);
  const values = { candidateName, cycleName };

  return composeEmail(key, {
    subject: copySubject(copy.subject, values),
    values,
    parts: [
      part.heading(copy.heading),
      part.greeting(copy.greeting),
      part.copy(copy.intro),
      part.copy(copy.outro),
      part.signOff(copy.signOff),
    ],
  });
};

export const sendApplicationReceivedEmail = async (candidateEmail, candidateName, cycleName, { cycleId = null, attemptKey = null } = {}) => {
  try {
    const emailContent = await createApplicationReceivedEmail(candidateName, cycleName);
    return await sendEmail(candidateEmail, emailContent.subject, emailContent.html, [], {
      category: 'APPLICATION_RECEIVED',
      recipientName: candidateName,
      cycleId,
      attemptKey,
    });
  } catch (error) {
    console.error('Error in sendApplicationReceivedEmail:', error);
    return { success: false, error: error.message };
  }
};

// The coffee-chat advance and the rejection: same shape, different tone.
const applicationDecisionEmail = async (key, tone, candidateName, currentCycleName) => {
  const copy = await resolveEmailCopy(key);
  const values = { candidateName, cycleName: currentCycleName };

  return composeEmail(key, {
    subject: copySubject(copy.subject, values),
    values,
    parts: [
      part.heading(copy.heading),
      part.greeting(copy.greeting),
      part.copy(copy.intro),
      part.card({ tone, titleText: copy.highlightsTitle, copy: [copy.highlights] }),
      part.copy(copy.outro),
      part.signOff(copy.signOff),
    ],
  });
};

const createAcceptanceEmail = (...args) => applicationDecisionEmail('application-acceptance', 'success', ...args);

const createRejectionEmail = (...args) => applicationDecisionEmail('application-rejection', 'danger', ...args);

// Send acceptance email
export const sendAcceptanceEmail = async (candidateEmail, candidateName, currentCycleName) => {
  try {
    const emailContent = await createAcceptanceEmail(candidateName, currentCycleName);
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html, [], { category: 'APPLICATION_DECISION', recipientName: candidateName });
    
    if (result.success) {
      console.log(`Acceptance email sent to ${candidateEmail} for cycle: ${currentCycleName}`);
    } else {
      console.error(`Failed to send acceptance email to ${candidateEmail}:`, result.error);
    }
    
    return result;
  } catch (error) {
    console.error('Error in sendAcceptanceEmail:', error);
    return { success: false, error: error.message };
  }
};

// Send rejection email
export const sendRejectionEmail = async (candidateEmail, candidateName, currentCycleName) => {
  try {
    const emailContent = await createRejectionEmail(candidateName, currentCycleName);
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html, [], { category: 'APPLICATION_DECISION', recipientName: candidateName });
    
    if (result.success) {
      console.log(`Rejection email sent to ${candidateEmail} for cycle: ${currentCycleName}`);
    } else {
      console.error(`Failed to send rejection email to ${candidateEmail}:`, result.error);
    }
    
    return result;
  } catch (error) {
    console.error('Error in sendRejectionEmail:', error);
    return { success: false, error: error.message };
  }
};

// Coffee Chat specific email templates

// First Round specific email templates

// Final Round specific email templates

// Offer Letter specific email template

const createOfferLetterEmail = async (candidateName, currentCycleName, offerDetails) => {
  const { position, startDate, responseDeadline, additionalNotes } = offerDetails;
  const copy = await resolveEmailCopy('offer-letter');
  const values = {
    candidateName,
    cycleName: currentCycleName,
    position,
    startDate: startDate || 'To be determined',
    responseDeadline
  };
  const additionalNotesE = additionalNotes
    ? escapeHtml(additionalNotes).replace(/\n/g, '<br>')
    : '';

  return composeEmail('offer-letter', {
    subject: copySubject(copy.subject, values),
    values,
    parts: [
      part.heading(copy.heading),
      part.copy(copy.intro),
      part.card({
        tone: 'success',
        title: 'Offer Details',
        rows: [
          { label: 'Position', value: position },
          { label: 'Start Date', value: startDate || 'To be determined' },
          { label: 'Response Deadline', value: responseDeadline },
          additionalNotesE ? { label: 'Additional Notes', html: `<br>${additionalNotesE}` } : null,
        ],
      }),
      part.copy(copy.outro),
      part.signOff(copy.signOff),
    ],
  });
};

// Send offer letter email
export const sendOfferLetter = async (candidateEmail, candidateName, currentCycleName, offerDetails, attachmentBuffer = null, attachmentFilename = 'offer-letter.pdf') => {
  try {
    const emailContent = await createOfferLetterEmail(candidateName, currentCycleName, offerDetails);
    const attachments = attachmentBuffer
      ? [{ filename: attachmentFilename, content: attachmentBuffer }]
      : [];
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html, attachments, { category: 'OFFER_LETTER', recipientName: candidateName });
    
    if (result.success) {
      console.log(`Offer letter sent to ${candidateEmail} for cycle: ${currentCycleName}`);
    } else {
      console.error(`Failed to send offer letter to ${candidateEmail}:`, result.error);
    }
    
    return result;
  } catch (error) {
    console.error('Error in sendOfferLetter:', error);
    return { success: false, error: error.message };
  }
};

// Meeting Signup specific email templates

// Create meeting signup confirmation email template
const createMeetingSignupConfirmationEmail = async (candidateName, memberName, location, startTime, endTime) => {
  const copy = await resolveEmailCopy('meeting-signup-confirmation');
  const values = { candidateName, memberName, location };

  return composeEmail('meeting-signup-confirmation', {
    subject: copySubject(copy.subject, values),
    values,
    parts: [
      part.greeting(copy.greeting),
      part.copy(copy.intro),
      part.card({
        tone: 'info',
        title: 'Meeting Details',
        rows: [
          { label: 'Member', value: memberName },
          ...meetingTimeRows(startTime, endTime),
          { label: 'Location', value: location },
        ],
      }),
      part.card({ titleText: copy.highlightsTitle, copy: [copy.highlights] }),
      part.copy(copy.outro),
      part.signOff(copy.signOff),
    ],
  });
};

// Send meeting signup confirmation email
export const sendMeetingSignupConfirmation = async (candidateEmail, candidateName, memberName, location, startTime, endTime, { invite } = {}) => {
  try {
    const emailContent = await createMeetingSignupConfirmationEmail(candidateName, memberName, location, startTime, endTime);
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html, invite ? [invite] : [], { category: 'MEETING', recipientName: candidateName });
    
    if (result.success) {
      console.log(`Meeting signup confirmation email sent to ${candidateEmail} for meeting with ${memberName}`);
    } else {
      console.error(`Failed to send meeting signup confirmation email to ${candidateEmail}:`, result.error);
    }
    
    return result;
  } catch (error) {
    console.error('Error in sendMeetingSignupConfirmation:', error);
    return { success: false, error: error.message };
  }
};

// Confirmation to the host that the GTKUC slot they (or an admin for them)
// just opened exists. It carries the first calendar invite for the slot; each
// later signup email updates that same entry.
const createMeetingSlotCreatedEmail = async (memberName, location, startTime, endTime) => {
  const copy = await resolveEmailCopy('meeting-slot-created');
  const values = { memberName, location };

  return composeEmail('meeting-slot-created', {
    subject: copySubject(copy.subject, values),
    values,
    parts: [
      part.greeting(copy.greeting),
      part.copy(copy.intro),
      slotDetailsCard(location, startTime, endTime),
      part.card({ titleText: copy.highlightsTitle, copy: [copy.highlights] }),
      part.copy(copy.outro),
      part.signOff(copy.signOff),
    ],
  });
};

// The host's own slot, as every GTKUC host email shows it.
function slotDetailsCard(location, startTime, endTime) {
  return part.card({
    tone: 'success',
    title: 'Slot Details',
    rows: [...meetingTimeRows(startTime, endTime), { label: 'Location', value: location }],
  });
}

// Who booked, one line each. `extra` adds the tail of a line (a phone number,
// "marked attended") as escaped HTML.
function signupsCard(attendees, extra) {
  return part.card({
    tone: 'info',
    title: `Signed Up (${attendees.length})`,
    lines: attendees.map(
      (a) => `<strong>${escapeHtml(a.fullName)}</strong> - ${escapeHtml(a.email)}${extra(a)}`
    ),
  });
}

export const sendMeetingSlotCreated = async (memberEmail, memberName, location, startTime, endTime, { invite } = {}) => {
  try {
    const emailContent = await createMeetingSlotCreatedEmail(memberName, location, startTime, endTime);
    const result = await sendEmail(memberEmail, emailContent.subject, emailContent.html, invite ? [invite] : [], { category: 'MEETING', recipientName: memberName });

    if (result.success) {
      console.log(`Meeting slot created email sent to ${memberEmail}`);
    } else {
      console.error(`Failed to send meeting slot created email to ${memberEmail}:`, result.error);
    }

    return result;
  } catch (error) {
    console.error('Error in sendMeetingSlotCreated:', error);
    return { success: false, error: error.message };
  }
};

// The day-before reminder to a GTKUC host, listing everyone booked so they can
// reach out with where exactly to meet. `attendees` is [{ fullName, email,
// phoneNumber }]; `ctaUrl` arrives finished, like every link in this module.
const createMeetingHostReminderEmail = async (memberName, location, startTime, endTime, attendees = [], ctaUrl = null) => {
  const copy = await resolveEmailCopy('meeting-host-reminder');
  const values = { memberName, location };

  return composeEmail('meeting-host-reminder', {
    subject: copySubject(copy.subject, values),
    values,
    parts: [
      part.greeting(copy.greeting),
      part.copy(copy.intro),
      slotDetailsCard(location, startTime, endTime),
      signupsCard(attendees, (a) => (a.phoneNumber ? ` - ${escapeHtml(a.phoneNumber)}` : '')),
      part.card({ titleText: copy.highlightsTitle, copy: [copy.highlights] }),
      part.copy(copy.outro),
      part.button(ctaUrl, 'Contact your signups'),
      part.signOff(copy.signOff),
    ],
  });
};

export const sendMeetingHostReminder = async (memberEmail, memberName, location, startTime, endTime, attendees, ctaUrl) => {
  try {
    const emailContent = await createMeetingHostReminderEmail(memberName, location, startTime, endTime, attendees, ctaUrl);
    const result = await sendEmail(memberEmail, emailContent.subject, emailContent.html, [], { category: 'MEETING', recipientName: memberName });

    if (result.success) {
      console.log(`Meeting host reminder sent to ${memberEmail}`);
    } else {
      console.error(`Failed to send meeting host reminder to ${memberEmail}:`, result.error);
    }

    return result;
  } catch (error) {
    console.error('Error in sendMeetingHostReminder:', error);
    return { success: false, error: error.message };
  }
};

// Create the after-the-meeting attendance reminder to a GTKUC host
const createMeetingAttendanceReminderEmail = async (memberName, location, startTime, endTime, attendees = [], ctaUrl = null) => {
  const copy = await resolveEmailCopy('meeting-attendance-reminder');
  const values = { memberName, location };

  return composeEmail('meeting-attendance-reminder', {
    subject: copySubject(copy.subject, values),
    values,
    parts: [
      part.greeting(copy.greeting),
      part.copy(copy.intro),
      slotDetailsCard(location, startTime, endTime),
      signupsCard(attendees, (a) => (a.attended ? ' - <em>marked attended</em>' : '')),
      part.copy(copy.outro),
      part.button(ctaUrl, 'Mark attendance'),
      part.signOff(copy.signOff),
    ],
  });
};

export const sendMeetingAttendanceReminder = async (memberEmail, memberName, location, startTime, endTime, attendees, ctaUrl) => {
  try {
    const emailContent = await createMeetingAttendanceReminderEmail(memberName, location, startTime, endTime, attendees, ctaUrl);
    const result = await sendEmail(memberEmail, emailContent.subject, emailContent.html, [], { category: 'MEETING', recipientName: memberName });

    if (result.success) {
      console.log(`Meeting attendance reminder sent to ${memberEmail}`);
    } else {
      console.error(`Failed to send meeting attendance reminder to ${memberEmail}:`, result.error);
    }

    return result;
  } catch (error) {
    console.error('Error in sendMeetingAttendanceReminder:', error);
    return { success: false, error: error.message };
  }
};

// Create meeting signup notification email template for members
const createMeetingSignupNotificationEmail = async (memberName, candidateName, candidateEmail, studentId, location, startTime, endTime) => {
  const copy = await resolveEmailCopy('meeting-signup-notification');
  const values = { memberName, candidateName, candidateEmail, location };

  return composeEmail('meeting-signup-notification', {
    subject: copySubject(copy.subject, values),
    values,
    parts: [
      part.greeting(copy.greeting),
      part.copy(copy.intro),
      part.card({
        tone: 'success',
        title: 'Meeting Details',
        rows: [...meetingTimeRows(startTime, endTime), { label: 'Location', value: location }],
      }),
      part.card({
        tone: 'info',
        title: 'Candidate Information',
        rows: [
          { label: 'Name', value: candidateName },
          { label: 'Email', value: candidateEmail },
        ],
      }),
      part.card({ titleText: copy.highlightsTitle, copy: [copy.highlights] }),
      part.copy(copy.outro),
      part.signOff(copy.signOff),
    ],
  });
};

// Send meeting signup notification email to member
export const sendMeetingSignupNotification = async (memberEmail, memberName, candidateName, candidateEmail, studentId, location, startTime, endTime, { invite } = {}) => {
  try {
    const emailContent = await createMeetingSignupNotificationEmail(memberName, candidateName, candidateEmail, studentId, location, startTime, endTime);
    const result = await sendEmail(memberEmail, emailContent.subject, emailContent.html, invite ? [invite] : [], { category: 'MEETING', recipientName: memberName });
    
    if (result.success) {
      console.log(`Meeting signup notification email sent to ${memberEmail} for signup by ${candidateName}`);
    } else {
      console.error(`Failed to send meeting signup notification email to ${memberEmail}:`, result.error);
    }
    
    return result;
  } catch (error) {
    console.error('Error in sendMeetingSignupNotification:', error);
    return { success: false, error: error.message };
  }
};

// Create meeting cancellation email template
const createMeetingCancellationEmail = async (candidateName, memberName, location, startTime, endTime) => {
  const copy = await resolveEmailCopy('meeting-cancellation-candidate');
  const values = { candidateName, memberName, location };

  return composeEmail('meeting-cancellation-candidate', {
    subject: copySubject(copy.subject, values),
    values,
    parts: [
      part.heading(copy.heading),
      part.greeting(copy.greeting),
      part.copy(copy.intro),
      part.card({
        tone: 'danger',
        title: 'Cancelled Meeting Details',
        rows: [
          { label: 'Member', value: memberName },
          ...meetingTimeRows(startTime, endTime),
          { label: 'Location', value: location },
        ],
      }),
      part.card({ titleText: copy.highlightsTitle, copy: [copy.highlights] }),
      part.copy(copy.outro),
      part.signOff(copy.signOff),
    ],
  });
};

// Create password reset email template
const createPasswordResetEmail = async (resetLink) => {
  // resetLink is server-generated (BASE/CLIENT URL + token), not user-controlled,
  // so it is safe to embed directly in the href and visible link text.
  const copy = await resolveEmailCopy('password-reset');
  const values = {};

  return composeEmail('password-reset', {
    subject: copySubject(copy.subject, values),
    values,
    parts: [
      part.heading(copy.heading),
      part.copy(copy.intro),
      part.button(resetLink, 'Reset Password'),
      part.copy(copy.linkFallback),
      part.link(resetLink),
      part.copy(copy.ignoreNotice),
      part.signOff(copy.signOff),
    ],
  });
};

// Create password reset confirmation email template
const createPasswordResetConfirmationEmail = async (fullName) => {
  const copy = await resolveEmailCopy('password-reset-confirmation');
  const values = { firstName: fullName?.trim().split(' ')[0] || 'there' };

  return composeEmail('password-reset-confirmation', {
    subject: copySubject(copy.subject, values),
    values,
    parts: [
      part.heading(copy.heading),
      part.greeting(copy.greeting),
      part.copy(copy.intro),
      part.signOff(copy.signOff),
    ],
  });
};

// Send password reset email
export const sendPasswordResetEmail = async (email, resetLink) => {
  try {
    const emailContent = await createPasswordResetEmail(resetLink);
    const result = await sendEmail(email, emailContent.subject, emailContent.html, [], { category: 'ACCOUNT' });

    if (result.success) {
      console.log(`Password reset email sent to ${email}`);
    } else {
      console.error(`Failed to send password reset email to ${email}:`, result.error);
    }

    return result;
  } catch (error) {
    console.error('Error in sendPasswordResetEmail:', error);
    return { success: false, error: error.message };
  }
};

// Send password reset confirmation email
export const sendPasswordResetConfirmationEmail = async (email, fullName) => {
  try {
    if (!email) {
      return { success: false, error: 'No recipient email provided' };
    }

    const emailContent = await createPasswordResetConfirmationEmail(fullName);
    const result = await sendEmail(email, emailContent.subject, emailContent.html, [], { category: 'ACCOUNT', recipientName: fullName });

    if (result.success) {
      console.log(`Password reset confirmation email sent to ${email}`);
    } else {
      console.error(`Failed to send password reset confirmation email to ${email}:`, result.error);
    }

    return result;
  } catch (error) {
    console.error('Error in sendPasswordResetConfirmationEmail:', error);
    return { success: false, error: error.message };
  }
};

// Send meeting cancellation email
export const sendMeetingCancellationEmail = async (candidateEmail, candidateName, memberName, location, startTime, endTime, { invite } = {}) => {
  try {
    const emailContent = await createMeetingCancellationEmail(candidateName, memberName, location, startTime, endTime);
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html, invite ? [invite] : [], { category: 'MEETING', recipientName: candidateName });
    
    if (result.success) {
      console.log(`Meeting cancellation email sent to ${candidateEmail} for cancelled meeting with ${memberName}`);
    } else {
      console.error(`Failed to send meeting cancellation email to ${candidateEmail}:`, result.error);
    }
    
    return result;
  } catch (error) {
    console.error('Error in sendMeetingCancellationEmail:', error);
    return { success: false, error: error.message };
  }
};

// Create meeting cancellation email template directed at the HOST member.
// Two variants: whole slot cancelled (candidateName omitted) vs. a single
// candidate's signup cancelled (candidateName provided).
const createMeetingCancellationMemberEmail = async (memberName, location, startTime, endTime, options = {}) => {
  const copy = await resolveEmailCopy('meeting-cancellation-member');
  const candidateName = options.candidateName || null;
  const signupCount = Number.isInteger(options.signupCount) ? options.signupCount : null;

  const values = {
    memberName,
    location,
    candidateName: candidateName ?? '',
    // Reads correctly either way: "3 signed-up candidate(s) have been notified"
    // and "Any signed-up candidates have been notified".
    signupCountLabel: signupCount ? `${signupCount} signed-up candidate(s)` : 'Any signed-up candidates'
  };

  // Which opening and which first line - a candidate dropping their signup, or
  // an admin pulling the whole slot. Decided by what happened, never by an edit.
  const intro = candidateName ? copy.introCandidateCancelled : copy.introSlotCancelled;
  const impact = candidateName ? copy.impactCandidateCancelled : copy.impactSlotCancelled;

  return composeEmail('meeting-cancellation-member', {
    subject: copySubject(copy.subject, values),
    values,
    parts: [
      part.heading(copy.heading),
      part.greeting(copy.greeting),
      part.copy(intro),
      part.card({
        tone: 'danger',
        title: 'Cancelled Meeting Details',
        rows: [
          candidateName ? { label: 'Candidate', value: candidateName } : null,
          ...meetingTimeRows(startTime, endTime),
          { label: 'Location', value: location },
        ],
      }),
      part.card({ titleText: copy.highlightsTitle, copy: [impact, copy.highlights] }),
      part.signOff(copy.signOff),
    ],
  });
};

// Send meeting cancellation email to the HOST member.
export const sendMeetingCancellationToMember = async (memberEmail, memberName, location, startTime, endTime, options = {}) => {
  try {
    const emailContent = await createMeetingCancellationMemberEmail(memberName, location, startTime, endTime, options);
    const result = await sendEmail(memberEmail, emailContent.subject, emailContent.html, options.invite ? [options.invite] : [], { category: 'MEETING', recipientName: memberName });

    if (result.success) {
      console.log(`Meeting cancellation email sent to host member ${memberEmail}`);
    } else {
      console.error(`Failed to send meeting cancellation email to host member ${memberEmail}:`, result.error);
    }

    return result;
  } catch (error) {
    console.error('Error in sendMeetingCancellationToMember:', error);
    return { success: false, error: error.message };
  }
};

// ---------------------------------------------------------------------------
// GTKUC slot rescheduled
// ---------------------------------------------------------------------------

// Render the "what changed" pair of boxes: the new details, then the old ones
// beneath as muted context. Both the candidate and host variants use it, so a
// reschedule reads the same whoever receives it.
//
// `next` and `previous` are each { location, startTime, endTime }. Only the
// fields that actually differ are listed under "Previously", because repeating
// an unchanged location under a strikethrough heading reads like it moved too.
const rescheduleDetailParts = (next, previous) => {
  const changedLines = [];
  if (String(previous.startTime) !== String(next.startTime) || String(previous.endTime) !== String(next.endTime)) {
    changedLines.push(
      `<s>${escapeHtml(formatEmailDateTime(previous.startTime))}` +
      `${previous.endTime ? ` (until ${escapeHtml(formatEmailTime(previous.endTime))})` : ''}</s>`
    );
  }
  if (previous.location !== next.location) {
    changedLines.push(`<s>${escapeHtml(previous.location)}</s>`);
  }

  return [
    part.card({
      tone: 'success',
      title: 'New Meeting Details',
      rows: [...meetingTimeRows(next.startTime, next.endTime), { label: 'Location', value: next.location }],
    }),
    changedLines.length ? part.card({ tone: 'muted', title: 'Previously', lines: changedLines }) : null,
  ].filter(Boolean);
};

// Reschedule notice directed at a signed-up CANDIDATE.
const createMeetingRescheduleEmail = async (candidateName, memberName, next, previous) => {
  const copy = await resolveEmailCopy('meeting-reschedule-candidate');
  const values = { candidateName, memberName };

  return composeEmail('meeting-reschedule-candidate', {
    subject: copySubject(copy.subject, values),
    values,
    parts: [
      part.heading(copy.heading),
      part.greeting(copy.greeting),
      part.copy(copy.intro),
      ...rescheduleDetailParts(next, previous),
      part.card({ titleText: copy.highlightsTitle, copy: [copy.highlights] }),
      part.signOff(copy.signOff),
    ],
  });
};

// Send the reschedule notice to a signed-up candidate.
export const sendMeetingRescheduleEmail = async (candidateEmail, candidateName, memberName, next, previous, { invite } = {}) => {
  try {
    const emailContent = await createMeetingRescheduleEmail(candidateName, memberName, next, previous);
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html, invite ? [invite] : [], { category: 'MEETING', recipientName: candidateName });

    if (result.success) {
      console.log(`Meeting reschedule email sent to ${candidateEmail} for moved meeting with ${memberName}`);
    } else {
      console.error(`Failed to send meeting reschedule email to ${candidateEmail}:`, result.error);
    }

    return result;
  } catch (error) {
    console.error('Error in sendMeetingRescheduleEmail:', error);
    return { success: false, error: error.message };
  }
};

// Reschedule notice directed at the HOST member. Sent only when somebody other
// than the host moved the slot, so a member never gets mail about their own edit.
const createMeetingRescheduleMemberEmail = async (memberName, next, previous, options = {}) => {
  const copy = await resolveEmailCopy('meeting-reschedule-member');
  const signupCount = Number.isInteger(options.signupCount) ? options.signupCount : null;
  const values = { memberName, signupCount: signupCount ?? 0 };
  const impact = signupCount ? copy.impactWithSignups : copy.impactWithoutSignups;

  return composeEmail('meeting-reschedule-member', {
    subject: copySubject(copy.subject, values),
    values,
    parts: [
      part.heading(copy.heading),
      part.greeting(copy.greeting),
      part.copy(copy.intro),
      ...rescheduleDetailParts(next, previous),
      part.card({ titleText: copy.highlightsTitle, copy: [impact, copy.highlights] }),
      part.signOff(copy.signOff),
    ],
  });
};

// Send the reschedule notice to the HOST member.
export const sendMeetingRescheduleToMember = async (memberEmail, memberName, next, previous, options = {}) => {
  try {
    const emailContent = await createMeetingRescheduleMemberEmail(memberName, next, previous, options);
    const result = await sendEmail(memberEmail, emailContent.subject, emailContent.html, options.invite ? [options.invite] : [], { category: 'MEETING', recipientName: memberName });

    if (result.success) {
      console.log(`Meeting reschedule email sent to host member ${memberEmail}`);
    } else {
      console.error(`Failed to send meeting reschedule email to host member ${memberEmail}:`, result.error);
    }

    return result;
  } catch (error) {
    console.error('Error in sendMeetingRescheduleToMember:', error);
    return { success: false, error: error.message };
  }
};

// Reviewer grading reminder email templates

const createReviewerReminderEmail = async (reviewerName, teamName, cycleName, progress) => {
  const copy = await resolveEmailCopy('reviewer-reminder');
  const values = { reviewerName, teamName, cycleName };
  const { completed, eligible, completedTotal, expectedTotal, completionPercent, gradingUrl } = progress;

  return composeEmail('reviewer-reminder', {
    subject: copySubject(copy.subject, values),
    values,
    parts: [
      part.heading(copy.heading),
      part.greeting(copy.greeting),
      part.copy(copy.intro),
      part.card({
        title: 'Your current progress',
        rows: [
          { label: 'Overall', value: `${completedTotal}/${expectedTotal} (${completionPercent}% complete)` },
          { label: 'Resume', value: `${completed.resume}/${eligible.resume}` },
          { label: 'Short Answer', value: `${completed.coverLetter}/${eligible.coverLetter}` },
          { label: 'Video', value: `${completed.video}/${eligible.video}` },
        ],
      }),
      part.copy(copy.outro),
      part.button(gradingUrl, 'Grade Applications'),
      part.signOff(copy.signOff),
    ],
  });
};

// Send a reviewer reminder email with team/progress context and a link to the grading workflow.
export const sendReviewerReminder = async (reviewerEmail, reviewerName, teamName, cycleName, progress) => {
  try {
    if (!reviewerEmail || !reviewerEmail.includes('@')) {
      return { success: false, error: 'Invalid reviewer email address' };
    }

    const emailContent = await createReviewerReminderEmail(reviewerName, teamName, cycleName, progress);
    const result = await sendEmail(reviewerEmail, emailContent.subject, emailContent.html, [], { category: 'REVIEWER_REMINDER', recipientName: reviewerName });

    if (result.success) {
      console.log(`Reviewer reminder sent to ${reviewerEmail} for team ${teamName}`);
    } else {
      console.error(`Failed to send reviewer reminder to ${reviewerEmail}:`, result.error);
    }

    return result;
  } catch (error) {
    console.error('Error in sendReviewerReminder:', error);
    return { success: false, error: error.message };
  }
};

// Reused by the Master Communications service for raw, non-templated sends.
export { sendEmail };

// ---------------------------------------------------------------------------
// Interview slot scheduling
// ---------------------------------------------------------------------------

/**
 * Subject lines at the wording this repo ships, before any admin edit.
 *
 * Kept as the same { TYPE: (title) => string } map it has always been, because
 * a caller that only wants the default - a test, a preview of the shipped
 * wording - should not have to reach the database for it. Derived from the copy
 * catalog rather than written out again, so the two cannot drift: the bug this
 * shape exists to prevent was INTERVIEWER_MOVED having a body and no subject,
 * which made queueing one call undefined(...) inside a catch.
 */
export { SLOT_EMAIL_TYPES };

export const SLOT_NOTIFICATION_SUBJECTS = Object.fromEntries(
  SLOT_EMAIL_TYPES.map((type) => [
    type,
    (interviewTitle) => copySubject(defaultCopy(slotCopyKey(type)).subject, { interviewTitle }),
  ])
);

/**
 * The subject to stamp on a notification being queued, with any admin edit.
 *
 * Resolved at queue time rather than at send time, which is where the stored
 * `subject` column has always come from. So an edit reaches the notifications
 * queued after it and leaves anything already waiting to go out alone.
 */
export const slotNotificationSubject = async (type, interviewTitle) =>
  (await slotSubjectFormatter(type))(interviewTitle);

/**
 * The same, read once and then applied to many interview titles.
 *
 * A roster filled in one action queues dozens of notifications of one type
 * across sessions with different titles. Resolving the wording per row would
 * turn one action into dozens of reads for an answer that cannot change between
 * them.
 */
export const slotSubjectFormatter = async (type) => {
  const copy = await resolveEmailCopy(slotCopyKey(type));
  return (interviewTitle) => copySubject(copy.subject, { interviewTitle });
};

export const renderInterviewSlotEmail = async (
  notification,
  {
    ctaUrl = null,
    ctaLabel = 'View or change your time',
    preferredSlotName = null,
    fromSlotName = null,
    selfSignup = false,
  } = {}
) => {
  const slot = notification.slot ?? {};
  // A message about the whole interview - "when are you free" - carries no
  // session, so the interview is the only thing that can name it.
  const interview = slot.interview ?? notification.interview ?? {};
  const application = notification.signup?.application ?? {};
  const hasSession = Boolean(slot.startTime);

  const type = SLOT_EMAIL_TYPES.includes(notification.type) ? notification.type : 'CONFIRMATION';
  const copy = await resolveEmailCopy(slotCopyKey(type));

  const values = {
    interviewTitle: interview.title || 'your interview',
    fromName: fromSlotName ?? '',
    slotName: slot.label || formatEmailDateTime(slot.startTime),
    preferredName: preferredSlotName || 'your first choice',
    candidateName: [application.firstName, application.lastName].filter(Boolean).join(' ') || 'A candidate',
  };

  // The two notifications whose wording forks on how the change happened.
  // Which half is used is decided by the send path, never by an edit: somebody
  // who claimed a session themselves must not read that they "have been placed"
  // in it, and a move we cannot name the old session for must not print an
  // empty one.
  let body = copy.body;
  if (type === 'INTERVIEWER_ASSIGNED' && selfSignup) body = copy.bodySelfSignup;
  if (type === 'INTERVIEWER_MOVED' && !fromSlotName) body = copy.bodyNoPrevious;

  // Nothing to show in a details card when there is no session yet, or when the
  // point of the message is that a booking is gone.
  const showDetails = hasSession && !['CANCELLATION', 'AVAILABILITY_REQUEST', 'INTERVIEWER_REMOVED'].includes(type);

  const where = slot.location || interview.location || '';
  // Who the interviewer is seeing. Arrives already narrowed to interviewer
  // notifications, so a candidate's own email can never grow this line.
  const roster = describeRoster(notification.candidateRoster);

  // Returns the HTML alone: the subject was stamped when the notification was
  // queued (slotNotificationSubject), and every caller wants only the body.
  const { html } = await composeEmail(slotCopyKey(type), {
    subject: values.interviewTitle,
    values,
    brand: 'UConsulting',
    parts: [
      part.heading(copy.heading),
      part.copy(body),
      showDetails
        ? part.card({
            title: values.interviewTitle,
            rows: [
              slot.label ? { label: 'Session', value: slot.label } : null,
              { label: 'When', value: `${formatEmailDateTime(slot.startTime)} - ${formatEmailTime(slot.endTime)}` },
              where ? { label: 'Where', value: where } : null,
              roster ? { label: "Who you're seeing", value: roster } : null,
            ],
          })
        : null,
      part.button(ctaUrl, ctaLabel),
      part.signOff('Best regards,\nUConsulting Recruitment'),
    ].filter(Boolean),
  });
  return html;
};

// ---------------------------------------------------------------------------
// External talent portal
// ---------------------------------------------------------------------------

const createEmailVerificationEmail = async (fullName, verifyLink) => {
  // verifyLink is server-generated (CLIENT_URL + token), not user-controlled,
  // so it is safe to embed directly in the href and visible link text. fullName
  // IS user-controlled - it is whatever the person typed at signup - and is
  // escaped by copyLine on its way into the greeting.
  const copy = await resolveEmailCopy('email-verification');
  const values = { fullName };

  return composeEmail('email-verification', {
    subject: copySubject(copy.subject, values),
    values,
    brand: 'UConsulting Talent Network',
    parts: [
      part.heading(copy.heading),
      part.greeting(fullName ? copy.greeting : copy.greetingNoName),
      part.copy(copy.intro),
      part.button(verifyLink, 'Verify Email'),
      part.copy(copy.linkFallback),
      part.link(verifyLink),
      part.copy(copy.ignoreNotice),
      part.signOff(copy.signOff),
    ],
  });
};

/**
 * Send the address-verification link for a talent portal signup.
 *
 * Returns the same { success, error } shape every other sender here does. The
 * caller must not fail the signup on a send failure - the account exists either
 * way, and the portal offers a resend.
 */
export const sendEmailVerification = async (email, fullName, verifyLink) => {
  try {
    if (!email) {
      return { success: false, error: 'No recipient email provided' };
    }

    const emailContent = await createEmailVerificationEmail(fullName, verifyLink);
    const result = await sendEmail(email, emailContent.subject, emailContent.html, [], { category: 'ACCOUNT', recipientName: fullName });

    if (result.success) {
      console.log(`Email verification sent to ${email}`);
    } else {
      console.error(`Failed to send email verification to ${email}:`, result.error);
    }

    return result;
  } catch (error) {
    console.error('Error in sendEmailVerification:', error);
    return { success: false, error: error.message };
  }
};

// ---------------------------------------------------------------------------
// Message an Admin
// ---------------------------------------------------------------------------

// The shared exec inbox that "Message an Admin" writes to.
export const ADMIN_INBOX_EMAIL = process.env.ADMIN_INBOX_EMAIL || 'uconsultingla@gmail.com';

// Staff-only and written by the sender, so it has no editable copy: the
// message itself is the body, escaped line by line.
export const sendAdminMessageEmail = async ({ fromName, fromEmail, role, message, triggeredById }) => {
  try {
    const subject = `Message from ${fromName || fromEmail}`;
    const emailContent = await composeEmail('admin-message', {
      subject,
      parts: [
        part.heading('New message from the ATS'),
        part.card({
          tone: 'info',
          rows: [
            { label: 'From', value: fromName },
            { label: 'Email', value: fromEmail },
            { label: 'Role', value: role },
          ],
        }),
        part.card({
          title: 'Message',
          lines: message.split('\n').map((line) => escapeHtml(line) || '&nbsp;'),
        }),
        part.copy('Reply to this email to answer them directly.'),
      ],
    });

    const result = await sendEmail(ADMIN_INBOX_EMAIL, emailContent.subject, emailContent.html, [], {
      category: 'OTHER',
      trigger: 'MANUAL',
      triggeredById,
      recipientName: 'UConsulting admins',
      replyTo: fromEmail,
    });

    if (!result.success) {
      console.error(`Failed to send admin message to ${ADMIN_INBOX_EMAIL}:`, result.error);
    }
    return result;
  } catch (error) {
    console.error('Error in sendAdminMessageEmail:', error);
    return { success: false, error: error.message };
  }
};

// ---------------------------------------------------------------------------
// Welcome
// ---------------------------------------------------------------------------

/**
 * Which welcome an audience gets, and the two things about it that are not copy.
 *
 * Three audiences rather than one generic body, because "you signed up" means
 * three different things here: a candidate is tracking an application, a
 * talent-portal account has no application at all and only a profile, and a
 * member is staff who will be grading and interviewing. One shared body would
 * be wrong for at least two of them, and a welcome that describes the wrong app
 * is worse than no welcome.
 *
 * The wording itself is in emailTemplateCopy.js under these keys, where an
 * admin can edit it. `ctaLabel` stays here because it names a destination the
 * caller chose, and `brand` because it is the banner, not the body.
 */
const WELCOME_AUDIENCES = {
  candidate: { key: 'welcome-candidate', ctaLabel: 'Go to your dashboard', brand: 'UConsulting Recruitment' },
  talent: { key: 'welcome-talent', ctaLabel: 'Finish your profile', brand: 'UConsulting Talent Network' },
  member: { key: 'welcome-member', ctaLabel: 'Open the ATS', brand: 'UConsulting' }
};

/**
 * `ctaUrl` is built by the caller from config.clientUrl, per the rule this
 * module has followed throughout: it never imports config, and every link
 * arrives as a finished string. fullName is whatever the person typed at
 * signup, so it is escaped before it reaches the template.
 */
const createWelcomeEmail = async (fullName, audience, ctaUrl) => {
  const which = WELCOME_AUDIENCES[audience] ?? WELCOME_AUDIENCES.candidate;
  const copy = await resolveEmailCopy(which.key);
  const values = { fullName };

  return composeEmail(which.key, {
    subject: copySubject(copy.subject, values),
    values,
    brand: which.brand,
    parts: [
      part.heading(copy.heading),
      part.greeting(fullName ? copy.greeting : copy.greetingNoName),
      part.copy(copy.intro),
      part.copy(copy.bullets),
      part.button(ctaUrl, which.ctaLabel),
      part.signOff(copy.signOff),
    ],
  });
};

/**
 * Send the one-time welcome email.
 *
 * Returns the { success, error } shape every other sender here returns, and
 * never throws. No caller may fail its request on a send failure. The account
 * exists either way, and a missing welcome costs nothing that a failed signup
 * or a rejected verification would not cost far more.
 */
export const sendWelcomeEmail = async (email, fullName, { audience = 'candidate', ctaUrl = null } = {}) => {
  try {
    if (!email) {
      return { success: false, error: 'No recipient email provided' };
    }

    const emailContent = await createWelcomeEmail(fullName, audience, ctaUrl);
    const result = await sendEmail(email, emailContent.subject, emailContent.html);

    if (result.success) {
      console.log(`Welcome email (${audience}) sent to ${email}`);
    } else {
      console.error(`Failed to send welcome email to ${email}:`, result.error);
    }

    return result;
  } catch (error) {
    console.error('Error in sendWelcomeEmail:', error);
    return { success: false, error: error.message };
  }
};

// Template builders, keyed for preview ----------------------------------------
//
// Every `create*Email` above is a pure function of its arguments: it returns
// { subject, html } and touches nothing else. That is what makes a preview
// possible without a send — render the same content the send path renders and
// stop short of the transporter.
//
// Exported as a keyed map rather than 21 individual exports so callers that
// only want to enumerate templates (the preview screen) do not have to know
// each builder's name, and so the builders themselves stay module-private.
// Keys are part of the preview URL and are therefore stable; rename a builder
// freely, but changing a key breaks saved links.
export const TEMPLATE_BUILDERS = {
  'rsvp-confirmation': createRSVPConfirmationEmail,
  'attendance-confirmation': createAttendanceConfirmationEmail,
  'application-received': createApplicationReceivedEmail,
  'application-acceptance': createAcceptanceEmail,
  'application-rejection': createRejectionEmail,
  'offer-letter': createOfferLetterEmail,
  'meeting-signup-confirmation': createMeetingSignupConfirmationEmail,
  'meeting-slot-created': createMeetingSlotCreatedEmail,
  'meeting-host-reminder': createMeetingHostReminderEmail,
  'meeting-attendance-reminder': createMeetingAttendanceReminderEmail,
  'meeting-signup-notification': createMeetingSignupNotificationEmail,
  'meeting-cancellation-candidate': createMeetingCancellationEmail,
  'meeting-cancellation-member': createMeetingCancellationMemberEmail,
  'meeting-reschedule-candidate': createMeetingRescheduleEmail,
  'meeting-reschedule-member': createMeetingRescheduleMemberEmail,
  'password-reset': createPasswordResetEmail,
  'password-reset-confirmation': createPasswordResetConfirmationEmail,
  'reviewer-reminder': createReviewerReminderEmail,
  'email-verification': createEmailVerificationEmail,
  // One builder, three audiences. The preview catalog lists each audience
  // separately, because all three go out and they read differently.
  welcome: createWelcomeEmail,
};
