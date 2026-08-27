// The major categories the UConsulting application form offers.
//
// Taken from the answers the form has actually produced: these six account for
// all but a hundred or so of every application on file, and the long tail below
// them is free text from the form's "Other" option. Collecting the same six
// here means a candidate who onboards and a candidate who applies land in the
// same bucket, which is what makes the Talent Partner Network's major filter
// work across both pools.
export const MAJOR_OPTIONS = [
  'Economics or Business Economics',
  'Mathematics or Statistics',
  'Engineering or Computer Science',
  'Life Sciences',
  'Physical Sciences',
  'Social Sciences',
];

// Sentinel for the select, never a stored value - picking it reveals a text
// field and what gets submitted is whatever was typed there. Storing the
// literal "Other" would file a real major under a label nobody can filter on.
export const OTHER_MAJOR = '__OTHER__';

export default MAJOR_OPTIONS;
