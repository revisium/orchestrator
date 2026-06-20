export type GetInboxItemQueryData = {
  inboxId: string;
};

export class GetInboxItemQuery {
  constructor(readonly data: GetInboxItemQueryData) {}
}
