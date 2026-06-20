import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INBOX_ITEM_ADDED_TOPIC,
  INBOX_ITEM_RESOLVED_TOPIC,
  RUN_COST_RECORDED_TOPIC,
  RUN_EVENT_APPENDED_TOPIC,
  RUN_PROGRESS_UPDATED_TOPIC,
  RUN_UPDATED_TOPIC,
} from './constants.js';
import { InboxSubscriptionResolver } from '../inbox/inbox-subscription.resolver.js';
import { RunsSubscriptionResolver } from '../runs/runs-subscription.resolver.js';

test('subscription resolvers expose subscribeTo* methods backed by PubSub topics', () => {
  const topics: string[] = [];
  const pubSub = {
    asyncIterableIterator(topic: string) {
      topics.push(topic);
      return topic;
    },
  };

  const runs = new RunsSubscriptionResolver(pubSub as never);
  const inbox = new InboxSubscriptionResolver(pubSub as never);
  assert.equal(runs.subscribeToRunUpdated({ runId: 'run_1' }) as never, RUN_UPDATED_TOPIC);
  assert.equal(runs.subscribeToRunEventAppended({ runId: 'run_1' }) as never, RUN_EVENT_APPENDED_TOPIC);
  assert.equal(runs.subscribeToRunProgressUpdated({ runId: 'run_1' }) as never, RUN_PROGRESS_UPDATED_TOPIC);
  assert.equal(runs.subscribeToRunCostRecorded({ runId: 'run_1' }) as never, RUN_COST_RECORDED_TOPIC);
  assert.equal(inbox.subscribeToInboxItemAdded({ runId: 'run_1' }) as never, INBOX_ITEM_ADDED_TOPIC);
  assert.equal(inbox.subscribeToInboxItemResolved({ runId: 'run_1' }) as never, INBOX_ITEM_RESOLVED_TOPIC);

  assert.deepEqual(topics, [
    RUN_UPDATED_TOPIC,
    RUN_EVENT_APPENDED_TOPIC,
    RUN_PROGRESS_UPDATED_TOPIC,
    RUN_COST_RECORDED_TOPIC,
    INBOX_ITEM_ADDED_TOPIC,
    INBOX_ITEM_RESOLVED_TOPIC,
  ]);
});
