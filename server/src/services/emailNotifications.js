import nodemailer from 'nodemailer';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { formatEmailDateTime, formatEmailTime } from '../utils/timezoneUtils.js';

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
const sendEmail = async (to, subject, html, attachments = []) => {
  try {
    const transporter = createTransporter();
    
    const mailOptions = {
      from: `"UConsulting ATS" <${process.env.EMAIL_FROM}>`,
      replyTo: process.env.EMAIL_REPLY_TO,
      to: to,
      subject: subject,
      html: html
    };

    if (attachments && attachments.length > 0) {
      mailOptions.attachments = attachments;
    }

    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent successfully:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Error sending email:', error);
    return { success: false, error: error.message };
  }
};

// Send RSVP confirmation email
export const sendRSVPConfirmation = async (candidateEmail, candidateName, eventName, eventDate, eventLocation) => {
  try {
    const emailContent = createRSVPConfirmationEmail(candidateName, eventName, eventDate, eventLocation);
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html);
    
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
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html);
    
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
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html);
    
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
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html);
    
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

// Create coffee chat acceptance email template (advancing to first round)
const createCoffeeChatAcceptanceEmail = (candidateName, currentCycleName) => {
  const subjectCycle = currentCycleName;
  candidateName = escapeHtml(candidateName);
  currentCycleName = escapeHtml(currentCycleName);
  return {
    subject: `Congratulations! You've Advanced to First Round Interviews - ${subjectCycle}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #007bff; padding: 20px; text-align: center; color: white;">
          <h2 style="color: white; margin: 0;">UConsulting ATS</h2>
        </div>
        
        <div style="padding: 30px 20px;">
          <h3 style="color: #333; margin-bottom: 20px;">🎉 Congratulations! You've Advanced to First Round Interviews!</h3>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Dear ${candidateName},
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            We're thrilled to inform you that you have successfully advanced to the <strong>First Round Interviews</strong> of our recruitment process for the <strong>${currentCycleName}</strong> cycle!
          </p>
          
          <div style="background-color: #cce7ff; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #007bff;">
            <h4 style="color: #004085; margin: 0 0 10px 0;">What This Means</h4>
            <p style="color: #004085; margin: 5px 0;">✅ You've successfully passed the Coffee Chat round</p>
            <p style="color: #004085; margin: 5px 0;">🎯 You'll be invited to participate in First Round Interviews</p>
            <p style="color: #004085; margin: 5px 0;">📅 You'll receive detailed scheduling information soon</p>
            <p style="color: #004085; margin: 5px 0;">📋 Prepare for behavioral and market sizing questions</p>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            This is a significant achievement! Your performance during the Coffee Chat round impressed our team, and we're excited to learn more about your qualifications during the First Round Interviews.
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            The First Round Interviews will include both behavioral questions and a market sizing case. We'll send you detailed preparation materials and scheduling information in the coming days.
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

// Create coffee chat rejection email template
const createCoffeeChatRejectionEmail = (candidateName, currentCycleName) => {
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
            Thank you for your interest in UConsulting and for participating in our <strong>${currentCycleName}</strong> recruitment cycle.
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            After careful consideration following the Coffee Chat round, we regret to inform you that we are unable to move forward with your candidacy at this time.
          </p>
          
          <div style="background-color: #f8d7da; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #dc3545;">
            <h4 style="color: #721c24; margin: 0 0 10px 0;">Important Information</h4>
            <p style="color: #721c24; margin: 5px 0;">📝 Your application and Coffee Chat performance were reviewed thoroughly</p>
            <p style="color: #721c24; margin: 5px 0;">💼 We encourage you to apply to future recruitment cycles</p>
            <p style="color: #721c24; margin: 5px 0;">🌟 Continue developing your skills and experience</p>
            <p style="color: #721c24; margin: 5px 0;">🤝 We appreciate your time and engagement in our process</p>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            We appreciate the time and effort you put into your application and participation in the Coffee Chat round. We received many strong applications this cycle, and the decision was not easy.
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
      </div>
    `
  };
};

// First Round specific email templates

