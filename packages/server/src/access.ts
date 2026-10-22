// The ONE place that decides who may read, write or administer a skill. See docs/API.md "Permissions model".
import type { Permission, PrincipalType, Role, TeamRole, Visibility } from "@intra-skills/shared";

export interface Actor {
  id: number;
  handle: string;
  displayName: string;
  role: Role;
  /** team id -> role in that team */
  teams: Map<number, TeamRole>;
}

export interface GrantRef {
  principalType: PrincipalType;
  principalId: number;
  permission: Permission;
}

export interface SkillAcl {
  visibility: Visibility;
  teamId: number | null;
  createdBy: number;
  grants: GrantRef[];
}

function grantMatches(actor: Actor, g: GrantRef): boolean {
  return g.principalType === "user" ? g.principalId === actor.id : actor.teams.has(g.principalId);
}

function isOwnerTeamMember(actor: Actor, s: SkillAcl): boolean {
  return s.teamId !== null && actor.teams.has(s.teamId);
}

export function canRead(actor: Actor, s: SkillAcl): boolean {
  if (actor.role === "admin" || s.visibility === "org") return true;
  if (s.createdBy === actor.id || isOwnerTeamMember(actor, s)) return true;
  return s.grants.some((g) => grantMatches(actor, g));
}

export function canWrite(actor: Actor, s: SkillAcl): boolean {
  if (actor.role === "admin" || s.createdBy === actor.id || isOwnerTeamMember(actor, s)) return true;
  return s.grants.some((g) => g.permission === "write" && grantMatches(actor, g));
}

export function canAdmin(actor: Actor, s: SkillAcl): boolean {
  if (actor.role === "admin" || s.createdBy === actor.id) return true;
  return s.teamId !== null && actor.teams.get(s.teamId) === "maintainer";
}

/** Team-level administration: admins and maintainers of that team. */
export function canManageTeam(actor: Actor, teamId: number): boolean {
  return actor.role === "admin" || actor.teams.get(teamId) === "maintainer";
}
