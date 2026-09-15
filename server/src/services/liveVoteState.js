import { isOwnedBy } from '../utils/applicationOwnership.js';
import { phaseLabel, roundForPhase } from './stagingDecisions.js';

// What a live vote looks like to one viewer. Everything the API says about a
// session goes through buildState, which is pure so its promises can be tested
// without a database:
//
// - an open ballot has no yes/no counts at all - not zeroed, absent - so a
//   curious member reading the network tab learns only how many have voted;
// - nothing about a vote ever carries a voter: votes are stored as HMAC keys,
//   and the only thing derived from a key is the viewer's own "myVote";
// - the Staging decision is admin information and is left out for members.

/** A participant is present when their page has polled within this window. */
export const PRESENCE_WINDOW_MS = 30_000;

const isPresent = (participant, now) =>
  !participant.leftAt && now - new Date(participant.lastSeenAt).getTime() <= PRESENCE_WINDOW_MS;

export const presentParticipants = (participants, now) =>
  participants.filter((participant) => isPresent(participant, now));

const fullName = (application) =>
  [application?.firstName, application?.lastName].filter(Boolean).join(' ').trim();

/**
 * How many people could vote on this ballot: everyone present who is not the
 * candidate, plus anyone who has already voted and since dropped off. The union
 * is what keeps "X of Y have voted" from ever showing X above Y.
 */
export function computeEligible({ present, votes, ballotId, application, keyFor }) {
  const keys = new Set(votes.map((vote) => vote.voterKey));
  for (const participant of present) {
    if (application && isOwnedBy(application, participant.user)) continue;
    keys.add(keyFor(ballotId, participant.userId));
  }
  return keys.size;
}

export function splitPercent(yes, no) {
  const total = yes + no;
  if (!total) return { yesPct: 0, noPct: 0 };
  const yesPct = Math.round((yes * 100) / total);
  return { yesPct, noPct: 100 - yesPct };
}

const closedSummary = (ballot, isAdmin) => ({
  id: ballot.id,
  roundNumber: ballot.roundNumber,
  closedAt: ballot.closedAt,
  yesCount: ballot.yesCount ?? 0,
  noCount: ballot.noCount ?? 0,
  eligibleCount: ballot.eligibleCount ?? 0,
  ...splitPercent(ballot.yesCount ?? 0, ballot.noCount ?? 0),
  ...(isAdmin ? { decisionApplied: ballot.decisionApplied ?? null } : {})
});

/**
 * @param raw {
 *   session, candidates (ordered by position, each with `application`),
 *   participants (each with `user`), ballots, openVotes, sealedApplicationIds (Set)
 * }
 * @param viewer { user, keyFor(ballotId, userId) }
 */
export function buildState(raw, { user, keyFor }, now = Date.now()) {
  const { session, candidates, participants, ballots, openVotes, sealedApplicationIds } = raw;
  const isAdmin = user.role === 'ADMIN';
  const round = roundForPhase(session.phase);

  const mine = participants.find((participant) => participant.userId === user.id);
  const joined = Boolean(mine && !mine.leftAt);
  const present = presentParticipants(participants, now);

  const ballotsByCandidate = new Map();
  for (const ballot of [...ballots].sort((a, b) => a.roundNumber - b.roundNumber)) {
    const list = ballotsByCandidate.get(ballot.sessionCandidateId) || [];
    list.push(ballot);
    ballotsByCandidate.set(ballot.sessionCandidateId, list);
  }

  const card = (entry) => {
    const application = entry.application;
    const locked = sealedApplicationIds.has(application.id);
    return {
      name: fullName(application),
      headshotUrl: application.headshotUrl || null,
      major: locked ? null : application.major1 || null,
      graduationYear: locked ? null : application.graduationYear || null,
      resumeUrl: locked ? null : application.resumeUrl || null,
      locked
    };
  };

  const decisionOf = (application) => (round ? application[round.decisionField] || null : null);

  let current = null;
  if (session.status === 'ACTIVE' && session.currentIndex != null) {
    const entry = candidates.find((candidate) => candidate.position === session.currentIndex);
    if (entry) {
      const list = ballotsByCandidate.get(entry.id) || [];
      const latest = list[list.length - 1] || null;
      let ballot = null;

      if (latest?.status === 'OPEN') {
        const own = isOwnedBy(entry.application, user);
        const myKey = keyFor(latest.id, user.id);
        ballot = {
          id: latest.id,
          roundNumber: latest.roundNumber,
          status: 'OPEN',
          openedAt: latest.openedAt,
          votedCount: openVotes.length,
          eligibleCount: computeEligible({
            present,
            votes: openVotes,
            ballotId: latest.id,
            application: entry.application,
            keyFor
          }),
          myVote: openVotes.find((vote) => vote.voterKey === myKey)?.value ?? null,
          canVote: joined && !own,
          cannotVoteReason: own ? 'OWN_RECORD' : joined ? null : 'NOT_JOINED'
        };
      } else if (latest) {
        ballot = { ...closedSummary(latest, isAdmin), status: 'CLOSED' };
      }

      current = {
        sessionCandidateId: entry.id,
        position: entry.position,
        applicationId: entry.applicationId,
        candidate: card(entry),
        ...(isAdmin ? { decision: decisionOf(entry.application) } : {}),
        ballot,
        history: list
          .filter((item) => item.status === 'CLOSED' && item.id !== latest?.id)
          .map((item) => closedSummary(item, isAdmin))
      };
    }
  }

  const roster = candidates.map((entry) => {
    const list = ballotsByCandidate.get(entry.id) || [];
    const closed = list.filter((item) => item.status === 'CLOSED');
    const lastClosed = closed[closed.length - 1] || null;
    return {
      sessionCandidateId: entry.id,
      position: entry.position,
      name: fullName(entry.application),
      headshotUrl: entry.application.headshotUrl || null,
      hasOpenBallot: list.some((item) => item.status === 'OPEN'),
      rounds: closed.length,
      latest: lastClosed
        ? { yesCount: lastClosed.yesCount ?? 0, noCount: lastClosed.noCount ?? 0 }
        : null,
      ...(isAdmin
        ? {
          decision: decisionOf(entry.application),
          decisionApplied: [...closed].reverse().find((item) => item.decisionApplied)?.decisionApplied ?? null
        }
        : {})
    };
  });

  return {
    version: session.version,
    serverTime: new Date(now).toISOString(),
    session: {
      id: session.id,
      phase: session.phase,
      phaseLabel: phaseLabel(session.phase),
      status: session.status,
      currentIndex: session.currentIndex,
      candidateCount: candidates.length,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      createdBy: session.createdBy ? { id: session.createdBy.id, fullName: session.createdBy.fullName } : null
    },
    rubric: Array.isArray(session.rubric) ? session.rubric : [],
    me: {
      userId: user.id,
      isAdmin,
      joined,
      isHost: isAdmin && joined && session.status !== 'ENDED'
    },
    participants: {
      presentCount: present.length,
      people: present
        .map((participant) => ({ id: participant.userId, fullName: participant.user?.fullName || 'Member' }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName))
    },
    current,
    roster
  };
}
