// Helpers for reading/writing review-team members across the legacy
// memberOne/memberTwo/memberThree columns and the new unbounded GroupMember join table.

export function getGroupMemberIds(group) {
  if (!group) return [];
  const legacy = [group.memberOne, group.memberTwo, group.memberThree].filter(Boolean);
  const additional = (group.groupMembers || [])
    .map(gm => gm?.userId)
    .filter(Boolean);
  return [...new Set([...legacy, ...additional])];
}

export function getGroupMemberUsers(group) {
  if (!group) return [];
  const legacyUsers = [group.memberOneUser, group.memberTwoUser, group.memberThreeUser].filter(Boolean);
  const additionalUsers = (group.groupMembers || [])
    .filter(gm => gm?.user)
    .map(gm => gm.user);
  const all = [...legacyUsers, ...additionalUsers];
  const seen = new Set();
  return all.filter(user => {
    if (!user?.id || seen.has(user.id)) return false;
    seen.add(user.id);
    return true;
  });
}

export function isGroupMember(group, userId) {
  return getGroupMemberIds(group).includes(userId);
}

export function getFirstEmptyLegacySlot(group) {
  if (group.memberOne == null) return 'memberOne';
  if (group.memberTwo == null) return 'memberTwo';
  if (group.memberThree == null) return 'memberThree';
  return null;
}

export function buildCreateGroupData(name, cycleId, memberIds) {
  const uniqueIds = [...new Set((memberIds || []).filter(Boolean))];
  const data = {
    name: name?.trim() || null,
    cycleId,
    memberOne: uniqueIds[0] || null,
    memberTwo: uniqueIds[1] || null,
    memberThree: uniqueIds[2] || null,
  };
  const additional = uniqueIds.slice(3);
  if (additional.length > 0) {
    data.groupMembers = {
      create: additional.map(userId => ({ userId })),
    };
  }
  return data;
}

export const groupMemberUserInclude = {
  memberOneUser: { select: { id: true, fullName: true, email: true } },
  memberTwoUser: { select: { id: true, fullName: true, email: true } },
  memberThreeUser: { select: { id: true, fullName: true, email: true } },
  groupMembers: {
    select: {
      userId: true,
      user: { select: { id: true, fullName: true, email: true } },
    },
  },
};
