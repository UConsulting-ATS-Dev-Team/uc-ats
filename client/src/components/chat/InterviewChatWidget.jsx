import React, { useCallback } from 'react';
import apiClient from '../../utils/api';
import ChatWidget from './ChatWidget';

export default function InterviewChatWidget({ interviewId, interviewTitle }) {
  const resolve = useCallback(async () => {
    if (!interviewId) return null;
    return apiClient.get(`/conversations/interviews/${interviewId}`);
  }, [interviewId]);

  if (!interviewId) return null;

  return (
    <ChatWidget
      resolve={resolve}
      title="Interview chat"
      subtitle={interviewTitle || 'Talk to other interviewers'}
    />
  );
}
