import { describe, it, expect } from 'vitest';

const ROUTE_CSS_FILES = [
  'ApplicationDetail.css',
  'FirstRoundInterviewInterface.css',
  'FinalRoundInterviewInterface.css',
  'InterviewInterface.css',
  'AdminAssignedInterviews.css',
  'CandidateApplications.css',
  'CandidateEvents.css',
  'CandidateList.css',
  'ClientLayout.css',
];

const INTERVIEW_JSX_FILES = [
  'InterviewInterface.jsx',
  'FinalRoundInterviewInterface.jsx',
  'MemberInterviewInterface.jsx',
];

const COLOR_VALUE_RE = /(?:#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\bwhite\b|\bblack\b)/g;

function stripVars(source) {
  return source.replace(/var\([^)]*\)/g, '');
}

function findRawColors(source, exclude = []) {
  const cleaned = stripVars(source);
  const matches = [];
  let m;
  while ((m = COLOR_VALUE_RE.exec(cleaned)) !== null) {
    const val = m[0];
    if (!exclude.includes(val.toLowerCase())) {
      matches.push(val);
    }
  }
  return matches;
}

describe('route CSS uses semantic tokens', () => {
  const cssModules = import.meta.glob('../styles/*.css', { eager: true, query: '?raw', import: 'default' });

  for (const file of ROUTE_CSS_FILES) {
    it(`${file} contains no hardcoded color values`, () => {
      const key = Object.keys(cssModules).find((k) => k.endsWith(`/${file}`));
      expect(key, `could not load ${file}`).toBeTruthy();
      const raw = cssModules[key];
      const offenders = findRawColors(raw).filter(
        (c) => !['white', 'black'].includes(c) // these are valid CSS keywords but still hard-coded
      );
      expect(offenders).toEqual([]);
    });
  }
});

describe('interview/grading inline colors were replaced', () => {
  const jsxModules = import.meta.glob('../pages/*.jsx', { eager: true, query: '?raw', import: 'default' });

  const checkNo = (filename, needle) => {
    it(`${filename} no longer contains ${needle}`, () => {
      const key = Object.keys(jsxModules).find((k) => k.endsWith(`/${filename}`));
      expect(key, `could not load ${filename}`).toBeTruthy();
      expect(jsxModules[key]).not.toContain(needle);
    });
  };

  for (const file of INTERVIEW_JSX_FILES) {
    checkNo(file, '#1e40af');
    checkNo(file, '#eff6ff');
    checkNo(file, '#2563eb');
  }

  checkNo('Staging.jsx', '#042742');
  checkNo('Staging.jsx', '#f5f5f5');
  checkNo('Staging.jsx', '#e0e0e0');
});
