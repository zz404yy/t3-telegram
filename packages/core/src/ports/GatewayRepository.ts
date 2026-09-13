import type {
  ApprovalOption,
  BindingRecord,
  EnvironmentRecord,
  PendingApprovalRecord,
  PendingUserInputRecord,
  UserInputRequest,
  ThreadSubscriptionState,
} from "../domain/types.js";

export type BotLocale = "zh" | "en";

export interface SaveEnvironmentInput {
  userId: string;
  name: string;
  baseUrl: string;
  credential?: string;
  credentialType?: string;
  credentialExpiresAt?: string;
  serverVersion?: string;
  protocolFingerprint?: string;
  status: EnvironmentRecord["status"];
}

export interface SaveBindingInput {
  userId: string;
  telegramChatId: string;
  telegramThreadId?: string;
  environmentId: string;
  t3ProjectId?: string;
  t3ThreadId: string;
  displayName?: string;
}

export interface GatewayRepository {
  initialize(): void;
  ensureUser(telegramUserId: string): string;
  findUserId(telegramUserId: string): string | undefined;
  getUserLocale(userId: string): BotLocale | undefined;
  setUserLocale(userId: string, locale: BotLocale): void;
  getTelegramControlTopic(chatId: string): string | undefined;
  saveTelegramControlTopic(chatId: string, threadId: string): void;
  saveEnvironment(input: SaveEnvironmentInput): EnvironmentRecord;
  updateEnvironment(environment: EnvironmentRecord): void;
  getEnvironment(id: string): EnvironmentRecord | undefined;
  listEnvironments(userId: string): EnvironmentRecord[];
  saveBinding(input: SaveBindingInput): BindingRecord;
  listBindings(userId?: string): BindingRecord[];
  listBindingsForThread(environmentId: string, t3ThreadId: string): BindingRecord[];
  findBindingForTarget(
    userId: string,
    chatId: string,
    environmentId: string,
    t3ThreadId: string,
  ): BindingRecord | undefined;
  setActiveBinding(userId: string, chatId: string, bindingId: string): boolean;
  resolveBinding(userId: string, chatId: string, threadId?: string): BindingRecord | undefined;
  findBinding(id: string): BindingRecord | undefined;
  removeBinding(userId: string, chatId: string, threadId?: string): boolean;
  removeBindingById(userId: string, chatId: string, bindingId: string): boolean;
  savePendingApproval(input: {
    bindingId: string;
    t3RequestId: string;
    telegramMessageId?: string;
    options: ApprovalOption[];
    expiresAt?: string;
  }): PendingApprovalRecord;
  findPendingApproval(id: string): PendingApprovalRecord | undefined;
  claimPendingApproval(id: string): boolean;
  releasePendingApproval(id: string): void;
  resolvePendingApproval(id: string): void;
  savePendingUserInput(input: {
    bindingId: string;
    t3RequestId: string;
    request: UserInputRequest;
    telegramMessageId?: string;
    answers?: Record<string, string | string[]>;
    questionIndex?: number;
    awaitingCustomAnswer?: boolean;
  }): PendingUserInputRecord;
  findPendingUserInput(id: string): PendingUserInputRecord | undefined;
  findPendingUserInputForBinding(bindingId: string): PendingUserInputRecord | undefined;
  findPendingUserInputByRequest(
    bindingId: string,
    t3RequestId: string,
  ): PendingUserInputRecord | undefined;
  claimPendingUserInput(id: string): boolean;
  releasePendingUserInput(id: string): void;
  resolvePendingUserInput(id: string): void;
  hasProcessedUpdate(updateId: number): boolean;
  markUpdateProcessed(updateId: number): void;
  claimTurnStart(deduplicationKey: string): boolean;
  getThreadSubscriptionState(
    environmentId: string,
    t3ThreadId: string,
  ): ThreadSubscriptionState | undefined;
  saveThreadSubscriptionState(input: {
    environmentId: string;
    t3ThreadId: string;
    lastSequence?: number;
    lastCompletedTurnId?: string;
  }): ThreadSubscriptionState;
}
