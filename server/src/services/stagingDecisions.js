import prisma from '../prismaClient.js';
import { ROUNDS } from '../utils/roundProgression.js';

// Writing a Staging round decision. The inline decision picker on Staging and
// the live vote both land here, so a decision set either way looks the same to
// decision processing and leaves the same audit comment.
//
// Only 'yes' and 'no' move anyone: decisionProcessing.js treats the maybes as
// undecided, which is what makes them safe to set mid-deliberation.

export const DECISION_VALUES = Object.freeze(['yes', 'maybe_yes', 'maybe_no', 'no']);

const DECISION_LABELS = {
  yes: 'Yes - Advanced',
  no: 'No - Not advanced',
  maybe_yes: 'Maybe - Yes (needs final decision)',
  maybe_no: 'Maybe - No (needs final decision)'
};

const PHASE_LABELS = {
  resume: 'Resume Review',
  coffee: 'Coffee Chat',
  firstRound: 'First Round',
  final: 'Final Round'
};

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

export const roundForPhase = (phase) => ROUNDS.find((entry) => entry.phase === phase) || null;

export const phaseLabel = (phase) => PHASE_LABELS[phase] || phase;

export const isDecisionValue = (value) => DECISION_VALUES.includes(value);

/**
 * Sets `phase`'s decision column on one application in `cycleId`. An empty
 * decision clears it. Pass a transaction as `client` to make it part of one.
 */
export async function saveRoundDecision({ client = prisma, applicationId, cycleId, phase, decision, userId }) {
  const round = roundForPhase(phase);
  if (!round) throw fail(400, `Unknown round: ${phase}`, 'INVALID_PHASE');

  const value = decision || null;
  if (value !== null && !isDecisionValue(value)) {
    throw fail(400, `Unknown decision: ${decision}`, 'INVALID_DECISION');
  }

  const application = await client.application.findFirst({
    where: { id: applicationId, cycleId },
    select: { id: true }
  });
  if (!application) throw fail(404, 'Application not found for this ID and cycle', 'NOT_FOUND');

  return client.application.update({
    where: { id: application.id },
    data: {
      [round.decisionField]: value,
      // Still read by round 1 processing and older screens.
      approved: value === 'yes' ? true : value === 'no' ? false : null,
      comments: {
        create: {
          content: `${phaseLabel(phase)} decision: ${DECISION_LABELS[value] || 'Cleared'}`,
          userId: userId || 'system'
        }
      }
    }
  });
}