// Create first round acceptance email template (advancing to final round)
const createFirstRoundAcceptanceEmail = (candidateName, currentCycleName) => {
  const subjectCycle = currentCycleName;
  candidateName = escapeHtml(candidateName);
  currentCycleName = escapeHtml(currentCycleName);
  return {
    subject: `Congratulations! You've Advanced to Final Round - ${subjectCycle}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #007bff; padding: 20px; text-align: center; color: white;">
          <h2 style="color: white; margin: 0;">UConsulting ATS</h2>
        </div>
        
        <div style="padding: 30px 20px;">
          <h3 style="color: #333; margin-bottom: 20px;">🎉 Congratulations! You've Advanced to Final Round!</h3>
          
          <p style="color: #555; line-height: 1.6; margin-bottom: 20px;">
            Dear ${candidateName},
          </p>
          
          <p style="color: #555; line-height: 1.6; margin-bottom: 20px;">
            We are excited to inform you that you have successfully advanced to the Final Round of our recruitment process for ${currentCycleName}!
          </p>
          
          <p style="color: #555; line-height: 1.6; margin-bottom: 20px;">
            Your performance in the First Round interviews was impressive, and we look forward to learning more about you in the final stage of our selection process.
          </p>
          
          <p style="color: #555; line-height: 1.6; margin-bottom: 20px;">
            <strong>Next Steps:</strong><br>
            • You will receive further instructions about the Final Round process<br>
            • Please keep an eye on your email for scheduling details<br>
            • Continue to prepare for the final stage of interviews
          </p>
          
          <p style="color: #555; line-height: 1.6; margin-bottom: 20px;">
            Congratulations on making it this far! We're excited to see what you bring to the Final Round.
          </p>
          
          <p style="color: #555; line-height: 1.6; margin-bottom: 20px;">
            Best regards,<br>
            The UConsulting Recruitment Team
          </p>
        </div>
        
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 12px;">
          <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `
  };
};

// Create first round rejection email template
const createFirstRoundRejectionEmail = (candidateName, currentCycleName) => {
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
          
          <p style="color: #555; line-height: 1.6; margin-bottom: 20px;">
            Dear ${candidateName},
          </p>
          
          <p style="color: #555; line-height: 1.6; margin-bottom: 20px;">
            Thank you for your interest in joining UConsulting and for participating in our recruitment process for ${currentCycleName}.
          </p>
          
          <p style="color: #555; line-height: 1.6; margin-bottom: 20px;">
            After careful consideration of your First Round interview performance, we have decided not to advance your application to the Final Round at this time.
          </p>
          
          <p style="color: #555; line-height: 1.6; margin-bottom: 20px;">
            This decision was not made lightly, and we appreciate the time and effort you invested in our process. We encourage you to apply again in future recruitment cycles.
          </p>
          
          <p style="color: #555; line-height: 1.6; margin-bottom: 20px;">
            We wish you the best of luck in your future endeavors.
          </p>
          
          <p style="color: #555; line-height: 1.6; margin-bottom: 20px;">
            Best regards,<br>
            The UConsulting Recruitment Team
          </p>
        </div>
        
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 12px;">
          <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `
  };
};

// Send coffee chat acceptance email (advancing to first round)
export const sendCoffeeChatAcceptanceEmail = async (candidateEmail, candidateName, currentCycleName) => {
  try {
    const emailContent = createCoffeeChatAcceptanceEmail(candidateName, currentCycleName);
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html);
    
    if (result.success) {
      console.log(`Coffee chat acceptance email sent to ${candidateEmail} for cycle: ${currentCycleName}`);
    } else {
      console.error(`Failed to send coffee chat acceptance email to ${candidateEmail}:`, result.error);
    }
    
    return result;
  } catch (error) {
    console.error('Error in sendCoffeeChatAcceptanceEmail:', error);
    return { success: false, error: error.message };
  }
};

// Send coffee chat rejection email
export const sendCoffeeChatRejectionEmail = async (candidateEmail, candidateName, currentCycleName) => {
  try {
    const emailContent = createCoffeeChatRejectionEmail(candidateName, currentCycleName);
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html);
    
    if (result.success) {
      console.log(`Coffee chat rejection email sent to ${candidateEmail} for cycle: ${currentCycleName}`);
    } else {
      console.error(`Failed to send coffee chat rejection email to ${candidateEmail}:`, result.error);
    }
    
    return result;
  } catch (error) {
    console.error('Error in sendCoffeeChatRejectionEmail:', error);
    return { success: false, error: error.message };
  }
};

// Final Round specific email templates

// Create final round acceptance email template
const createFinalAcceptanceEmail = (candidateName, currentCycleName) => {
  const subjectCycle = currentCycleName;
  candidateName = escapeHtml(candidateName);
  currentCycleName = escapeHtml(currentCycleName);
  return {
    subject: `🎉 Congratulations! You've Been Accepted to UConsulting - ${subjectCycle}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #28a745; padding: 20px; text-align: center; color: white;">
          <h2 style="color: white; margin: 0;">UConsulting ATS</h2>
        </div>
        
        <div style="padding: 30px 20px;">
          <h3 style="color: #333; margin-bottom: 20px;">🎉 Congratulations! You've Been Accepted!</h3>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Dear ${candidateName},
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            We are thrilled to inform you that you have been <strong>ACCEPTED</strong> to join UConsulting for the <strong>${currentCycleName}</strong> recruitment cycle!
          </p>
          
          <div style="background-color: #d4edda; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #28a745;">
            <h4 style="color: #155724; margin: 0 0 10px 0;">What This Means</h4>
            <p style="color: #155724; margin: 5px 0;">🎯 You've successfully completed our entire recruitment process</p>
            <p style="color: #155724; margin: 5px 0;">✅ You've been selected to join UConsulting</p>
            <p style="color: #155724; margin: 5px 0;">🌟 You'll receive onboarding information soon</p>
            <p style="color: #155724; margin: 5px 0;">🤝 Welcome to the UConsulting team!</p>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            This is an incredible achievement! You've demonstrated exceptional qualifications throughout our rigorous recruitment process, and we're excited to have you join our team.
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            You will receive detailed onboarding information, including next steps, orientation details, and important dates in the coming days. Please keep an eye on your email for these communications.
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Congratulations once again, and welcome to UConsulting!
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

// Create final round rejection email template
const createFinalRejectionEmail = (candidateName, currentCycleName) => {
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
            Thank you for your continued interest in UConsulting and for your participation throughout our <strong>${currentCycleName}</strong> recruitment process.
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            After careful consideration following the Final Round, we regret to inform you that we are unable to offer you a position at this time.
          </p>
          
          <div style="background-color: #f8d7da; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #dc3545;">
            <h4 style="color: #721c24; margin: 0 0 10px 0;">Important Information</h4>
            <p style="color: #721c24; margin: 5px 0;">📝 Your application was thoroughly reviewed at every stage</p>
            <p style="color: #721c24; margin: 5px 0;">💼 We encourage you to apply to future recruitment cycles</p>
            <p style="color: #721c24; margin: 5px 0;">🌟 Continue developing your skills and experience</p>
            <p style="color: #721c24; margin: 5px 0;">🤝 We appreciate your dedication throughout our process</p>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            We were impressed by your qualifications and dedication throughout our recruitment process. The decision was extremely difficult, as we received many exceptional applications this cycle.
          </p>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            We encourage you to continue developing your skills and to consider applying to future recruitment cycles. Your growth and potential are evident, and we believe you have a bright future ahead.
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

// Send first round acceptance email (advancing to final round)
export const sendFirstRoundAcceptanceEmail = async (candidateEmail, candidateName, currentCycleName) => {
  try {
    const emailContent = createFirstRoundAcceptanceEmail(candidateName, currentCycleName);
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html);
    
    if (result.success) {
      console.log(`First round acceptance email sent to ${candidateEmail} for cycle: ${currentCycleName}`);
    } else {
      console.error(`Failed to send first round acceptance email to ${candidateEmail}:`, result.error);
    }
    
    return result;
  } catch (error) {
    console.error('Error in sendFirstRoundAcceptanceEmail:', error);
    return { success: false, error: error.message };
  }
};

// Send first round rejection email
export const sendFirstRoundRejectionEmail = async (candidateEmail, candidateName, currentCycleName) => {
  try {
    const emailContent = createFirstRoundRejectionEmail(candidateName, currentCycleName);
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html);
    
    if (result.success) {
      console.log(`First round rejection email sent to ${candidateEmail} for cycle: ${currentCycleName}`);
    } else {
      console.error(`Failed to send first round rejection email to ${candidateEmail}:`, result.error);
    }
    
    return result;
  } catch (error) {
    console.error('Error in sendFirstRoundRejectionEmail:', error);
    return { success: false, error: error.message };
  }
};

