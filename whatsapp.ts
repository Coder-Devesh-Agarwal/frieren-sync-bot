import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
import QRCode from "qrcode";
import { RECONCILE_PAGE_SIZE } from "./constants";
import {
  getActiveMappings,
  listMappings,
  getMapping,
  getCursor,
  advanceCursor,
  incrementMsgCount,
  upsertGroups,
  getKV,
  setKV,
  resetWhatsAppData,
} from "./db";

export type WAState = "disconnected" | "qr_pending" | "connecting" | "ready";

export interface WAGroup {
  id: string;
  name: string;
  participantCount: number;
}

let client: InstanceType<typeof Client> | null = null;
let currentState: WAState = "disconnected";
let currentQR: string | null = null;
let cachedGroups: WAGroup[] = [];

// Track which messages we sent ourselves to avoid infinite loops in bidirectional sync
const sentByBot = new Set<string>();
const SENT_CACHE_TTL = 60_000;

// Secondary loop prevention: track recently forwarded content hashes per group pair
const recentForwards = new Map<string, number>();
const FORWARD_DEDUP_TTL = 5_000; // 5 second dedup window

// --- Reconciliation types and cache ---

export interface ReconcileMessage {
  id: string;
  timestamp: number;
  senderName: string;
  senderPhone: string;
  body: string;
  hasMedia: boolean;
  type: string;
}

const reconcileCache = new Map<
  string,
  {
    messages: ReconcileMessage[];
    fetchedAt: number;
    lastLimit: number;
  }
>();
const RECONCILE_CACHE_TTL = 5 * 60_000; // 5 minutes

// Account change detection
let pendingAccountReset = false;

export function getState(): WAState {
  return currentState;
}

export function getQRDataURL(): string | null {
  return currentQR;
}

export function getPendingAccountReset(): boolean {
  return pendingAccountReset;
}

export async function confirmAccountReset(): Promise<void> {
  resetWhatsAppData();
  if (client) {
    const wid = (client as any).info?.wid?._serialized;
    if (wid) setKV("whatsapp_wid", wid);
  }
  pendingAccountReset = false;
  cachedGroups = [];
  await refreshGroups();
}

export function dismissAccountReset(): void {
  // Keep existing data, just clear the flag
  if (client) {
    const wid = (client as any).info?.wid?._serialized;
    if (wid) setKV("whatsapp_wid", wid);
  }
  pendingAccountReset = false;
}

export function getGroups(): WAGroup[] {
  return cachedGroups;
}

let initializing = false;

const SESSION_DIR = ".wwebjs_auth/session";
const SINGLETON_LOCK = `${SESSION_DIR}/SingletonLock`;

async function killStaleBrowser(): Promise<void> {
  // Remove SingletonLock file
  try {
    const lock = Bun.file(SINGLETON_LOCK);
    if (await lock.exists()) {
      const { unlink } = await import("node:fs/promises");
      await unlink(SINGLETON_LOCK);
      console.log("[WhatsApp] Removed stale SingletonLock");
    }
  } catch {
    // Ignore
  }

  // Kill any lingering Chrome processes for our session dir
  try {
    const proc = Bun.spawn(
      ["pkill", "-f", `chromium.*wwebjs_auth|chrome.*wwebjs_auth`],
      {
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    await proc.exited;
  } catch {
    // pkill may not match anything, that's fine
  }

  // Give the OS a moment to release the lock
  await new Promise((r) => setTimeout(r, 1000));
}

function createClient(): InstanceType<typeof Client> {
  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: ".wwebjs_auth" }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
  });

  c.on("qr", async (qr: string) => {
    currentState = "qr_pending";
    try {
      currentQR = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
    } catch {
      currentQR = null;
    }
    console.log("[WhatsApp] QR code generated — scan with your phone");
  });

  c.on("authenticated", () => {
    currentState = "connecting";
    currentQR = null;
    console.log("[WhatsApp] Authenticated");
  });

  c.on("ready", async () => {
    currentState = "ready";
    currentQR = null;
    console.log("[WhatsApp] Client ready");
    await refreshGroups();

    // Detect WhatsApp account change
    const currentWid = (c as any).info?.wid?._serialized;
    if (currentWid) {
      const storedWid = getKV("whatsapp_wid");
      if (storedWid && storedWid !== currentWid) {
        pendingAccountReset = true;
        console.log(
          `[WhatsApp] Account change detected: ${storedWid} → ${currentWid}`,
        );
      } else if (!storedWid) {
        setKV("whatsapp_wid", currentWid);
      }
    }
  });

  c.on("disconnected", (reason: string) => {
    currentState = "disconnected";
    currentQR = null;
    cachedGroups = [];
    client = null;
    console.log(`[WhatsApp] Disconnected: ${reason}`);
  });

  c.on("message", async (msg: any) => {
    try {
      await handleMessage(msg);
    } catch (err) {
      console.error("[WhatsApp] Error handling message:", err);
    }
  });

  return c;
}

