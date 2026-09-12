import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  ApprovalOption,
  BindingRecord,
  EnvironmentRecord,
  GatewayRepository,
  PendingApprovalRecord,
  SaveBindingInput,
  SaveEnvironmentInput,
  ThreadSubscriptionState,
} from "@t3-vibe/core";
import { CredentialCipher } from "../crypto/CredentialCipher.js";
import { migrations } from "../migrations/schema.js";

type Row = Record<string, unknown>;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class SqliteGatewayRepository implements GatewayRepository {
  private readonly db: Database.Database;

  constructor(
    filename: string,
    private readonly cipher: CredentialCipher,
  ) {
    this.db = new Database(filename);
  }

  initialize(): void {
    for (const migration of migrations) this.db.exec(migration);
  }

  close(): void {
    this.db.close();
  }

  ensureUser(telegramUserId: string): string {
    const existing = this.db
      .prepare("SELECT id FROM users WHERE telegram_user_id = ?")
      .get(telegramUserId) as Row | undefined;
    if (existing) return String(existing.id);
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO users(id, telegram_user_id, created_at) VALUES (?, ?, ?)")
      .run(id, telegramUserId, new Date().toISOString());
    return id;
  }

  findUserId(telegramUserId: string): string | undefined {
    const row = this.db
      .prepare("SELECT id FROM users WHERE telegram_user_id = ?")
      .get(telegramUserId) as Row | undefined;
    return row ? String(row.id) : undefined;
  }

  getTelegramControlTopic(chatId: string): string | undefined {
    const row = this.db
      .prepare("SELECT telegram_thread_id FROM telegram_control_topics WHERE telegram_chat_id = ?")
      .get(chatId) as Row | undefined;
    return row ? String(row.telegram_thread_id) : undefined;
  }

  saveTelegramControlTopic(chatId: string, threadId: string): void {
    this.db
      .prepare(
        `INSERT INTO telegram_control_topics(telegram_chat_id, telegram_thread_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(telegram_chat_id) DO UPDATE SET
           telegram_thread_id = excluded.telegram_thread_id,
           updated_at = excluded.updated_at`,
      )
      .run(chatId, threadId, new Date().toISOString());
  }

  saveEnvironment(input: SaveEnvironmentInput): EnvironmentRecord {
    const current = this.db
      .prepare("SELECT * FROM environments WHERE user_id = ? AND base_url = ?")
      .get(input.userId, input.baseUrl) as Row | undefined;
    const id = current ? String(current.id) : randomUUID();
    const credential = input.credential
      ? this.cipher.encrypt(input.credential)
      : current?.encrypted_credential;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO environments(
          id, user_id, name, base_url, encrypted_credential, credential_type,
          credential_expires_at, server_version, protocol_fingerprint, status,
          last_seen_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, base_url) DO UPDATE SET
          name = excluded.name,
          encrypted_credential = COALESCE(excluded.encrypted_credential, environments.encrypted_credential),
          credential_type = COALESCE(excluded.credential_type, environments.credential_type),
          credential_expires_at = COALESCE(excluded.credential_expires_at, environments.credential_expires_at),
          server_version = COALESCE(excluded.server_version, environments.server_version),
          protocol_fingerprint = COALESCE(excluded.protocol_fingerprint, environments.protocol_fingerprint),
          status = excluded.status,
          last_seen_at = excluded.last_seen_at`,
      )
      .run(
        id,
        input.userId,
        input.name,
        input.baseUrl,
        credential ?? null,
        input.credentialType ?? null,
        input.credentialExpiresAt ?? null,
        input.serverVersion ?? null,
        input.protocolFingerprint ?? null,
        input.status,
        input.status === "connected" ? now : null,
        now,
      );
    const saved = this.getEnvironment(id);
    if (!saved) throw new Error("Environment insert failed");
    return saved;
  }

  updateEnvironment(environment: EnvironmentRecord): void {
    this.db
      .prepare(
        `UPDATE environments SET name = ?, base_url = ?,
          encrypted_credential = COALESCE(?, encrypted_credential), credential_type = ?,
          credential_expires_at = ?, server_version = ?, protocol_fingerprint = ?,
          status = ?, last_seen_at = ? WHERE id = ?`,
      )
      .run(
        environment.name,
        environment.baseUrl,
        environment.credential ? this.cipher.encrypt(environment.credential) : null,
        environment.credentialType ?? null,
        environment.credentialExpiresAt ?? null,
        environment.serverVersion ?? null,
        environment.protocolFingerprint ?? null,
        environment.status,
        environment.lastSeenAt ?? null,
        environment.id,
      );
  }

  getEnvironment(id: string): EnvironmentRecord | undefined {
    const row = this.db.prepare("SELECT * FROM environments WHERE id = ?").get(id) as
      Row | undefined;
    return row ? this.environmentFromRow(row) : undefined;
  }

  listEnvironments(userId: string): EnvironmentRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM environments WHERE user_id = ? ORDER BY created_at")
        .all(userId) as Row[]
    ).map((row) => this.environmentFromRow(row));
  }

  saveBinding(input: SaveBindingInput): BindingRecord {
    const now = new Date().toISOString();
    const existing = input.telegramThreadId
      ? ((this.db
          .prepare(
            `SELECT * FROM bindings WHERE user_id = ? AND telegram_chat_id = ?
             AND telegram_thread_id = ?`,
          )
          .get(input.userId, input.telegramChatId, input.telegramThreadId) ??
          this.db
            .prepare(
              `SELECT * FROM bindings WHERE user_id = ? AND telegram_chat_id = ?
               AND environment_id = ? AND t3_thread_id = ?`,
            )
            .get(input.userId, input.telegramChatId, input.environmentId, input.t3ThreadId)) as
          Row | undefined)
      : (this.db
          .prepare(
            `SELECT * FROM bindings WHERE user_id = ? AND telegram_chat_id = ?
             AND telegram_thread_id IS NULL AND environment_id = ? AND t3_thread_id = ?`,
          )
          .get(input.userId, input.telegramChatId, input.environmentId, input.t3ThreadId) as
          Row | undefined);
    const id = existing ? String(existing.id) : randomUUID();
    const save = this.db.transaction(() => {
      if (existing) {
        this.db
          .prepare(
            `UPDATE bindings SET user_id = ?, telegram_thread_id = ?, environment_id = ?,
             t3_project_id = ?, t3_thread_id = ?, display_name = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            input.userId,
            input.telegramThreadId ?? null,
            input.environmentId,
            input.t3ProjectId ?? null,
            input.t3ThreadId,
            input.displayName ?? null,
            now,
            id,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO bindings(id, user_id, telegram_chat_id, telegram_thread_id,
             environment_id, t3_project_id, t3_thread_id, display_name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.userId,
            input.telegramChatId,
            input.telegramThreadId ?? null,
            input.environmentId,
            input.t3ProjectId ?? null,
            input.t3ThreadId,
            input.displayName ?? null,
            now,
            now,
          );
      }
      if (!input.telegramThreadId) {
        this.db
          .prepare(
            `INSERT INTO active_chat_bindings(telegram_chat_id, binding_id) VALUES (?, ?)
             ON CONFLICT(telegram_chat_id) DO UPDATE SET binding_id = excluded.binding_id`,
          )
          .run(input.telegramChatId, id);
      } else {
        this.db.prepare("DELETE FROM active_chat_bindings WHERE binding_id = ?").run(id);
      }
    });
    save();
    const row = this.db.prepare("SELECT * FROM bindings WHERE id = ?").get(id) as Row;
    return this.bindingFromRow(row);
  }

  listBindings(userId?: string): BindingRecord[] {
    const rows = userId
      ? (this.db
          .prepare("SELECT * FROM bindings WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC")
          .all(userId) as Row[])
      : (this.db
          .prepare("SELECT * FROM bindings ORDER BY updated_at DESC, rowid DESC")
          .all() as Row[]);
    return rows.map((row) => this.bindingFromRow(row));
  }

  listBindingsForThread(environmentId: string, t3ThreadId: string): BindingRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM bindings WHERE environment_id = ? AND t3_thread_id = ?
           ORDER BY updated_at DESC`,
        )
        .all(environmentId, t3ThreadId) as Row[]
    ).map((row) => this.bindingFromRow(row));
  }

  findBindingForTarget(
    userId: string,
    chatId: string,
    environmentId: string,
    t3ThreadId: string,
  ): BindingRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM bindings WHERE user_id = ? AND telegram_chat_id = ?
         AND environment_id = ? AND t3_thread_id = ? ORDER BY created_at LIMIT 1`,
      )
      .get(userId, chatId, environmentId, t3ThreadId) as Row | undefined;
    return row ? this.bindingFromRow(row) : undefined;
  }

  setActiveBinding(userId: string, chatId: string, bindingId: string): boolean {
    const binding = this.db
      .prepare(`SELECT id FROM bindings WHERE id = ? AND user_id = ? AND telegram_chat_id = ?`)
      .get(bindingId, userId, chatId) as Row | undefined;
    if (!binding) return false;
    this.db
      .prepare(
        `INSERT INTO active_chat_bindings(telegram_chat_id, binding_id) VALUES (?, ?)
         ON CONFLICT(telegram_chat_id) DO UPDATE SET binding_id = excluded.binding_id`,
      )
      .run(chatId, bindingId);
    return true;
  }

  resolveBinding(userId: string, chatId: string, threadId?: string): BindingRecord | undefined {
    const row = threadId
      ? (this.db
          .prepare(
            `SELECT * FROM bindings WHERE user_id = ? AND telegram_chat_id = ?
             AND telegram_thread_id = ?`,
          )
          .get(userId, chatId, threadId) as Row | undefined)
      : (this.db
          .prepare(
            `SELECT b.* FROM active_chat_bindings a JOIN bindings b ON b.id = a.binding_id
             WHERE b.user_id = ? AND a.telegram_chat_id = ?`,
          )
          .get(userId, chatId) as Row | undefined);
    return row ? this.bindingFromRow(row) : undefined;
  }

  findBinding(id: string): BindingRecord | undefined {
    const row = this.db.prepare("SELECT * FROM bindings WHERE id = ?").get(id) as Row | undefined;
    return row ? this.bindingFromRow(row) : undefined;
  }

  removeBinding(userId: string, chatId: string, threadId?: string): boolean {
    const binding = this.resolveBinding(userId, chatId, threadId);
    if (!binding) return false;
    return this.removeResolvedBinding(binding.id);
  }

  removeBindingById(userId: string, chatId: string, bindingId: string): boolean {
    const binding = this.db
      .prepare("SELECT id FROM bindings WHERE id = ? AND user_id = ? AND telegram_chat_id = ?")
      .get(bindingId, userId, chatId) as Row | undefined;
    if (!binding) return false;
    return this.removeResolvedBinding(bindingId);
  }

  private removeResolvedBinding(bindingId: string): boolean {
    const remove = this.db.transaction(() => {
      this.db.prepare("DELETE FROM active_chat_bindings WHERE binding_id = ?").run(bindingId);
      this.db.prepare("DELETE FROM bindings WHERE id = ?").run(bindingId);
    });
    remove();
    return true;
  }

  savePendingApproval(input: {
    bindingId: string;
    t3RequestId: string;
    telegramMessageId?: string;
    options: ApprovalOption[];
    expiresAt?: string;
  }): PendingApprovalRecord {
    const existing = this.db
      .prepare("SELECT * FROM pending_approvals WHERE binding_id = ? AND t3_request_id = ?")
      .get(input.bindingId, input.t3RequestId) as Row | undefined;
    const id = existing ? String(existing.id) : randomUUID();
    this.db
      .prepare(
        `INSERT INTO pending_approvals(id, binding_id, t3_request_id, telegram_message_id,
         status, options_json, expires_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
         ON CONFLICT(binding_id, t3_request_id) DO UPDATE SET
           telegram_message_id = COALESCE(excluded.telegram_message_id, telegram_message_id),
           options_json = excluded.options_json`,
      )
      .run(
        id,
        input.bindingId,
        input.t3RequestId,
        input.telegramMessageId ?? null,
        JSON.stringify(input.options),
        input.expiresAt ?? null,
        new Date().toISOString(),
      );
    const saved = this.findPendingApproval(id);
    if (!saved) throw new Error("Pending approval insert failed");
    return saved;
  }

  findPendingApproval(id: string): PendingApprovalRecord | undefined {
    const row = this.db.prepare("SELECT * FROM pending_approvals WHERE id = ?").get(id) as
      Row | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      bindingId: String(row.binding_id),
      t3RequestId: String(row.t3_request_id),
      status: String(row.status) as PendingApprovalRecord["status"],
      options: JSON.parse(String(row.options_json)) as ApprovalOption[],
      createdAt: String(row.created_at),
      ...(optionalString(row.telegram_message_id)
        ? { telegramMessageId: optionalString(row.telegram_message_id)! }
        : {}),
      ...(optionalString(row.expires_at) ? { expiresAt: optionalString(row.expires_at)! } : {}),
    };
  }

  claimPendingApproval(id: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE pending_approvals SET status = 'processing' WHERE id = ? AND status = 'pending'",
        )
        .run(id).changes === 1
    );
  }

  releasePendingApproval(id: string): void {
    this.db
      .prepare(
        "UPDATE pending_approvals SET status = 'pending' WHERE id = ? AND status = 'processing'",
      )
      .run(id);
  }

  resolvePendingApproval(id: string): void {
    this.db.prepare("UPDATE pending_approvals SET status = 'resolved' WHERE id = ?").run(id);
  }

  hasProcessedUpdate(updateId: number): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM processed_telegram_updates WHERE update_id = ?").get(updateId),
    );
  }

  markUpdateProcessed(updateId: number): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO processed_telegram_updates(update_id, processed_at) VALUES (?, ?)",
      )
      .run(updateId, new Date().toISOString());
  }

  claimTurnStart(deduplicationKey: string): boolean {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO turn_deduplication(deduplication_key, created_at) VALUES (?, ?)",
        )
        .run(deduplicationKey, new Date().toISOString()).changes === 1
    );
  }

  getThreadSubscriptionState(
    environmentId: string,
    t3ThreadId: string,
  ): ThreadSubscriptionState | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM thread_subscription_state
         WHERE environment_id = ? AND t3_thread_id = ?`,
      )
      .get(environmentId, t3ThreadId) as Row | undefined;
    return row ? this.threadSubscriptionStateFromRow(row) : undefined;
  }

  saveThreadSubscriptionState(input: {
    environmentId: string;
    t3ThreadId: string;
    lastSequence?: number;
    lastCompletedTurnId?: string;
  }): ThreadSubscriptionState {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO thread_subscription_state(
           environment_id, t3_thread_id, last_sequence, last_completed_turn_id, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(environment_id, t3_thread_id) DO UPDATE SET
           last_sequence = COALESCE(excluded.last_sequence, thread_subscription_state.last_sequence),
           last_completed_turn_id = COALESCE(
             excluded.last_completed_turn_id,
             thread_subscription_state.last_completed_turn_id
           ),
           updated_at = excluded.updated_at`,
      )
      .run(
        input.environmentId,
        input.t3ThreadId,
        input.lastSequence ?? null,
        input.lastCompletedTurnId ?? null,
        now,
      );
    return this.getThreadSubscriptionState(input.environmentId, input.t3ThreadId)!;
  }

  private environmentFromRow(row: Row): EnvironmentRecord {
    const encrypted = row.encrypted_credential;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      name: String(row.name),
      baseUrl: String(row.base_url),
      status: String(row.status) as EnvironmentRecord["status"],
      ...(Buffer.isBuffer(encrypted) ? { credential: this.cipher.decrypt(encrypted) } : {}),
      ...(optionalString(row.credential_type)
        ? { credentialType: optionalString(row.credential_type)! }
        : {}),
      ...(optionalString(row.credential_expires_at)
        ? { credentialExpiresAt: optionalString(row.credential_expires_at)! }
        : {}),
      ...(optionalString(row.server_version)
        ? { serverVersion: optionalString(row.server_version)! }
        : {}),
      ...(optionalString(row.protocol_fingerprint)
        ? { protocolFingerprint: optionalString(row.protocol_fingerprint)! }
        : {}),
      ...(optionalString(row.last_seen_at)
        ? { lastSeenAt: optionalString(row.last_seen_at)! }
        : {}),
    };
  }

  private bindingFromRow(row: Row): BindingRecord {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      telegramChatId: String(row.telegram_chat_id),
      environmentId: String(row.environment_id),
      t3ThreadId: String(row.t3_thread_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(optionalString(row.telegram_thread_id)
        ? { telegramThreadId: optionalString(row.telegram_thread_id)! }
        : {}),
      ...(optionalString(row.t3_project_id)
        ? { t3ProjectId: optionalString(row.t3_project_id)! }
        : {}),
      ...(optionalString(row.display_name)
        ? { displayName: optionalString(row.display_name)! }
        : {}),
    };
  }

  private threadSubscriptionStateFromRow(row: Row): ThreadSubscriptionState {
    return {
      environmentId: String(row.environment_id),
      t3ThreadId: String(row.t3_thread_id),
      updatedAt: String(row.updated_at),
      ...(typeof row.last_sequence === "number" ? { lastSequence: row.last_sequence } : {}),
      ...(optionalString(row.last_completed_turn_id)
        ? { lastCompletedTurnId: optionalString(row.last_completed_turn_id)! }
        : {}),
    };
  }
}