// Send final round acceptance email
export const sendFinalAcceptanceEmail = async (candidateEmail, candidateName, currentCycleName) => {
  try {
    const emailContent = createFinalAcceptanceEmail(candidateName, currentCycleName);
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html);
    
    if (result.success) {
      console.log(`Final acceptance email sent to ${candidateEmail} for cycle: ${currentCycleName}`);
    } else {
      console.error(`Failed to send final acceptance email to ${candidateEmail}:`, result.error);
    }
    
    return result;
  } catch (error) {
    console.error('Error in sendFinalAcceptanceEmail:', error);
    return { success: false, error: error.message };
  }
};

// Send final round rejection email
export const sendFinalRejectionEmail = async (candidateEmail, candidateName, currentCycleName) => {
  try {
    const emailContent = createFinalRejectionEmail(candidateName, currentCycleName);
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html);
    
    if (result.success) {
      console.log(`Final rejection email sent to ${candidateEmail} for cycle: ${currentCycleName}`);
    } else {
      console.error(`Failed to send final rejection email to ${candidateEmail}:`, result.error);
    }
    
    return result;
  } catch (error) {
    console.error('Error in sendFinalRejectionEmail:', error);
    return { success: false, error: error.message };
  }
};

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
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html, attachments);
    
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
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html);
    
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
    const result = await sendEmail(memberEmail, emailContent.subject, emailContent.html);
    
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
    const result = await sendEmail(email, emailContent.subject, emailContent.html);

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
    const result = await sendEmail(email, emailContent.subject, emailContent.html);

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
    const result = await sendEmail(candidateEmail, emailContent.subject, emailContent.html);
    
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
    const result = await sendEmail(memberEmail, emailContent.subject, emailContent.html);

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
    const result = await sendEmail(reviewerEmail, emailContent.subject, emailContent.html);

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
