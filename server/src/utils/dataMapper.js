import config from '../config.js';

// Transform a Google Form response into a structured database record
export function transformFormResponse(formResponse) {
  const dbRecord = {
    responseID: formResponse.responseId,
    submittedAt: new Date(formResponse.createTime),
    rawResponses: formResponse.answers // Keep raw data as backup
  };

  // Transform each answer using the field mappings
  for (const [questionId, answerData] of Object.entries(formResponse.answers || {})) {
    const mapping = config.form.database_mappings[questionId];
    
    if (!mapping) {
      console.warn(`No mapping found for question ID: ${questionId}`);
      continue;
    }

    const value = extractAnswerValue(answerData);
    const transformedValue = transformValue(value, mapping);
    
    dbRecord[mapping.field] = transformedValue;
  }

  return dbRecord;
}

//Extract the actual answer value from Google Form response structure
function extractAnswerValue(answerData) {
  if (answerData.textAnswers?.answers?.[0]?.value) {
    return answerData.textAnswers.answers[0].value;
  }
  if (answerData.fileUploadAnswers?.answers?.[0]) {
    return answerData.fileUploadAnswers.answers[0];
  }
  return null;
}

//Transform a value based on its mapping configuration
function transformValue(value, mapping) {
  if (value === null || value === undefined) {
    return mapping.required ? null : undefined;
  }

  switch (mapping.type) {
    case 'boolean':
      if (mapping.transform) {
        return mapping.transform[value] ?? null;
      }
      return Boolean(value);
    
    case 'decimal':
      const numValue = parseFloat(value);
      if (isNaN(numValue)) {
        // For GPA fields, return 0.00 if invalid instead of null
        if (mapping.field === 'majorGpa' || mapping.field === 'cumulativeGpa') {
          console.warn(`Invalid ${mapping.field} value: "${value}". Setting to 0.00.`);
          return 0.00;
        }
        return null;
      }
      // For GPA fields, cap at 9.99 to avoid overflow (precision 3, scale 2)
      if (mapping.field === 'majorGpa' || mapping.field === 'cumulativeGpa') {
        if (numValue > 9.99) {
          console.warn(`${mapping.field} value ${numValue} exceeds max 9.99. Capping at 9.99.`);
          return 9.99;
        }
        if (numValue < 0) {
          console.warn(`${mapping.field} value ${numValue} is negative. Setting to 0.00.`);
          return 0.00;
        }
      }
      return numValue;
    
    case 'string':
      // A file upload answering a question mapped as text means the form's
      // question type changed under the mapping; "[object Object]" is not an answer.
      if (typeof value === 'object') {
        console.warn(`${mapping.field} expected text but received a file upload. Skipping.`);
        return mapping.required ? null : undefined;
      }
      return String(value).trim();

    case 'file':
      // Extract Google Drive file ID and create accessible URL via our API
      return generateFileUrl(value, mapping.file_type);
    
    default:
      return value;
  }
}

// Generate accessible file URL via our API endpoints (requires Authorization header from client)
function generateFileUrl(fileData, fileType) {
  if (!fileData || !fileData.fileId) {
    return null;
  }
  
  const fileId = fileData.fileId;

  // Store relative URLs to avoid localhost/production URL mismatch issues
  // The frontend will resolve these relative to the current origin

  // Prefer actual MIME type when present
  const actualMimeType = fileData.mimeType;

  if (actualMimeType && actualMimeType.startsWith('image/')) {
    return `/api/files/${fileId}/image`;
  }
  if (actualMimeType === 'application/pdf') {
    return `/api/files/${fileId}/pdf`;
  }
  if (actualMimeType && actualMimeType.startsWith('video/')) {
    // For now route videos through pdf endpoint; client will download/open externally
    return `/api/files/${fileId}/pdf`;
  }

  // Fallback to configured file type
  if (fileType === 'image') {
    return `/api/files/${fileId}/image`;
  }
  // default to pdf
  return `/api/files/${fileId}/pdf`;
}

//Get all file upload question IDs
export function getFileUploadQuestions() {
  const mappings = getDatabaseMappings();
  return Object.entries(mappings)
    .filter(([_, mapping]) => mapping.type === 'file')
    .map(([questionId, mapping]) => ({ questionId, ...mapping }));
}

function getDatabaseMappings() {
  return config.form?.database_mappings || {};
} 