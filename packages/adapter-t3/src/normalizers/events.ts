import type { ApprovalOption, ThreadEvent } from "@t3-vibe/core";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Extract the owning thread when T3 includes it in a subscription item. Some upstream
 * versions multiplex event traffic more broadly than requested, so callers must not assume
 * that every item received on a subscribeThread stream belongs to the requested thread.
 */
export function threadStreamItemThreadId(raw: unknown): string | undefined {
  const item = object(raw);
  if (!item) return undefined;
  if (item.kind === "snapshot") {
    const thread = object(object(item.snapshot)?.thread);
    return string(thread?.id) ?? string(thread?.threadId);
  }
  if (item.kind !== "event") return undefined;
  const event = object(item.event);
  const payload = object(event?.payload);
  return string(payload?.threadId) ?? string(event?.aggregateId);
}

function changedFiles(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const file = object(entry);
        const path = string(file?.path);
        if (!path) return [];
        return [
          {
            path,
            additions: number(file?.additions) ?? 0,
            deletions: number(file?.deletions) ?? 0,
            ...(string(file?.kind) ? { kind: string(file?.kind)! } : {}),
          },
        ];
      })
    : [];
}

const decisions = new Set(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]);

function approvalOptions(value: unknown): ApprovalOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = object(entry);
    const decision = string(item?.decision);
    const label = string(item?.label);
    if (!decision || !label || !decisions.has(decision)) return [];
    return [
      {
        decision: decision as ApprovalOption["decision"],
        label,
        ...(string(item?.warning) ? { warning: string(item?.warning)! } : {}),
      },
    ];
  });
}

function normalizeActivity(activity: Record<string, unknown>, sequence?: number): ThreadEvent {
  const kind = string(activity.kind) ?? "unknown";
  const payload = object(activity.payload) ?? {};
  const title = string(activity.summary) ?? kind;
  if (kind === "approval.requested") {
    const requestId = string(payload.requestId);
    if (!requestId)
      return { type: "unknown", rawType: kind, ...(sequence === undefined ? {} : { sequence }) };
    const requestKind = string(payload.requestKind);
    const normalizedKind = ["command", "file-read", "file-change", "mcp-elicitation"].includes(
      requestKind ?? "",
    )
      ? (requestKind as "command" | "file-read" | "file-change" | "mcp-elicitation")
      : "unknown";
    return {
      type: "approval.requested",
      request: {
        requestId,
        kind: normalizedKind,
        title,
        options: approvalOptions(payload.options),
        ...(string(payload.detail) ? { detail: string(payload.detail)! } : {}),
        ...(string(payload.appName) ? { appName: string(payload.appName)! } : {}),
      },
      ...(sequence === undefined ? {} : { sequence }),
    };
  }
  if (kind === "runtime.warning") {
    return {
      type: "warning",
      message: string(payload.message) ?? title,
      ...(sequence === undefined ? {} : { sequence }),
    };
  }
  if (kind === "item.started" || kind === "tool.started") {
    return {
      type: "tool.started",
      label: string(payload.title) ?? string(payload.toolName) ?? title,
      ...(string(payload.detail) ? { detail: string(payload.detail)! } : {}),
      ...(sequence === undefined ? {} : { sequence }),
    };
  }
  if (["item.completed", "item.failed", "tool.completed", "tool.denied"].includes(kind)) {
    return {
      type: "tool.finished",
      label: string(payload.title) ?? string(payload.toolName) ?? title,
      ok: !kind.includes("failed") && kind !== "tool.denied",
      ...(string(payload.detail) ? { detail: string(payload.detail)! } : {}),
      ...(sequence === undefined ? {} : { sequence }),
    };
  }
  const typedUsage = object(payload.typedUsage);
  if (typedUsage) {
    return {
      type: "usage.updated",
      ...(number(typedUsage.inputTokens) === undefined
        ? {}
        : { inputTokens: number(typedUsage.inputTokens)! }),
      ...(number(typedUsage.outputTokens) === undefined
        ? {}
        : { outputTokens: number(typedUsage.outputTokens)! }),
      ...(sequence === undefined ? {} : { sequence }),
    };
  }
  return {
    type: "activity",
    title,
    ...(string(payload.detail) ? { detail: string(payload.detail)! } : {}),
    ...(sequence === undefined ? {} : { sequence }),
  };
}

