import { createHash } from "node:crypto";

export const T3_PROTOCOL_PROFILE_0040 = {
  revision: "efccda9ac9230db22b36990cffabdad218fa41b0",
  methods: [
    "orchestration.dispatchCommand",
    "orchestration.getTurnDiff",
    "orchestration.getFullThreadDiff",
    "orchestration.searchThreads",
    "orchestration.getArchivedShellSnapshot",
    "orchestration.subscribeThread",
  ],
  commands: [
    "project.create",
    "thread.create",
    "thread.meta.update",
    "thread.archive",
    "thread.turn.start",
    "thread.turn.interrupt",
    "thread.approval.respond",
  ],
  framing: ["Request", "Chunk", "Ack", "Interrupt", "Exit", "Ping", "Pong", "Defect"],
  auth: {
    token: "/oauth/token",
    ticket: "/api/auth/websocket-ticket",
    socket: "/ws",
  },
} as const;

export const T3_PROTOCOL_FINGERPRINT = `sha256:${createHash("sha256")
  .update(JSON.stringify(T3_PROTOCOL_PROFILE_0040))
  .digest("hex")}`;