export async function initialize(): Promise<void> {
  if (client || initializing) return;
  initializing = true;

  client = createClient();
  currentState = "connecting";

  try {
    await client.initialize();
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.includes("already running")) {
      console.warn(
        "[WhatsApp] Stale browser detected, cleaning up and retrying...",
      );
      client = null;
      await killStaleBrowser();
      client = createClient();
      currentState = "connecting";
      await client.initialize();
    } else {
      client = null;
      currentState = "disconnected";
      initializing = false;
      throw err;
    }
  }
}

export async function restartWhatsApp(): Promise<void> {
  console.log("[WhatsApp] Restart requested");

  // Destroy existing client if any
  if (client) {
    try {
      await client.destroy();
    } catch {
      // May already be dead
    }
    client = null;
  }

  currentState = "disconnected";
  currentQR = null;
  cachedGroups = [];
  initializing = false;

  await killStaleBrowser();
  await initialize();
}

export async function refreshGroups(): Promise<WAGroup[]> {
  if (!client || currentState !== "ready") return [];

  const chats = await client.getChats();
  cachedGroups = chats
    .filter((c: any) => c.isGroup)
    .map((c: any) => ({
      id: c.id._serialized,
      name: c.name,
      participantCount: c.groupMetadata?.participants?.length ?? 0,
    }));

  upsertGroups(cachedGroups);
  console.log(`[WhatsApp] Found ${cachedGroups.length} groups`);
  return cachedGroups;
}

async function handleMessage(msg: any): Promise<void> {
  // Only handle group messages
  const chat = await msg.getChat();
  if (!chat.isGroup) return;

  const groupId = chat.id._serialized;

  // Skip messages we sent ourselves (loop prevention)
  const msgId = msg.id._serialized;
  if (sentByBot.has(msgId)) {
    sentByBot.delete(msgId);
    return;
  }

  // Also skip if the message author is the bot itself
  if (msg.fromMe) return;

  const mappings = getActiveMappings(groupId);
  if (mappings.length === 0) return;

  // Get sender info
  const contact = await msg.getContact();
  const senderName = contact.pushname || contact.name || "Unknown";
  const senderPhone = contact.number || "Unknown";

  for (const mapping of mappings) {
    // Determine the target group
    let targetGroupId: string;
    if (mapping.source_group_id === groupId) {
      targetGroupId = mapping.target_group_id;
    } else if (mapping.bidirectional && mapping.target_group_id === groupId) {
      targetGroupId = mapping.source_group_id;
    } else {
      continue;
    }

    // Secondary loop prevention: skip if we just forwarded identical content to this pair
    const dedupKey = `${groupId}:${targetGroupId}:${(msg.body || "").slice(0, 100)}`;
    const lastForward = recentForwards.get(dedupKey);
    if (lastForward && Date.now() - lastForward < FORWARD_DEDUP_TTL) continue;

    try {
      let sent = false;

      if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        if (media) {
          const caption = formatMediaCaption(
            senderName,
            senderPhone,
            msg.body,
            msg.timestamp,
          );
          const sentMsg = await client!.sendMessage(targetGroupId, media, {
            caption,
          });
          trackSent(sentMsg.id._serialized);
          sent = true;
        }
      } else if (msg.body) {
        const text = formatMessage(
          senderName,
          senderPhone,
          msg.body,
          msg.timestamp,
        );
        const sentMsg = await client!.sendMessage(targetGroupId, text);
        trackSent(sentMsg.id._serialized);
        sent = true;
      }

      if (sent) {
        recentForwards.set(dedupKey, Date.now());
        setTimeout(() => recentForwards.delete(dedupKey), FORWARD_DEDUP_TTL);

        const cursorDir =
          mapping.source_group_id === groupId
            ? "forward"
            : mapping.bidirectional
              ? "reverse"
              : null;
        if (cursorDir) {
          incrementMsgCount(mapping.id, cursorDir);
          advanceCursor(mapping.id, cursorDir, msg.timestamp);
        }
      }
    } catch (err) {
      console.error(`[WhatsApp] Failed to forward to ${targetGroupId}:`, err);
    }
  }
}

