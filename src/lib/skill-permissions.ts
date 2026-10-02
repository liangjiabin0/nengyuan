export type SkillPermissionUser = {
  id?: string | null;
  role?: string | null;
} | null | undefined;

export type SkillPermissionTarget = {
  source?: string | null;
  uploadedBy?: string | null;
};

export function isSharedSkillOwner(
  skill: Pick<SkillPermissionTarget, 'uploadedBy'>,
  userId?: string | null
) {
  return Boolean(userId) && String(skill.uploadedBy || '') === String(userId);
}

function isAdminRole(user: SkillPermissionUser) {
  return user?.role === 'admin';
}

/** 管理员可删系统技能和任意用户技能；普通用户只能删自己上传的技能。 */
export function canDeleteSharedSkill(
  skill: SkillPermissionTarget,
  user?: SkillPermissionUser
) {
  if (!user?.id) return false;
  if (isAdminRole(user)) return true;
  if (skill.source === 'system') return false;
  return isSharedSkillOwner(skill, user.id);
}

/** 能删除即可编辑：管理员可改系统技能和任意用户技能，普通用户只能改自己的。 */
export function canEditSharedSkill(
  skill: SkillPermissionTarget,
  user?: SkillPermissionUser
) {
  return canDeleteSharedSkill(skill, user);
}

export function skillDeleteDeniedReason(
  skill: SkillPermissionTarget,
  user?: SkillPermissionUser
) {
  if (canDeleteSharedSkill(skill, user)) return null;
  if (skill.source === 'system') return '系统技能只能由管理员删除';
  return '只能删除自己上传的技能';
}

export function skillEditDeniedReason(
  skill: SkillPermissionTarget,
  user?: SkillPermissionUser
) {
  if (canEditSharedSkill(skill, user)) return null;
  if (skill.source === 'system') return '系统技能只能由管理员修改';
  return '只能修改自己上传的技能';
}
