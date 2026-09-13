import { describe, expect, it } from "vitest";
import { normalizeThreadStreamItem, threadStreamItemThreadId } from "@t3-vibe/adapter-t3";

function event(type: string, payload: unknown, sequence = 7) {
  return { kind: "event", event: { type, payload, sequence } };
}

describe("T3 event normalizer", () => {
  it("extracts an explicit owner so multiplexed events cannot cross thread routes", () => {
    expect(
      threadStreamItemThreadId({
        kind: "event",
        event: {
          aggregateId: "thread-from-aggregate",
          payload: { threadId: "thread-from-payload" },
        },
      }),
    ).toBe("thread-from-payload");
    expect(
      threadStreamItemThreadId({
        kind: "snapshot",
        snapshot: { thread: { id: "thread-from-snapshot" } },
      }),
    ).toBe("thread-from-snapshot");
    expect(threadStreamItemThreadId({ kind: "synchronized" })).toBeUndefined();
  });

  it("turns additive unknown events into unknown instead of throwing", () => {
    expect(normalizeThreadStreamItem(event("thread.future-event", { extra: true }))).toEqual([
      { type: "unknown", rawType: "thread.future-event", sequence: 7 },
    ]);
  });

  it("exposes synchronization boundaries for durable subscribers", () => {
    expect(normalizeThreadStreamItem({ kind: "synchronized" })).toEqual([
      { type: "subscription.synchronized" },
    ]);
  });

  it("normalizes assistant deltas", () => {
    expect(
      normalizeThreadStreamItem(
        event("thread.message-sent", {
          role: "assistant",
          messageId: "message-1",
          text: "hello",
          streaming: true,
        }),
      ),
    ).toEqual([{ type: "assistant.delta", messageId: "message-1", text: "hello", sequence: 7 }]);
  });

  it("keeps only upstream-supplied recognized approval decisions", () => {
    const [result] = normalizeThreadStreamItem(
      event("thread.activity-appended", {
        activity: {
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-1",
            requestKind: "command",
            detail: "npm install",
            options: [
              { decision: "accept", label: "Allow once", addedLater: true },
              { decision: "future-auto-allow", label: "Unsafe future option" },
              { decision: "decline", label: "Deny" },
            ],
          },
        },
      }),
    );
    expect(result).toMatchObject({
      type: "approval.requested",
      request: {
        requestId: "approval-1",
        options: [
          { decision: "accept", label: "Allow once" },
          { decision: "decline", label: "Deny" },
        ],
      },
    });
  });

  it("normalizes structured AI questions without treating them as approvals", () => {
    expect(
      normalizeThreadStreamItem(
        event("thread.activity-appended", {
          activity: {
            kind: "user-input.requested",
            payload: {
              requestId: "question-request-1",
              questions: [
                {
                  id: "mode",
                  header: "Execution",
                  question: "Which mode should be used?",
                  multiSelect: false,
                  allowCustomAnswer: true,
                  options: [
                    { value: "safe", label: "Safe", description: "Use sandboxing" },
                    { value: "fast", label: "Fast" },
                  ],
                },
              ],
            },
          },
        }),
      ),
    ).toEqual([
      {
        type: "user-input.requested",
        request: {
          requestId: "question-request-1",
          questions: [
            {
              id: "mode",
              header: "Execution",
              question: "Which mode should be used?",
              multiSelect: false,
              allowCustomAnswer: true,
              options: [
                { value: "safe", label: "Safe", description: "Use sandboxing" },
                { value: "fast", label: "Fast" },
              ],
            },
          ],
        },
        sequence: 7,
      },
    ]);
  });

  it("exposes the checkpoint before a final answer as a rendering boundary", () => {
    expect(
      normalizeThreadStreamItem(
        event("thread.activity-appended", {
          activity: { kind: "checkpoint.captured", payload: { status: "ready" } },
        }),
      ),
    ).toEqual([{ type: "response.finalizing", sequence: 7 }]);
  });

  it("reconciles the latest turn from a fallback snapshot", () => {
    expect(
      normalizeThreadStreamItem({
        kind: "snapshot",
        snapshot: {
          snapshotSequence: 19,
          thread: {
            latestTurn: { turnId: "turn-1", state: "completed" },
            messages: [
              {
                id: "assistant-1",
                role: "assistant",
                turnId: "turn-1",
                text: "recovered answer",
              },
            ],
            activities: [
              {
                kind: "approval.requested",
                turnId: "turn-1",
                summary: "Command approval requested",
                payload: {
                  requestId: "request-resolved",
                  requestKind: "command",
                  options: [{ decision: "decline", label: "Deny" }],
                },
              },
              {
                kind: "approval.resolved",
                turnId: "turn-1",
                payload: { requestId: "request-resolved" },
              },
            ],
            checkpoints: [
              {
                turnId: "turn-1",
                files: [{ path: "src/app.ts", kind: "modified", additions: 3, deletions: 1 }],
              },
            ],
          },
        },
      }),
    ).toEqual([
      {
        type: "assistant.message",
        messageId: "assistant-1",
        text: "recovered answer",
        snapshotSequence: 19,
      },
      {
        type: "files.changed",
        files: [{ path: "src/app.ts", kind: "modified", additions: 3, deletions: 1 }],
        snapshotSequence: 19,
      },
      {
        type: "turn.completed",
        status: "success",
        turnId: "turn-1",
        snapshotSequence: 19,
      },
    ]);
  });
});
