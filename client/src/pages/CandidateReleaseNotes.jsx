import React from 'react';
import ReleaseNotesView from '../components/ReleaseNotesView';

export default function CandidateReleaseNotes() {
  return (
    <ReleaseNotesView
      apiPath="/candidate/release-notes"
      storageKey="releaseNotesReadCandidate"
      title="What's new"
      subtitle="Release notes and updates for candidates"
      allowedRoles={['USER']}
    />
  );
}
