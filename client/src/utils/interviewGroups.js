// Which application groups a member may pick in an interview's "which groups
// are you interviewing" picker, from GET /member/interviews/:id/config.
//
// The config is built from sessions where the interview has them and from the
// old Interview.description JSON where it does not, so it is the only source
// that works for both. Parsing description directly finds nothing for an
// interview candidates booked themselves into.
//
// A member sees the groups assigned to any member group that lists them.
export function groupsForMember(config, userId) {
  if (!config || userId == null) return [];
  const me = String(userId);
  const assignments = config.groupAssignments || {};
  const mine = (config.memberGroups || []).filter(
    (memberGroup) => Array.isArray(memberGroup.memberIds) && memberGroup.memberIds.some((id) => String(id) === me)
  );
  return (config.applicationGroups || []).filter((group) =>
    mine.some((memberGroup) => assignments[memberGroup.id]?.includes(group.id))
  );
}
