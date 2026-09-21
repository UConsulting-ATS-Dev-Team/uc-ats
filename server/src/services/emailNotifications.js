import nodemailer from 'nodemailer';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { formatEmailDateTime, formatEmailTime } from '../utils/timezoneUtils.js';
import { describeRoster } from '../utils/candidateRoster.js';
import { eventInviteFor } from './eventInvites.js';
import { recordCommunication } from './communicationLog.js';

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
const createRSVPConfirmationEmail = (candidateName, eventName, eventDate, eventLocation) => {
  const subjectName = eventName;
  candidateName = escapeHtml(candidateName);
  eventName = escapeHtml(eventName);
  eventLocation = escapeHtml(eventLocation);
  return {
    subject: `RSVP Confirmation - ${subjectName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center;">
          <h2 style="color: #333; margin: 0;">UConsulting ATS</h2>
        </div>
        
        <div style="padding: 30px 20px;">
          <h3 style="color: #333; margin-bottom: 20px;">RSVP Confirmation</h3>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Dear ${candidateName},
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Thank you for your RSVP! We have successfully received your response for the following event:
          </p>
          
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h4 style="color: #333; margin: 0 0 10px 0;">Event Details</h4>
            <p style="color: #666; margin: 5px 0;"><strong>Event:</strong> ${eventName}</p>
            ${eventLocation ? `<p style="color: #666; margin: 5px 0;"><strong>Location:</strong> ${eventLocation}</p>` : ''}
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            We look forward to seeing you at the event! If you have any questions or need to make changes to your RSVP, please don't hesitate to contact us.
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Best regards,<br>
            UConsulting ATS Team
          </p>
        </div>
        
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `
  };
};

