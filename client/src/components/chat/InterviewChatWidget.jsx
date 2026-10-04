import React, { useCallback } from 'react';
import apiClient from '../../utils/api';
import ChatWidget from './ChatWidget';
import CoffeeChatThreads from './CoffeeChatThreads';

export default function InterviewChatWidget({ interviewId, interviewTitle, interviewType }) {
  const resolve = useCallback(async () => {
    if (!interviewId) return null;
    return apiClient.get(`/conversations/interviews/${interviewId}`);
  }, [interviewId]);

  // Waits for the interview to load: which chat it gets depends on its type.
  if (!interviewId || !interviewType) return null;

  // A coffee chat is too many interviewers for one room; they message who they pick.
  if (interviewType === 'COFFEE_CHAT') return <CoffeeChatThreads interviewId={interviewId} />;

  return (
    <ChatWidget
      resolve={resolve}
      title="Interview chat"
      subtitle={interviewTitle || 'Talk to other interviewers'}
    />
  );
}
