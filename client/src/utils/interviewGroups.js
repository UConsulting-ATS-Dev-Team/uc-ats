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

// Props for one row of a group picker. The row is the control: it takes the
// click and the keyboard, and the input inside it is only drawn. When the input
// handled clicks as well, a click on the box toggled the group twice.
export function groupRowProps({ selected, disabled, onToggle }) {
  const toggle = () => {
    if (!disabled) onToggle();
  };
  return {
    role: 'checkbox',
    'aria-checked': selected,
    'aria-disabled': disabled,
    tabIndex: disabled ? -1 : 0,
    onClick: toggle,
    onKeyDown: (event) => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        toggle();
      }
    }
  };
}