const createAttendanceConfirmationEmail = (candidateName, eventName, eventDate, eventLocation) => {
  const subjectName = eventName;
  candidateName = escapeHtml(candidateName);
  eventName = escapeHtml(eventName);
  eventLocation = escapeHtml(eventLocation);
  return {
    subject: `Attendance Confirmation - ${subjectName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center;">
          <h2 style="color: #333; margin: 0;">UConsulting ATS</h2>
        </div>
        
        <div style="padding: 30px 20px;">
          <h3 style="color: #333; margin-bottom: 20px;">Attendance Confirmation</h3>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Dear ${candidateName},
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Thank you for attending our event! We have successfully recorded your attendance for the following event:
          </p>
          
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h4 style="color: #333; margin: 0 0 10px 0;">Event Details</h4>
            <p style="color: #666; margin: 5px 0;"><strong>Event:</strong> ${eventName}</p>
            ${eventLocation ? `<p style="color: #666; margin: 5px 0;"><strong>Location:</strong> ${eventLocation}</p>` : ''}
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            We appreciate your participation and hope you found the event valuable. If you have any feedback or questions, please feel free to reach out to us.
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Best regards,<br>
            UConsulting ATS Team
          </p>
        </div>
        
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `
  };
};

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
  const { recipientName = null, attemptKey = null, ...context } = meta || {};

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
      replyTo: process.env.EMAIL_REPLY_TO,
      to: to,
      subject: subject,
      html: html
    };

    if (hasAttachments) {
      mailOptions.attachments = attachments;
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
    const emailContent = createRSVPConfirmationEmail(candidateName, eventName, eventDate, eventLocation);
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
    const emailContent = createAttendanceConfirmationEmail(candidateName, eventName, eventDate, eventLocation);
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

// Create acceptance email template
const createAcceptanceEmail = (candidateName, currentCycleName) => {
  const subjectCycle = currentCycleName;
  candidateName = escapeHtml(candidateName);
  currentCycleName = escapeHtml(currentCycleName);
  return {
    subject: `Congratulations! You've Advanced to Coffee Chats - ${subjectCycle}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #28a745; padding: 20px; text-align: center; color: white;">
          <h2 style="color: white; margin: 0;">UConsulting ATS</h2>
        </div>
        
        <div style="padding: 30px 20px;">
          <h3 style="color: #333; margin-bottom: 20px;">🎉 Congratulations! You've Advanced!</h3>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Dear ${candidateName},
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            We're excited to inform you that you have successfully advanced to the <strong>Coffee Chats</strong> round of our recruitment process for the <strong>${currentCycleName}</strong> cycle!
          </p>
          
          <div style="background-color: #d4edda; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #28a745;">
            <h4 style="color: #155724; margin: 0 0 10px 0;">What This Means</h4>
            <p style="color: #155724; margin: 5px 0;">✅ You've successfully passed the Resume Review round</p>
            <p style="color: #155724; margin: 5px 0;">☕ You'll be invited to participate in Coffee Chats</p>
            <p style="color: #155724; margin: 5px 0;">📅 You'll receive scheduling information soon</p>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            This is a significant achievement and demonstrates the quality of your application. We look forward to getting to know you better during the Coffee Chats round.
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            You will receive additional information about scheduling and preparation for the Coffee Chats round in the coming days.
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Best regards,<br>
            UConsulting Recruitment Team
          </p>
        </div>
        
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `
  };
};

// Create rejection email template
const createRejectionEmail = (candidateName, currentCycleName) => {
  const subjectCycle = currentCycleName;
  candidateName = escapeHtml(candidateName);
  currentCycleName = escapeHtml(currentCycleName);
  return {
    subject: `Update on Your Application - ${subjectCycle}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #dc3545; padding: 20px; text-align: center; color: white;">
          <h2 style="color: white; margin: 0;">UConsulting ATS</h2>
        </div>
        
        <div style="padding: 30px 20px;">
          <h3 style="color: #333; margin-bottom: 20px;">Application Update</h3>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Dear ${candidateName},
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Thank you for your interest in UConsulting and for taking the time to apply to our <strong>${currentCycleName}</strong> recruitment cycle.
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            After careful review of your application, we regret to inform you that we are unable to move forward with your candidacy at this time.
          </p>
          
          <div style="background-color: #f8d7da; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #dc3545;">
            <h4 style="color: #721c24; margin: 0 0 10px 0;">Important Information</h4>
            <p style="color: #721c24; margin: 5px 0;">📝 Your application has been reviewed thoroughly</p>
            <p style="color: #721c24; margin: 5px 0;">💼 We encourage you to apply to future cycles</p>
            <p style="color: #721c24; margin: 5px 0;">🌟 Continue developing your skills and experience</p>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            We appreciate the time and effort you put into your application. We received many strong applications this cycle, and the decision was not easy.
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            We encourage you to continue developing your skills and to consider applying to future recruitment cycles. Your growth and development are important to us.
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Best regards,<br>
            UConsulting Recruitment Team
          </p>
        </div>
        
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `
  };
};

// Send acceptance email
export const sendAcceptanceEmail = async (candidateEmail, candidateName, currentCycleName) => {
  try {
    const emailContent = createAcceptanceEmail(candidateName, currentCycleName);
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
    const emailContent = createRejectionEmail(candidateName, currentCycleName);
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

const createOfferLetterEmail = (candidateName, currentCycleName, offerDetails) => {
  const { position, startDate, responseDeadline, additionalNotes } = offerDetails;
  candidateName = escapeHtml(candidateName);
  currentCycleName = escapeHtml(currentCycleName);
  const positionE = escapeHtml(position);
  const startDateE = escapeHtml(startDate || 'To be determined');
  const responseDeadlineE = escapeHtml(responseDeadline);
  const additionalNotesE = additionalNotes
    ? escapeHtml(additionalNotes).replace(/\n/g, '<br>')
    : '';
  return {
    subject: `Offer Letter - UConsulting ${currentCycleName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #10b981; padding: 20px; text-align: center; color: white;">
          <h2 style="color: white; margin: 0;">UConsulting ATS</h2>
        </div>
        
        <div style="padding: 30px 20px;">
          <h3 style="color: #333; margin-bottom: 20px;">Congratulations, ${candidateName}!</h3>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            We are delighted to offer you a position with <strong>UConsulting</strong> for the <strong>${currentCycleName}</strong> cycle.
          </p>
          
          <div style="background-color: #d1fae5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #10b981;">
            <h4 style="color: #065f46; margin: 0 0 10px 0;">Offer Details</h4>
            <p style="color: #065f46; margin: 5px 0;"><strong>Position:</strong> ${positionE}</p>
            <p style="color: #065f46; margin: 5px 0;"><strong>Start Date:</strong> ${startDateE}</p>
            <p style="color: #065f46; margin: 5px 0;"><strong>Response Deadline:</strong> ${responseDeadlineE}</p>
            ${additionalNotesE ? `<p style="color: #065f46; margin: 5px 0;"><strong>Additional Notes:</strong><br>${additionalNotesE}</p>` : ''}
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Please review the attached PDF for the full official offer letter, sign it, and return it before the response deadline. If you have any questions, feel free to reach out.
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            We look forward to having you on the team!
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Best regards,<br>
            UConsulting Recruitment Team
          </p>
        </div>
        
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `
  };
};

// Send offer letter email
export const sendOfferLetter = async (candidateEmail, candidateName, currentCycleName, offerDetails, attachmentBuffer = null, attachmentFilename = 'offer-letter.pdf') => {
  try {
    const emailContent = createOfferLetterEmail(candidateName, currentCycleName, offerDetails);
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
const createMeetingSignupConfirmationEmail = (candidateName, memberName, location, startTime, endTime) => {
  candidateName = escapeHtml(candidateName);
  memberName = escapeHtml(memberName);
  location = escapeHtml(location);
  startTime = escapeHtml(startTime);
  endTime = escapeHtml(endTime);
  const formatDateTime = (date) => {
    return formatEmailDateTime(date);
  };

  const formatTime = (date) => {
    return formatEmailTime(date);
  };

  return {
    subject: `Time Slot Confirmation - Get to Know UC`,
    html: `
     
  
        <div style="padding: 30px 20px;">
        
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Dear ${candidateName},
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Thank you for signing up to meet with a UConsulting member! We're excited to get to know you better.
          </p>
          
          <div style="background-color: #cce7ff; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #007bff;">
            <h4 style="color: #004085; margin: 0 0 15px 0;">Meeting Details</h4>
            <p style="color: #004085; margin: 8px 0;"><strong>Member:</strong> ${memberName}</p>
            <p style="color: #004085; margin: 8px 0;"><strong>Date & Time:</strong> ${formatDateTime(startTime)}</p>
            <p style="color: #004085; margin: 8px 0;"><strong>Duration:</strong> ${formatTime(startTime)} - ${formatTime(endTime)}</p>
            <p style="color: #004085; margin: 8px 0;"><strong>Location:</strong> ${location}</p>
          </div>
          
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h4 style="color: #333; margin: 0 0 15px 0;">What to Expect</h4>
            <p style="color: #666; margin: 8px 0;">• This is a casual chat to learn more about UC</p>
            <p style="color: #666; margin: 8px 0;">• Feel free to ask questions about our organization, projects, and culture</p>
            <p style="color: #666; margin: 8px 0;">• This is a great opportunity to connect with current members</p>
            <p style="color: #666; margin: 8px 0;">• No preparation required - just come ready to chat!</p>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Need to cancel or change your time slot? You can manage everything by logging into your <a href="https://uconsultingats.com" style="color: #007bff;">ATS account</a>.
          </p>

          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            We look forward to meeting you!
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Best,<br>
             UConsulting Recruitment Team
          </p>
        </div>
        
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `
  };
};

// Send meeting signup confirmation email
export const sendMeetingSignupConfirmation = async (candidateEmail, candidateName, memberName, location, startTime, endTime) => {
  try {
    const emailContent = createMeetingSignupConfirmationEmail(candidateName, memberName, location, startTime, endTime);
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html, [], { category: 'MEETING', recipientName: candidateName });
    
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

// Create meeting signup notification email template for members
const createMeetingSignupNotificationEmail = (memberName, candidateName, candidateEmail, studentId, location, startTime, endTime) => {
  const subjectCandidate = candidateName;
  memberName = escapeHtml(memberName);
  candidateName = escapeHtml(candidateName);
  candidateEmail = escapeHtml(candidateEmail);
  studentId = escapeHtml(studentId);
  location = escapeHtml(location);
  startTime = escapeHtml(startTime);
  endTime = escapeHtml(endTime);
  const formatDateTime = (date) => {
    return formatEmailDateTime(date);
  };

  const formatTime = (date) => {
    return formatEmailTime(date);
  };

  return {
    subject: `New GTKUC Signup - ${subjectCandidate} signed up for your slot`,
    html: `
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Hi ${memberName},
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Great news! Someone has signed up for one of your GTKUC slots. Here are the details:
          </p>
          
          <div style="background-color: #d4edda; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #28a745;">
            <h4 style="color: #155724; margin: 0 0 15px 0;">Meeting Details</h4>
            <p style="color: #155724; margin: 8px 0;"><strong>Date & Time:</strong> ${formatDateTime(startTime)}</p>
            <p style="color: #155724; margin: 8px 0;"><strong>Duration:</strong> ${formatTime(startTime)} - ${formatTime(endTime)}</p>
            <p style="color: #155724; margin: 8px 0;"><strong>Location:</strong> ${location}</p>
          </div>
          
          <div style="background-color: #cce7ff; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #007bff;">
            <h4 style="color: #004085; margin: 0 0 15px 0;">Candidate Information</h4>
            <p style="color: #004085; margin: 8px 0;"><strong>Name:</strong> ${candidateName}</p>
            <p style="color: #004085; margin: 8px 0;"><strong>Email:</strong> ${candidateEmail}</p>
          </div>
          
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h4 style="color: #333; margin: 0 0 15px 0;">Next Steps</h4>
            <p style="color: #666; margin: 8px 0;">• Mark attendance after the meeting in the ATS system</p>
            <p style="color: #666; margin: 8px 0;">• Contact the candidate if you need to reschedule</p>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            You can manage everything — your slots, signups, and attendance — in the <a href="https://uconsultingats.com" style="color: #007bff;">ATS</a>.
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Best regards,<br>
            UConsulting Recruitment Team
          </p>
        </div>
        
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `
  };
};

// Send meeting signup notification email to member
export const sendMeetingSignupNotification = async (memberEmail, memberName, candidateName, candidateEmail, studentId, location, startTime, endTime) => {
  try {
    const emailContent = createMeetingSignupNotificationEmail(memberName, candidateName, candidateEmail, studentId, location, startTime, endTime);
    const result = await sendEmail(memberEmail, emailContent.subject, emailContent.html, [], { category: 'MEETING', recipientName: memberName });
    
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
const createMeetingCancellationEmail = (candidateName, memberName, location, startTime, endTime) => {
  candidateName = escapeHtml(candidateName);
  memberName = escapeHtml(memberName);
  location = escapeHtml(location);
  startTime = escapeHtml(startTime);
  endTime = escapeHtml(endTime);
  const formatDateTime = (date) => {
    return formatEmailDateTime(date);
  };

  const formatTime = (date) => {
    return formatEmailTime(date);
  };

  return {
    subject: `Meeting Cancelled - Get to Know UC`,
    html: `
    
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #dc3545; padding: 20px; text-align: center; color: white;">
          <h2 style="color: white; margin: 0;">UConsulting ATS</h2>
        </div>
        
        <div style="padding: 30px 20px;">
          <h3 style="color: #333; margin-bottom: 20px;">Meeting Cancelled</h3>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Dear ${candidateName},
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            We regret to inform you that your scheduled meeting with UConsulting has been cancelled.
          </p>
          
          <div style="background-color: #f8d7da; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #dc3545;">
            <h4 style="color: #721c24; margin: 0 0 15px 0;">Cancelled Meeting Details</h4>
            <p style="color: #721c24; margin: 8px 0;"><strong>Member:</strong> ${memberName}</p>
            <p style="color: #721c24; margin: 8px 0;"><strong>Date & Time:</strong> ${formatDateTime(startTime)}</p>
            <p style="color: #721c24; margin: 8px 0;"><strong>Duration:</strong> ${formatTime(startTime)} - ${formatTime(endTime)}</p>
            <p style="color: #721c24; margin: 8px 0;"><strong>Location:</strong> ${location}</p>
          </div>
          
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h4 style="color: #333; margin: 0 0 15px 0;">What's Next?</h4>
            <p style="color: #666; margin: 8px 0;">• You can sign up for another available meeting slot</p>
            <p style="color: #666; margin: 8px 0;">• Manage everything by logging into your <a href="https://uconsultingats.com" style="color: #007bff;">ATS account</a></p>
            <p style="color: #666; margin: 8px 0;">• We apologize for any inconvenience this may cause</p>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            We appreciate your interest in UConsulting and hope you'll consider signing up for another meeting slot.
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Best regards,<br>
            UConsulting Team
          </p>
        </div>
        
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
      </div>
    `
  };
};

// Create password reset email template
const createPasswordResetEmail = (resetLink) => {
  // resetLink is server-generated (BASE/CLIENT URL + token), not user-controlled,
  // so it is safe to embed directly in the href and visible link text.
  return {
    subject: 'Reset Your Password - UConsulting ATS',
    html: `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reset Your Password</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f4; font-family: Arial, Helvetica, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #f4f4f4; padding: 20px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; overflow: hidden;">
          <tr>
            <td style="background-color: #f8f9fa; padding: 20px; text-align: center;">
              <h2 style="color: #042742; margin: 0;">UConsulting ATS</h2>
            </td>
          </tr>
          <tr>
            <td style="padding: 30px 20px;">
              <h3 style="color: #333; margin: 0 0 20px 0;">Password Reset Request</h3>
              <p style="color: #666; line-height: 1.6; margin: 0 0 20px 0;">
                You requested a password reset for your UConsulting ATS account.
              </p>
              <p style="color: #666; line-height: 1.6; margin: 0 0 20px 0;">
                Click the button below to choose a new password. This link expires in 30 minutes.
              </p>
              <p style="text-align: center; margin: 30px 0;">
                <a href="${resetLink}" style="background-color: #0C74C1; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">Reset Password</a>
              </p>
              <p style="color: #666; line-height: 1.6; margin: 0 0 20px 0;">
                If the button doesn&apos;t work, copy and paste this link into your browser:
              </p>
              <p style="color: #0C74C1; word-break: break-all; margin: 0 0 20px 0;">
                <a href="${resetLink}" style="color: #0C74C1; text-decoration: underline;">${resetLink}</a>
              </p>
              <p style="color: #666; line-height: 1.6; margin: 0 0 20px 0;">
                If you didn&apos;t request this, you can safely ignore this email &mdash; your password will not change.
              </p>
              <p style="color: #666; line-height: 1.6; margin: 0 0 20px 0;">
                Best regards,<br>
                UConsulting ATS Team
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px;">
              <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
  };
};

// Create password reset confirmation email template
const createPasswordResetConfirmationEmail = (fullName) => {
  const firstName = escapeHtml(fullName?.trim().split(' ')[0] || 'there');
  return {
    subject: 'Your UConsulting ATS password has been reset',
    html: `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Password Reset Confirmation</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f4; font-family: Arial, Helvetica, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #f4f4f4; padding: 20px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; overflow: hidden;">
          <tr>
            <td style="background-color: #f8f9fa; padding: 20px; text-align: center;">
              <h2 style="color: #042742; margin: 0;">UConsulting ATS</h2>
            </td>
          </tr>
          <tr>
            <td style="padding: 30px 20px;">
              <h3 style="color: #333; margin: 0 0 20px 0;">Password Reset Successful</h3>
              <p style="color: #666; line-height: 1.6; margin: 0 0 20px 0;">
                Hi ${firstName},
              </p>
              <p style="color: #666; line-height: 1.6; margin: 0 0 20px 0;">
                The password for your UConsulting ATS account was just changed.
              </p>
              <p style="color: #666; line-height: 1.6; margin: 0 0 20px 0;">
                If you made this change, you can safely ignore this email. If you did not reset your password, please contact the UConsulting ATS team immediately so we can help secure your account.
              </p>
              <p style="color: #666; line-height: 1.6; margin: 0 0 20px 0;">
                Best regards,<br>
                UConsulting ATS Team
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px;">
              <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
  };
};

// Send password reset email
export const sendPasswordResetEmail = async (email, resetLink) => {
  try {
    const emailContent = createPasswordResetEmail(resetLink);
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

    const emailContent = createPasswordResetConfirmationEmail(fullName);
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
export const sendMeetingCancellationEmail = async (candidateEmail, candidateName, memberName, location, startTime, endTime) => {
  try {
    const emailContent = createMeetingCancellationEmail(candidateName, memberName, location, startTime, endTime);
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html, [], { category: 'MEETING', recipientName: candidateName });
    
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
const createMeetingCancellationMemberEmail = (memberName, location, startTime, endTime, options = {}) => {
  const candidateName = options.candidateName ? escapeHtml(options.candidateName) : null;
  const signupCount = Number.isInteger(options.signupCount) ? options.signupCount : null;
  memberName = escapeHtml(memberName);
  location = escapeHtml(location);
  startTime = escapeHtml(startTime);
  endTime = escapeHtml(endTime);
  const formatDateTime = (date) => formatEmailDateTime(date);
  const formatTime = (date) => formatEmailTime(date);

  const intro = candidateName
    ? `${candidateName} has cancelled their signup for one of your Get to Know UC meeting slots.`
    : `One of your Get to Know UC meeting slots has been cancelled by an administrator.`;

  const impactLine = candidateName
    ? `<p style="color: #666; margin: 8px 0;">• This spot is now open again for other candidates to sign up</p>`
    : `<p style="color: #666; margin: 8px 0;">• ${signupCount ? `${signupCount} signed-up candidate(s) have` : 'Any signed-up candidates have'} been notified of the cancellation</p>`;

  return {
    subject: `Get to Know UC - Meeting Cancelled`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #dc3545; padding: 20px; text-align: center; color: white;">
          <h2 style="color: white; margin: 0;">UConsulting ATS</h2>
        </div>

        <div style="padding: 30px 20px;">
          <h3 style="color: #333; margin-bottom: 20px;">Meeting Cancelled</h3>

          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Hi ${memberName},
          </p>

          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            ${intro}
          </p>

          <div style="background-color: #f8d7da; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #dc3545;">
            <h4 style="color: #721c24; margin: 0 0 15px 0;">Cancelled Meeting Details</h4>
            ${candidateName ? `<p style="color: #721c24; margin: 8px 0;"><strong>Candidate:</strong> ${candidateName}</p>` : ''}
            <p style="color: #721c24; margin: 8px 0;"><strong>Date & Time:</strong> ${formatDateTime(startTime)}</p>
            <p style="color: #721c24; margin: 8px 0;"><strong>Duration:</strong> ${formatTime(startTime)} - ${formatTime(endTime)}</p>
            <p style="color: #721c24; margin: 8px 0;"><strong>Location:</strong> ${location}</p>
          </div>

          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h4 style="color: #333; margin: 0 0 15px 0;">What's Next?</h4>
            ${impactLine}
            <p style="color: #666; margin: 8px 0;">• Manage everything — your slots, signups, and attendance — in the <a href="https://uconsultingats.com" style="color: #007bff;">ATS</a></p>
          </div>

          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Best regards,<br>
            UConsulting Recruitment Team
          </p>
        </div>

        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `
  };
};

// Send meeting cancellation email to the HOST member.
export const sendMeetingCancellationToMember = async (memberEmail, memberName, location, startTime, endTime, options = {}) => {
  try {
    const emailContent = createMeetingCancellationMemberEmail(memberName, location, startTime, endTime, options);
    const result = await sendEmail(memberEmail, emailContent.subject, emailContent.html, [], { category: 'MEETING', recipientName: memberName });

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
const renderRescheduleDetails = (next, previous) => {
  const changedRows = [];
  if (String(previous.startTime) !== String(next.startTime) || String(previous.endTime) !== String(next.endTime)) {
    changedRows.push(
      `<p style="color: #6c757d; margin: 8px 0;"><s>${formatEmailDateTime(previous.startTime)}` +
      `${previous.endTime ? ` (until ${formatEmailTime(previous.endTime)})` : ''}</s></p>`
    );
  }
  if (previous.location !== next.location) {
    changedRows.push(`<p style="color: #6c757d; margin: 8px 0;"><s>${escapeHtml(previous.location)}</s></p>`);
  }

  return `
          <div style="background-color: #d1e7dd; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #198754;">
            <h4 style="color: #0f5132; margin: 0 0 15px 0;">New Meeting Details</h4>
            <p style="color: #0f5132; margin: 8px 0;"><strong>Date &amp; Time:</strong> ${formatEmailDateTime(next.startTime)}</p>
            ${next.endTime ? `<p style="color: #0f5132; margin: 8px 0;"><strong>Duration:</strong> ${formatEmailTime(next.startTime)} - ${formatEmailTime(next.endTime)}</p>` : ''}
            <p style="color: #0f5132; margin: 8px 0;"><strong>Location:</strong> ${escapeHtml(next.location)}</p>
          </div>

          ${changedRows.length ? `
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h4 style="color: #6c757d; margin: 0 0 15px 0;">Previously</h4>
            ${changedRows.join('\n            ')}
          </div>` : ''}`;
};

// Reschedule notice directed at a signed-up CANDIDATE.
const createMeetingRescheduleEmail = (candidateName, memberName, next, previous) => {
  candidateName = escapeHtml(candidateName);
  memberName = escapeHtml(memberName);

  return {
    subject: 'Meeting Rescheduled - Get to Know UC',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #fd7e14; padding: 20px; text-align: center; color: white;">
          <h2 style="color: white; margin: 0;">UConsulting ATS</h2>
        </div>

        <div style="padding: 30px 20px;">
          <h3 style="color: #333; margin-bottom: 20px;">Your Meeting Has Moved</h3>

          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Hi ${candidateName},
          </p>

          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Your Get to Know UC meeting with ${memberName} has been rescheduled. Your spot is
            still held - you do not need to sign up again. Please check the new details below
            and update your calendar.
          </p>
${renderRescheduleDetails(next, previous)}

          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h4 style="color: #333; margin: 0 0 15px 0;">If the new time doesn't work</h4>
            <p style="color: #666; margin: 8px 0;">• Cancel or rebook your meeting in the <a href="https://uconsultingats.com" style="color: #007bff;">ATS</a></p>
            <p style="color: #666; margin: 8px 0;">• If it is too close to the start time to change it yourself, email recruitment</p>
          </div>

          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Best regards,<br>
            UConsulting Recruitment Team
          </p>
        </div>

        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `
  };
};

// Send the reschedule notice to a signed-up candidate.
export const sendMeetingRescheduleEmail = async (candidateEmail, candidateName, memberName, next, previous) => {
  try {
    const emailContent = createMeetingRescheduleEmail(candidateName, memberName, next, previous);
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html, [], { category: 'MEETING', recipientName: candidateName });

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
const createMeetingRescheduleMemberEmail = (memberName, next, previous, options = {}) => {
  memberName = escapeHtml(memberName);
  const signupCount = Number.isInteger(options.signupCount) ? options.signupCount : null;

  const impactLine = signupCount
    ? `<p style="color: #666; margin: 8px 0;">• ${signupCount} signed-up candidate(s) have been emailed the new time</p>`
    : `<p style="color: #666; margin: 8px 0;">• Nobody has signed up for this slot yet, so no candidates were emailed</p>`;

  return {
    subject: 'Get to Know UC - Meeting Rescheduled',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #fd7e14; padding: 20px; text-align: center; color: white;">
          <h2 style="color: white; margin: 0;">UConsulting ATS</h2>
        </div>

        <div style="padding: 30px 20px;">
          <h3 style="color: #333; margin-bottom: 20px;">One of Your Slots Has Moved</h3>

          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Hi ${memberName},
          </p>

          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            An administrator has rescheduled one of your Get to Know UC meeting slots.
            Please check the new details below and update your calendar.
          </p>
${renderRescheduleDetails(next, previous)}

          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h4 style="color: #333; margin: 0 0 15px 0;">What's Next?</h4>
            ${impactLine}
            <p style="color: #666; margin: 8px 0;">• Manage everything — your slots, signups, and attendance — in the <a href="https://uconsultingats.com" style="color: #007bff;">ATS</a></p>
          </div>

          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Best regards,<br>
            UConsulting Recruitment Team
          </p>
        </div>

        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `
  };
};

// Send the reschedule notice to the HOST member.
export const sendMeetingRescheduleToMember = async (memberEmail, memberName, next, previous, options = {}) => {
  try {
    const emailContent = createMeetingRescheduleMemberEmail(memberName, next, previous, options);
    const result = await sendEmail(memberEmail, emailContent.subject, emailContent.html, [], { category: 'MEETING', recipientName: memberName });

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

const createReviewerReminderEmail = (reviewerName, teamName, cycleName, progress) => {
  reviewerName = escapeHtml(reviewerName);
  teamName = escapeHtml(teamName);
  cycleName = escapeHtml(cycleName);
  const { completed, eligible, completedTotal, expectedTotal, completionPercent, gradingUrl } = progress;
  return {
    subject: `Reminder: Submit your review grades - ${cycleName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center;">
          <h2 style="color: #333; margin: 0;">UConsulting ATS</h2>
        </div>

        <div style="padding: 30px 20px;">
          <h3 style="color: #333; margin-bottom: 20px;">Review Reminder</h3>

          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Hi ${reviewerName},
          </p>

          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            This is a friendly reminder to submit your remaining grades for <strong>${teamName}</strong> in the <strong>${cycleName}</strong> recruiting cycle.
          </p>

          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h4 style="color: #333; margin: 0 0 10px 0;">Your current progress</h4>
            <p style="color: #666; margin: 5px 0;"><strong>Overall:</strong> ${completedTotal}/${expectedTotal} (${completionPercent}% complete)</p>
            <p style="color: #666; margin: 5px 0;"><strong>Resume:</strong> ${completed.resume}/${eligible.resume}</p>
            <p style="color: #666; margin: 5px 0;"><strong>Cover Letter:</strong> ${completed.coverLetter}/${eligible.coverLetter}</p>
            <p style="color: #666; margin: 5px 0;"><strong>Video:</strong> ${completed.video}/${eligible.video}</p>
          </div>

          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Please complete your evaluations in the ATS:
          </p>

          <p style="text-align: center; margin: 30px 0;">
            <a href="${gradingUrl}" style="background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Grade Applications</a>
          </p>

          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Best regards,<br>
            UConsulting Recruitment Team
          </p>
        </div>

        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `
  };
};

// Send a reviewer reminder email with team/progress context and a link to the grading workflow.
export const sendReviewerReminder = async (reviewerEmail, reviewerName, teamName, cycleName, progress) => {
  try {
    if (!reviewerEmail || !reviewerEmail.includes('@')) {
      return { success: false, error: 'Invalid reviewer email address' };
    }

    const emailContent = createReviewerReminderEmail(reviewerName, teamName, cycleName, progress);
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

/// What each notification type actually says. Separated from the markup so the
/// wording is reviewable in one place - these are the sentences a candidate
/// reads at the most anxious point in the process, and they should be plain.
const SLOT_EMAIL_COPY = {
  CONFIRMATION: {
    heading: 'Your time is confirmed',
    body: (ctx) => `You're booked for ${ctx.interviewTitle}. The details are below - add them to your calendar now so they don't get lost.`,
  },
  WAITLIST_ADDED: {
    heading: "You have a spot, and you're on the waitlist",
    body: (ctx) =>
      `Your first choice was full, so we've booked you into ${ctx.slotName} and added you to the waitlist for ${ctx.preferredName}. ` +
      'You have a confirmed spot either way - if the one you wanted opens up, we move you automatically and email you.',
  },
  PROMOTED: {
    heading: 'You got your preferred time',
    body: (ctx) => `A spot opened up in ${ctx.slotName}, so we've moved you. Your previous time has been released - the details below are the ones that count.`,
  },
  FALLBACK_RELEASED: {
    heading: 'Your time has changed',
    body: () => 'You have been moved to the time you originally asked for. Your earlier booking has been released.',
  },
  CANCELLATION: {
    heading: 'Your booking is cancelled',
    body: (ctx) => `Your spot for ${ctx.interviewTitle} has been cancelled. If this was not you, contact recruitment as soon as you can.`,
  },
  MOVED_BY_ADMIN: {
    heading: 'Your time has been updated',
    body: (ctx) => `Recruitment has moved your ${ctx.interviewTitle} booking. Your new time is below - please check it carefully.`,
  },
  ADMIN_OVERFLOW_ALERT: {
    heading: 'A candidate could not be scheduled',
    body: (ctx) =>
      `${ctx.candidateName} tried to sign up for ${ctx.interviewTitle} and every slot was full, so no spot could be given automatically. ` +
      'They have been told recruitment will reach out. Place them from the interview roster - you can book over capacity if you need to.',
  },
  AVAILABILITY_REQUEST: {
    heading: 'When can you interview?',
    body: (ctx) =>
      `Recruitment is putting together the schedule for ${ctx.interviewTitle} and needs to know when you are free. ` +
      'Add your availability and they will build the day around it - including how many interviews run at once, ' +
      'which is decided by how many of us can be there.',
  },
  INTERVIEWER_ASSIGNED: {
    heading: "You're interviewing",
    body: (ctx) =>
      ctx.selfSignup
        ? `You signed up to run a ${ctx.interviewTitle} session. The details are below, and the invite attached goes straight on your calendar.`
        : `You have been placed in ${ctx.interviewTitle}. The details are below - add them to your calendar.`,
  },
  INTERVIEWER_MOVED: {
    heading: 'Your interview session has changed',
    body: (ctx) =>
      `Recruitment has moved which ${ctx.interviewTitle} session you are running` +
      (ctx.fromName ? ` - you were on ${ctx.fromName}.` : '.') +
      ' Your new session is below. Please check it and update your calendar.',
  },
  INTERVIEWER_REMOVED: {
    heading: 'You have been taken off a session',
    body: (ctx) => `You are no longer down to interview at this session for ${ctx.interviewTitle}.`,
  },
  REMINDER: {
    heading: 'A reminder about your upcoming interview',
    body: (ctx) => `This is a reminder about your ${ctx.interviewTitle} booking.`,
  },
};

// Subject lines for the same notifications. These used to live in
// interviewSlotComms.js, one import away from the bodies above, and the two
// lists drifted: INTERVIEWER_MOVED had a body and no subject, so queueing one
// called undefined(...) and the TypeError was swallowed by the caller. Keeping
// both maps in the same file is what makes the mismatch visible, and
// SLOT_EMAIL_TYPES below is asserted against both.
export const SLOT_NOTIFICATION_SUBJECTS = {
  CONFIRMATION: (interviewTitle) => `You're confirmed - ${interviewTitle}`,
  WAITLIST_ADDED: (interviewTitle) => `Your spot is booked, and you're on the waitlist - ${interviewTitle}`,
  PROMOTED: (interviewTitle) => `Good news - you got your preferred time for ${interviewTitle}`,
  FALLBACK_RELEASED: (interviewTitle) => `Your time has changed - ${interviewTitle}`,
  CANCELLATION: (interviewTitle) => `Your booking is cancelled - ${interviewTitle}`,
  MOVED_BY_ADMIN: (interviewTitle) => `Your time has been updated - ${interviewTitle}`,
  ADMIN_OVERFLOW_ALERT: (interviewTitle) => `Action needed: a candidate could not be scheduled for ${interviewTitle}`,
  AVAILABILITY_REQUEST: (interviewTitle) => `When can you interview? - ${interviewTitle}`,
  INTERVIEWER_ASSIGNED: (interviewTitle) => `You're interviewing - ${interviewTitle}`,
  INTERVIEWER_MOVED: (interviewTitle) => `Your session has changed - ${interviewTitle}`,
  INTERVIEWER_REMOVED: (interviewTitle) => `You've been taken off a session - ${interviewTitle}`,
  REMINDER: (interviewTitle) => `Reminder - ${interviewTitle}`,
};

// Derived, never hand-written, so a type added to the copy above cannot be left
// out of the preview catalog or the subject map without a test failing.
export const SLOT_EMAIL_TYPES = Object.keys(SLOT_EMAIL_COPY);

/**
 * One notification, rendered.
 *
 * Takes an InterviewSlotNotification with its slot, interview and signup loaded.
 * `ctaUrl` is built by the caller from config.clientUrl - this module has never
 * imported config, and every link in it arrives as a finished string.
 */
export const renderInterviewSlotEmail = (
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

  const ctx = {
    interviewTitle: interview.title || 'your interview',
    fromName: fromSlotName,
    slotName: slot.label || formatEmailDateTime(slot.startTime),
    preferredName: preferredSlotName || 'your first choice',
    candidateName: [application.firstName, application.lastName].filter(Boolean).join(' ') || 'A candidate',
    selfSignup,
  };

  const copy = SLOT_EMAIL_COPY[notification.type] ?? SLOT_EMAIL_COPY.CONFIRMATION;
  // Nothing to show in a details card when there is no session yet, or when the
  // point of the message is that a booking is gone.
  const showDetails = hasSession && !['CANCELLATION', 'AVAILABILITY_REQUEST', 'INTERVIEWER_REMOVED'].includes(notification.type);

  const heading = escapeHtml(copy.heading);
  const body = escapeHtml(copy.body(ctx));
  const title = escapeHtml(ctx.interviewTitle);
  const when = hasSession
    ? escapeHtml(`${formatEmailDateTime(slot.startTime)} - ${formatEmailTime(slot.endTime)}`)
    : '';
  const where = escapeHtml(slot.location || interview.location || '');
  const blockLabel = slot.label ? escapeHtml(slot.label) : null;
  // Who the interviewer is seeing. Arrives already narrowed to interviewer
  // notifications, so a candidate's own email can never grow this line.
  const roster = describeRoster(notification.candidateRoster);
  const who = roster ? escapeHtml(roster) : null;

  return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center;">
          <h2 style="color: #042742; margin: 0;">UConsulting</h2>
        </div>

        <div style="padding: 30px 20px;">
          <h3 style="color: #333; margin-bottom: 20px;">${heading}</h3>

          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">${body}</p>

          ${
            !showDetails
              ? ''
              : `<div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h4 style="color: #333; margin: 0 0 10px 0;">${title}</h4>
            ${blockLabel ? `<p style="color: #666; margin: 5px 0;"><strong>Session:</strong> ${blockLabel}</p>` : ''}
            <p style="color: #666; margin: 5px 0;"><strong>When:</strong> ${when}</p>
            ${where ? `<p style="color: #666; margin: 5px 0;"><strong>Where:</strong> ${where}</p>` : ''}
            ${who ? `<p style="color: #666; margin: 5px 0;"><strong>Who you're seeing:</strong> ${who}</p>` : ''}
          </div>`
          }

          ${
            ctaUrl
              ? `<p style="text-align: center; margin: 30px 0;">
            <a href="${ctaUrl}" style="background-color: #0C74C1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">${escapeHtml(ctaLabel)}</a>
          </p>`
              : ''
          }

          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Best regards,<br>
            UConsulting Recruitment
          </p>
        </div>

        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `;
};

// ---------------------------------------------------------------------------
// External talent portal
// ---------------------------------------------------------------------------

const createEmailVerificationEmail = (fullName, verifyLink) => {
  // verifyLink is server-generated (CLIENT_URL + token), not user-controlled,
  // so it is safe to embed directly in the href and visible link text. fullName
  // IS user-controlled - it is whatever the person typed at signup - so it is
  // escaped before it reaches the template.
  const greeting = fullName ? `Hi ${escapeHtml(fullName)},` : 'Hi,';
  return {
    subject: 'Verify Your Email - UConsulting Talent Network',
    html: `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Verify Your Email</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f4; font-family: Arial, Helvetica, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #f4f4f4; padding: 20px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; overflow: hidden;">
          <tr>
            <td style="background-color: #f8f9fa; padding: 20px; text-align: center;">
              <h2 style="color: #042742; margin: 0;">UConsulting Talent Network</h2>
            </td>
          </tr>
          <tr>
            <td style="padding: 30px 20px;">
              <h3 style="color: #333; margin: 0 0 20px 0;">Confirm your UCLA email</h3>
              <p style="color: #666; line-height: 1.6; margin: 0 0 20px 0;">
                ${greeting}
              </p>
              <p style="color: #666; line-height: 1.6; margin: 0 0 20px 0;">
                Thanks for joining the UConsulting Talent Network. Confirm this address to finish setting up your profile and upload your resume. This link expires in 24 hours.
              </p>
              <p style="text-align: center; margin: 30px 0;">
                <a href="${verifyLink}" style="background-color: #0C74C1; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">Verify Email</a>
              </p>
              <p style="color: #666; line-height: 1.6; margin: 0 0 20px 0;">
                If the button doesn&apos;t work, copy and paste this link into your browser:
              </p>
              <p style="color: #0C74C1; word-break: break-all; margin: 0 0 20px 0;">
                <a href="${verifyLink}" style="color: #0C74C1; text-decoration: underline;">${verifyLink}</a>
              </p>
              <p style="color: #666; line-height: 1.6; margin: 0 0 20px 0;">
                If you didn&apos;t sign up, you can safely ignore this email &mdash; no profile will be created.
              </p>
              <p style="color: #666; line-height: 1.6; margin: 0 0 20px 0;">
                Best regards,<br>
                UConsulting Talent Network
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px;">
              <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
  };
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

    const emailContent = createEmailVerificationEmail(fullName, verifyLink);
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
// Welcome
// ---------------------------------------------------------------------------

/**
 * Per-audience copy for the welcome email.
 *
 * Three audiences rather than one generic body, because "you signed up" means
 * three different things here: a candidate is tracking an application, a
 * talent-portal account has no application at all and only a profile, and a
 * member is staff who will be grading and interviewing. One shared body would
 * be wrong for at least two of them, and a welcome that describes the wrong app
 * is worse than no welcome.
 */
const WELCOME_COPY = {
  candidate: {
    subject: 'Welcome to UConsulting Recruitment',
    heading: 'Your account is ready',
    intro: 'Your email is confirmed, so your UConsulting recruitment account is live. This is where you track everything from here on.',
    bullets: [
      'Follow your application status as it moves through each round',
      'RSVP to recruitment events and coffee chats',
      'Get interview prep materials before each round'
    ],
    ctaLabel: 'Go to your dashboard',
    signoff: 'UConsulting Recruitment'
  },
  talent: {
    subject: 'Welcome to the UConsulting Talent Network',
    heading: 'Your profile is ready',
    intro: 'Your email is confirmed, so your Talent Network profile is live. Finishing it is what puts you in front of our partner companies.',
    bullets: [
      'Upload your resume and keep the latest version on file',
      'Fill in your profile so partners can find you',
      'Choose whether to share your profile with the Talent Partner Network'
    ],
    ctaLabel: 'Finish your profile',
    signoff: 'UConsulting Talent Network'
  },
  member: {
    subject: 'Welcome to the UConsulting ATS',
    heading: 'Your member account is ready',
    intro: 'Your UConsulting ATS member account is set up. This is the tool we run recruitment out of.',
    bullets: [
      'See the interviews you have been assigned to',
      'Grade resumes, cover letters and videos for your review team',
      'Submit evaluations after each interview'
    ],
    ctaLabel: 'Open the ATS',
    signoff: 'UConsulting'
  }
};

/**
 * `ctaUrl` is built by the caller from config.clientUrl, per the rule this
 * module has followed throughout: it never imports config, and every link
 * arrives as a finished string. fullName is whatever the person typed at
 * signup, so it is escaped before it reaches the template.
 */
const createWelcomeEmail = (fullName, audience, ctaUrl) => {
  const copy = WELCOME_COPY[audience] ?? WELCOME_COPY.candidate;
  const greeting = fullName ? `Hi ${escapeHtml(fullName)},` : 'Hi,';
  const bullets = copy.bullets
    .map((line) => `<li style="margin: 0 0 8px 0;">${escapeHtml(line)}</li>`)
    .join('');

  return {
    subject: copy.subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center;">
          <h2 style="color: #042742; margin: 0;">${escapeHtml(copy.signoff)}</h2>
        </div>

        <div style="padding: 30px 20px;">
          <h3 style="color: #333; margin: 0 0 20px 0;">${escapeHtml(copy.heading)}</h3>

          <p style="color: #666; line-height: 1.6; margin: 0 0 20px 0;">${greeting}</p>

          <p style="color: #666; line-height: 1.6; margin: 0 0 20px 0;">${escapeHtml(copy.intro)}</p>

          <ul style="color: #666; line-height: 1.6; margin: 0 0 20px 0; padding-left: 20px;">${bullets}</ul>

          ${
            ctaUrl
              ? `<p style="text-align: center; margin: 30px 0;">
            <a href="${ctaUrl}" style="background-color: #0C74C1; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">${escapeHtml(copy.ctaLabel)}</a>
          </p>`
              : ''
          }

          <p style="color: #666; line-height: 1.6; margin: 0 0 20px 0;">
            Best regards,<br>
            ${escapeHtml(copy.signoff)}
          </p>
        </div>

        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `
  };
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

    const emailContent = createWelcomeEmail(fullName, audience, ctaUrl);
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
  'application-acceptance': createAcceptanceEmail,
  'application-rejection': createRejectionEmail,
  'offer-letter': createOfferLetterEmail,
  'meeting-signup-confirmation': createMeetingSignupConfirmationEmail,
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
