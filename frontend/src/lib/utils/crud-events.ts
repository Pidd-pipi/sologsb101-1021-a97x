/**
 * 跨标签页数据变更通知
 * - 本标签页写入后经 Dexie CRUD 钩子广播到其它标签页；
 * - 其它标签页收到通知后重新订阅载入（liveQuery 之外的 writable store），
 *   使页面上的旧版本数据失效；保存动作另由 StaleVersionError 做「保存前重新确认」。
 * 纯前端实现：优先 BroadcastChannel，不支持时退回 storage 事件。
 */

export type CrudTableName = 'stones' | 'designs' | 'carves' | 'impressions' | 'catalogs';

export const CRUD_TABLE_NAMES: readonly CrudTableName[] = [
  'stones',
  'designs',
  'carves',
  'impressions',
  'catalogs',
];

interface CrudChangeMessage {
  channel: 'gbsealcarve:crud';
  contextId: string;
  table: CrudTableName;
  at: number;
}

/** 本标签页唯一标识：用于忽略自己发出的广播 */
export const CONTEXT_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const STORAGE_FALLBACK_KEY = 'gbsealcarve:crud-event';

let channel: BroadcastChannel | null = null;
try {
  channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('gbsealcarve:crud') : null;
} catch {
  channel = null;
}

function buildMessage(table: CrudTableName): CrudChangeMessage {
  return { channel: 'gbsealcarve:crud', contextId: CONTEXT_ID, at: Date.now(), table };
}

/** 本标签页发生写入后调用：通知其它标签页某张表已变更 */
export function broadcastCrudChange(table: CrudTableName): void {
  const message = buildMessage(table);
  if (channel) {
    channel.postMessage(message);
    return;
  }
  try {
    localStorage.setItem(STORAGE_FALLBACK_KEY, JSON.stringify(message));
  } catch {
    /* 隐私模式下忽略 */
  }
}

/** 订阅其它标签页的写入通知（自动忽略本标签页） */
export function subscribeCrudChanges(handler: (table: CrudTableName) => void): () => void {
  const handle = (raw: unknown): void => {
    const message = raw as CrudChangeMessage | null;
    if (!message || message.channel !== 'gbsealcarve:crud' || message.contextId === CONTEXT_ID) return;
    handler(message.table);
  };
  if (channel) {
    const listener = (event: MessageEvent) => handle(event.data);
    channel.addEventListener('message', listener);
    return () => channel?.removeEventListener('message', listener);
  }
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== STORAGE_FALLBACK_KEY || !event.newValue) return;
    try {
      handle(JSON.parse(event.newValue));
    } catch {
      /* 忽略非法负载 */
    }
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
