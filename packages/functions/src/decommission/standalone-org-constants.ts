/** Step Functions input uses this `projectId` when decommissioning an org account outside any factory project. */
export const STANDALONE_ORG_DECOMMISSION_PROJECT_ID = '__STANDALONE_ORG__';

export function isStandaloneOrgDecommission(projectId: string | undefined | null): boolean {
  return projectId === STANDALONE_ORG_DECOMMISSION_PROJECT_ID;
}
