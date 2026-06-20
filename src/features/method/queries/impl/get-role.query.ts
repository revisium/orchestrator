export type GetRoleQueryData = {
  roleId: string;
};

export class GetRoleQuery {
  constructor(readonly data: GetRoleQueryData) {}
}
