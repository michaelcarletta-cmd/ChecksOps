/** Owner policy: any member of the check's tenant may move its checks. Role
 *  titles (tenant or platform user_roles admin/staff) are ignored; partners,
 *  other tenants and global admins without that membership may not.
 */
export function canMoveTenantChecks({ isTenantMember } = {}) {
  return isTenantMember === true;
}