function trackSent(msgId: string) {
  sentByBot.add(msgId);
  setTimeout(() => sentByBot.delete(msgId), SENT_CACHE_TTL);
}

function formatIST(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "short",
    timeStyle: "short",
  });
}

function formatMessage(
  name: string,
  phone: string,
  body: string,
  ts: number,
): string {
  //   return `*${name}* - _${phone}_
  // \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // ${body}
  // \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // _${formatIST(ts)} IST_
  // \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // _made by geeklord_ \u2764\uFE0F`;

  return `*${name}* - _${phone}_
\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
${body}
\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
_${formatIST(ts)} IST_`;
}

function formatMediaCaption(
  name: string,
  phone: string,
  body: string | null,
  ts: number,
): string {
  const msgPart = body ? body : "sent media";
  return formatMessage(name, phone, msgPart, ts);
}

export function isReady(): boolean {
  return currentState === "ready";
}

// --- Reconciliation ---

export async function fetchMissedMessages(
  mappingId: number,
  direction: string,
  limit: number = RECONCILE_PAGE_SIZE,
): Promise<{ messages: ReconcileMessage[]; hasMore: boolean }> {
  if (!client || currentState !== "ready") {
    return { messages: [], hasMore: false };
  }

  const cacheKey = `${mappingId}:${direction}`;
  const cached = reconcileCache.get(cacheKey);
  if (
    cached &&
    Date.now() - cached.fetchedAt < RECONCILE_CACHE_TTL &&
    cached.lastLimit >= limit
  ) {
    return {
      messages: cached.messages.slice(0, limit),
      hasMore: cached.messages.length > limit,
    };
  }

  const mapping = getMapping(mappingId);
  if (!mapping) return { messages: [], hasMore: false };

  const lastTs = getCursor(mappingId, direction);

  const sourceGroupId =
    direction === "forward" ? mapping.source_group_id : mapping.target_group_id;

  try {
    const chats = await client!.getChats();
    const chat = chats.find((c: any) => c.id._serialized === sourceGroupId);
    if (!chat) return { messages: [], hasMore: false };

    const waMessages = await (chat as any).fetchMessages({ limit: limit + 20 });
    const missed: ReconcileMessage[] = [];

    for (const msg of waMessages) {
      if (msg.fromMe) continue;
      if (msg.timestamp <= lastTs) continue;

      const contact = await msg.getContact();
      missed.push({
        id: msg.id._serialized,
        timestamp: msg.timestamp,
        senderName: contact.pushname || contact.name || "Unknown",
        senderPhone: contact.number || "Unknown",
        body: msg.body || (msg.hasMedia ? "[Media]" : "[Empty]"),
        hasMedia: msg.hasMedia,
        type: msg.type,
      });
    }

    missed.sort((a, b) => a.timestamp - b.timestamp);

    reconcileCache.set(cacheKey, {
      messages: missed,
      fetchedAt: Date.now(),
      lastLimit: limit,
    });

    return {
      messages: missed.slice(0, limit),
      hasMore: missed.length > limit,
    };
  } catch (err) {
    console.error(
      `[Reconcile] Failed to fetch messages for mapping ${mappingId}:`,
      err,
    );
    return { messages: [], hasMore: false };
  }
}

export async function fetchMoreMissedMessages(
  mappingId: number,
  direction: string,
  currentCount: number,
): Promise<{ messages: ReconcileMessage[]; hasMore: boolean }> {
  reconcileCache.delete(`${mappingId}:${direction}`);
  return fetchMissedMessages(
    mappingId,
    direction,
    currentCount + RECONCILE_PAGE_SIZE,
  );
}

