import { getFormQuestions } from '../src/services/google/forms.js';
import { extractFormIdFromUrl } from '../src/utils/formUtils.js';

const formUrl = process.argv[2];

if (!formUrl) {
  console.error('Usage: node scripts/inspect-form.js <form-url>');
  console.error('');
  console.error('Example:');
  console.error('  node scripts/inspect-form.js "https://docs.google.com/forms/d/1ABC..."');
  process.exit(1);
}

const formId = extractFormIdFromUrl(formUrl);
if (!formId) {
  console.error('Error: Could not extract form ID from URL');
  process.exit(1);
}

console.log('Form ID:', formId);
console.log('');
console.log('Fetching form structure...');
console.log('');

try {
  const items = await getFormQuestions(formId);

  console.log('Questions and their IDs:');
  console.log('─'.repeat(80));

  const databaseMappings = {};

  items.forEach((item, i) => {
    const qId = item.questionItem?.question?.questionId;
    if (qId) {
      const title = item.title || '(No title)';
      console.log(`${i + 1}. [${qId}]`);
      console.log(`   ${title}`);

      // Auto-detect field mapping
      const mapping = detectFieldMapping(title);
      if (mapping) {
        databaseMappings[qId] = mapping;
        console.log(`   → Auto-mapped to: ${mapping.field}`);
      } else {
        console.log(`   → Not auto-mapped (add manually if needed)`);
      }
      console.log('');
    }
  });

  console.log('─'.repeat(80));
  console.log('');
  console.log('Generated config JSON:');
  console.log('');

  const config = {
    id: formId,
    database_mappings: databaseMappings
  };

  console.log(JSON.stringify(config, null, 4));
  console.log('');
  console.log('Copy the JSON above into your config file (e.g., event-rsvp-config.json)');

} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}

// Auto-detect field mapping based on question title
function detectFieldMapping(title) {
  const lowerTitle = title.toLowerCase().trim();

  // Email
  if (lowerTitle.includes('email') || lowerTitle.includes('e-mail')) {
    return { field: 'email', type: 'string', required: true, validation: 'email' };
  }

  // Full name (check before first/last name)
  if (lowerTitle.match(/full\s*name|^name$|your\s*name|first\s*(&|and)\s*last/i)) {
    return { field: 'fullName', type: 'string', required: true };
  }

  // First name
  if (lowerTitle.match(/first\s*name|given\s*name|firstname/i)) {
    return { field: 'firstName', type: 'string', required: true };
  }

  // Last name
  if (lowerTitle.match(/last\s*name|surname|family\s*name|lastname/i)) {
    return { field: 'lastName', type: 'string', required: true };
  }

  // Student ID
  if (lowerTitle.match(/student\s*id|studentid|id\s*number|ucla.*id/i)) {
    return { field: 'studentId', type: 'string', required: true, validation: 'numeric' };
  }

  // Phone
  if (lowerTitle.match(/phone|telephone|mobile|cell/i)) {
    return { field: 'phoneNumber', type: 'string', validation: 'phone' };
  }

  // Graduation year
  if (lowerTitle.match(/graduation\s*year|grad\s*year|year.*graduat/i)) {
    return { field: 'graduationYear', type: 'string', required: true };
  }

  // Major
  if (lowerTitle.match(/^major$|primary\s*major|first\s*major/i)) {
    return { field: 'major1', type: 'string', required: true };
  }

  if (lowerTitle.match(/second\s*major|additional\s*major|double\s*major/i)) {
    return { field: 'major2', type: 'string' };
  }

  // GPA
  if (lowerTitle.match(/cumulative\s*gpa|overall\s*gpa|total\s*gpa/i)) {
    return { field: 'cumulativeGpa', type: 'decimal', validation: 'gpa' };
  }

  if (lowerTitle.match(/major\s*gpa/i)) {
    return { field: 'majorGpa', type: 'decimal', validation: 'gpa' };
  }

  // Gender
  if (lowerTitle.match(/^gender$|gender\s*identity/i)) {
    return { field: 'gender', type: 'string' };
  }

  // Transfer student
  if (lowerTitle.match(/transfer\s*student/i)) {
    return { field: 'isTransferStudent', type: 'boolean', transform: { 'Yes': true, 'No': false } };
  }

  // First generation
  if (lowerTitle.match(/first.*generation|first.*gen/i)) {
    return { field: 'isFirstGeneration', type: 'boolean', transform: { 'Yes': true, 'No': false } };
  }

  // Files
  if (lowerTitle.match(/resume|cv/i) && !lowerTitle.match(/blind/i)) {
    return { field: 'resumeUrl', type: 'file', file_type: 'pdf' };
  }

  if (lowerTitle.match(/blind.*resume/i)) {
    return { field: 'blindResumeUrl', type: 'file', file_type: 'pdf' };
  }

  if (lowerTitle.match(/cover\s*letter/i)) {
    return { field: 'coverLetterUrl', type: 'file', file_type: 'pdf' };
  }

  // Fall 2026 replaced the cover letter with a written "why UConsulting" answer.
  if (lowerTitle.match(/why do you want to join|short answer/i)) {
    return { field: 'shortAnswer', type: 'string' };
  }

  if (lowerTitle.match(/headshot|photo|picture/i)) {
    return { field: 'headshotUrl', type: 'file', file_type: 'image' };
  }

  if (lowerTitle.match(/video/i)) {
    return { field: 'videoUrl', type: 'file', file_type: 'video' };
  }

  return null;
}
