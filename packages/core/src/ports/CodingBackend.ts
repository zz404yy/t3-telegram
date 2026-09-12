import type {
  ApprovalResponseInput,
  ArchiveThreadInput,
  BackendCapabilities,
  BackendConnectionStatus,
  BackendInfo,
  CreateThreadInput,
  CreateProjectInput,
  DiffSummary,
  GetThreadDiffInput,
  GetThreadHistoryInput,
  GetTurnDiffInput,
  InterruptTurnInput,
  ListThreadsInput,
  ModelProviderSummary,
  ProjectSummary,
  RenameThreadInput,
  StartTurnInput,
  StartTurnResult,
  SetProjectDefaultModelInput,
  SetThreadModelInput,
  SetThreadRuntimeModeInput,
  SubscribeThreadInput,
  ThreadEvent,
  ThreadHistoryMessage,
  ThreadSummary,
} from "../domain/types.js";

export interface CodingBackend {
  connect(environmentId: string): Promise<BackendConnectionStatus>;
  disconnect(environmentId: string): Promise<void>;
  getInfo(environmentId: string): Promise<BackendInfo>;
  getCapabilities(environmentId: string): Promise<BackendCapabilities>;
  listProjects(environmentId: string): Promise<ProjectSummary[]>;
  createProject(input: CreateProjectInput): Promise<ProjectSummary>;
  listModelProviders(environmentId: string): Promise<ModelProviderSummary[]>;
  setProjectDefaultModel(input: SetProjectDefaultModelInput): Promise<void>;
  setThreadModel(input: SetThreadModelInput): Promise<void>;
  setThreadRuntimeMode(input: SetThreadRuntimeModeInput): Promise<void>;
  listThreads(input: ListThreadsInput): Promise<ThreadSummary[]>;
  createThread(input: CreateThreadInput): Promise<ThreadSummary>;
  renameThread(input: RenameThreadInput): Promise<void>;
  archiveThread(input: ArchiveThreadInput): Promise<void>;
  startTurn(input: StartTurnInput): Promise<StartTurnResult>;
  interruptTurn(input: InterruptTurnInput): Promise<void>;
  subscribeThread(input: SubscribeThreadInput): AsyncIterable<ThreadEvent>;
  respondToApproval(input: ApprovalResponseInput): Promise<void>;
  getTurnDiff(input: GetTurnDiffInput): Promise<DiffSummary>;
  getThreadDiff(input: GetThreadDiffInput): Promise<DiffSummary>;
  getThreadHistory(input: GetThreadHistoryInput): Promise<ThreadHistoryMessage[]>;
}
