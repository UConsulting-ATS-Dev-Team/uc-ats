import React from 'react';
import ReleaseNotesView from '../components/ReleaseNotesView';

export default function MemberReleaseNotes() {
  return (
    <ReleaseNotesView
      apiPath="/member/release-notes"
      storageKey="releaseNotesReadMember"
      title="What's new"
      subtitle="Release notes and updates for members"
      allowedRoles={['MEMBER']}
    />
  );
}