function normalizeSnapshot(item: Record<string, unknown>): ThreadEvent[] {
  const snapshot = object(item.snapshot);
  const snapshotSequence = number(snapshot?.snapshotSequence);
  const thread = object(snapshot?.thread);
  const latestTurn = object(thread?.latestTurn);
  const turnId = string(latestTurn?.turnId);
  if (!thread || !turnId) return [];

  const events: ThreadEvent[] = [];
  for (const entry of Array.isArray(thread.messages) ? thread.messages : []) {
    const message = object(entry);
    if (message?.role !== "assistant" || string(message.turnId) !== turnId) continue;
    const text = string(message.text);
    if (!text) continue;
    events.push({
      type: "assistant.message",
      text,
      ...(string(message.id) ? { messageId: string(message.id)! } : {}),
    });
  }

  const approvals = new Map<string, Record<string, unknown>>();
  for (const entry of Array.isArray(thread.activities) ? thread.activities : []) {
    const activity = object(entry);
    if (!activity || string(activity.turnId) !== turnId) continue;
    const payload = object(activity.payload);
    const requestId = string(payload?.requestId);
    if (!requestId) continue;
    if (activity.kind === "approval.requested") approvals.set(requestId, activity);
    if (activity.kind === "approval.resolved") approvals.delete(requestId);
  }
  for (const activity of approvals.values()) events.push(normalizeActivity(activity));

  const checkpoint = (Array.isArray(thread.checkpoints) ? thread.checkpoints : [])
    .map(object)
    .find((entry) => string(entry?.turnId) === turnId);
  if (checkpoint) events.push({ type: "files.changed", files: changedFiles(checkpoint.files) });

  const state = string(latestTurn?.state);
  if (state === "completed") events.push({ type: "turn.completed", status: "success", turnId });
  if (state === "interrupted") events.push({ type: "turn.completed", status: "cancelled", turnId });
  if (state === "error") events.push({ type: "turn.completed", status: "failed", turnId });
  return events.map((event) => ({
    ...event,
    ...(snapshotSequence === undefined ? {} : { snapshotSequence }),
  }));
}

export function normalizeThreadStreamItem(raw: unknown): ThreadEvent[] {
  const item = object(raw);
  if (!item) return [{ type: "unknown" }];
  if (item.kind === "synchronized") return [{ type: "subscription.synchronized" }];
  if (item.kind === "snapshot") return normalizeSnapshot(item);
  if (item.kind !== "event") {
    const rawType = string(item.kind);
    return [{ type: "unknown", ...(rawType ? { rawType } : {}) }];
  }
  const event = object(item.event);
  if (!event) return [{ type: "unknown" }];
  const eventType = string(event.type);
  const payload = object(event.payload) ?? {};
  const sequence = number(event.sequence);
  const withSequence = sequence === undefined ? {} : { sequence };
  switch (eventType) {
    case "thread.turn-start-requested":
      return [
        {
          type: "turn.started",
          threadId: string(payload.threadId) ?? string(event.aggregateId) ?? "",
          ...withSequence,
        },
      ];
    case "thread.message-sent": {
      if (payload.role !== "assistant") return [];
      const base = {
        text: string(payload.text) ?? "",
        ...(string(payload.messageId) ? { messageId: string(payload.messageId)! } : {}),
        ...withSequence,
      };
      return [
        payload.streaming === true
          ? { type: "assistant.delta", ...base }
          : { type: "assistant.message", ...base },
      ];
    }
    case "thread.session-set": {
      const session = object(payload.session);
      const status = string(session?.status);
      const turnId = string(session?.activeTurnId);
      if (status === "ready" || status === "stopped") {
        return [
          {
            type: "turn.completed",
            status: "success",
            ...(turnId ? { turnId } : {}),
            ...withSequence,
          },
        ];
      }
      if (status === "interrupted")
        return [{ type: "turn.completed", status: "cancelled", ...withSequence }];
      if (status === "error")
        return [{ type: "turn.completed", status: "failed", ...withSequence }];
      return [];
    }
    case "thread.turn-diff-completed": {
      return [{ type: "files.changed", files: changedFiles(payload.files), ...withSequence }];
    }
    case "thread.activity-appended": {
      const activity = object(payload.activity);
      return activity
        ? [normalizeActivity(activity, sequence)]
        : [{ type: "unknown", rawType: eventType, ...withSequence }];
    }
    default:
      return [{ type: "unknown", ...(eventType ? { rawType: eventType } : {}), ...withSequence }];
  }
}