export async function syncMessages(
  mappingId: number,
  direction: string,
  messageIds: string[],
): Promise<{ synced: number; errors: string[] }> {
  if (!client || currentState !== "ready") {
    return { synced: 0, errors: ["WhatsApp not connected"] };
  }

  const mapping = getMapping(mappingId);
  if (!mapping) return { synced: 0, errors: ["Mapping not found"] };

  const sourceGroupId =
    direction === "forward" ? mapping.source_group_id : mapping.target_group_id;
  const targetGroupId =
    direction === "forward" ? mapping.target_group_id : mapping.source_group_id;

  const cacheKey = `${mappingId}:${direction}`;
  const cached = reconcileCache.get(cacheKey);
  if (!cached)
    return { synced: 0, errors: ["No cached messages, fetch first"] };

  const messageIdSet = new Set(messageIds);
  const toSync = cached.messages.filter((m) => messageIdSet.has(m.id));

  let synced = 0;
  const errors: string[] = [];
  let maxTs = 0;

  for (const msg of toSync) {
    try {
      if (msg.hasMedia) {
        // Re-fetch the WA message for media download
        const chats = await client!.getChats();
        const chat = chats.find((c: any) => c.id._serialized === sourceGroupId);
        if (chat) {
          const waMessages = await (chat as any).fetchMessages({ limit: 200 });
          const waMsg = waMessages.find(
            (m: any) => m.id._serialized === msg.id,
          );
          if (waMsg?.hasMedia) {
            const media = await waMsg.downloadMedia();
            if (media) {
              const caption = formatMediaCaption(
                msg.senderName,
                msg.senderPhone,
                msg.body && msg.body !== "[Media]" ? msg.body : null,
                msg.timestamp,
              );
              const sentMsg = await client!.sendMessage(targetGroupId, media, {
                caption,
              });
              trackSent(sentMsg.id._serialized);
            }
          }
        }
      } else if (msg.body) {
        const text = formatMessage(
          msg.senderName,
          msg.senderPhone,
          msg.body,
          msg.timestamp,
        );
        const sentMsg = await client!.sendMessage(targetGroupId, text);
        trackSent(sentMsg.id._serialized);
      }

      incrementMsgCount(mappingId, direction);
      synced++;
      if (msg.timestamp > maxTs) maxTs = msg.timestamp;
    } catch (err) {
      errors.push(`Failed to sync ${msg.id}: ${String(err)}`);
    }
  }

  // Advance cursor atomically (MAX in SQL prevents regression)
  if (maxTs > 0) {
    advanceCursor(mappingId, direction, maxTs);
  }

  reconcileCache.delete(cacheKey);
  return { synced, errors };
}

export async function ignoreMessages(
  mappingId: number,
  direction: string,
  messageIds: string[],
): Promise<{ ignored: number }> {
  const cacheKey = `${mappingId}:${direction}`;
  const cached = reconcileCache.get(cacheKey);

  // Find max timestamp among ignored messages to advance cursor
  let maxTs = 0;
  if (cached) {
    const idSet = new Set(messageIds);
    for (const msg of cached.messages) {
      if (idSet.has(msg.id) && msg.timestamp > maxTs) maxTs = msg.timestamp;
    }
  }

  if (maxTs > 0) {
    advanceCursor(mappingId, direction, maxTs);
  }

  reconcileCache.delete(cacheKey);
  return { ignored: messageIds.length };
}

export async function getReconcileSummary(): Promise<
  Array<{
    mappingId: number;
    direction: string;
    sourceGroupName: string;
    targetGroupName: string;
    missedCount: number;
  }>
> {
  const mappings = listMappings().filter((m) => m.active);
  const results: Array<{
    mappingId: number;
    direction: string;
    sourceGroupName: string;
    targetGroupName: string;
    missedCount: number;
  }> = [];

  for (const mapping of mappings) {
    const { messages } = await fetchMissedMessages(
      mapping.id,
      "forward",
      RECONCILE_PAGE_SIZE,
    );
    if (messages.length > 0) {
      results.push({
        mappingId: mapping.id,
        direction: "forward",
        sourceGroupName: mapping.source_group_name || mapping.source_group_id,
        targetGroupName: mapping.target_group_name || mapping.target_group_id,
        missedCount: messages.length,
      });
    }

    if (mapping.bidirectional) {
      const { messages: revMsgs } = await fetchMissedMessages(
        mapping.id,
        "reverse",
        RECONCILE_PAGE_SIZE,
      );
      if (revMsgs.length > 0) {
        results.push({
          mappingId: mapping.id,
          direction: "reverse",
          sourceGroupName: mapping.target_group_name || mapping.target_group_id,
          targetGroupName: mapping.source_group_name || mapping.source_group_id,
          missedCount: revMsgs.length,
        });
      }
    }
  }

  return results;
}
