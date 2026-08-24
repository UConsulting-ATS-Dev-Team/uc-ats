import React from 'react';
import ReleaseNotesView from '../components/ReleaseNotesView';

export default function ReleaseNotes() {
  return (
    <ReleaseNotesView
      apiPath="/admin/release-notes"
      storageKey="releaseNotesRead"
      title="What's new"
      subtitle="Release notes and updates for the ATS"
      allowedRoles={['ADMIN']}
    />
  );
}
