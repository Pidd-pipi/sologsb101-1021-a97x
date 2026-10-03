/**
 * 刻制工序 store（Svelte writable / derived）
 * 维护工序顺序与完成计数。
 * - 普通采用稿：全部工序完成回写印石为「已刻」；
 * - 再刻版：全部完成仅表示刻制结束，印石仍保持「在刻」，
 *   待登记第一条钤印并通过认证后，才切换采用稿与印石状态（见 designStore.certifyRecarvedDesign）。
 */
import { derived, get, writable } from 'svelte/store';
import { createId, db, StaleVersionError, updateIfCurrent } from '$lib/utils/db';
import { subscribeCrudChanges } from '$lib/utils/crud-events';
import {
  nextCarveState,
  suggestMinutes,
  STANDARD_KNIFE_SEQUENCE,
  type Carve,
  type CarveDraft,
  type CarveState,
  type KnifeMethod,
} from '$lib/types/carve';
import { certifyRecarvedDesign } from './designStore';
import { updateStone } from './stoneStore';
import { isRecarvedDesign } from '$lib/utils/design';

export const carves = writable<Carve[]>([]);
export const carveLoading = writable(false);
export const carveReady = writable(false);
export const carveError = writable('');

export const carveTotals = derived(carves, ($carves) => {
  const done = $carves.filter((carve) => carve.state === 'done').length;
  const doing = $carves.filter((carve) => carve.state === 'doing').length;
  const remainingMinutes = $carves
    .filter((carve) => carve.state !== 'done')
    .reduce((sum, carve) => sum + carve.minutes, 0);
  return {
    total: $carves.length,
    done,
    doing,
    remainingMinutes,
    percent: $carves.length === 0 ? 0 : Math.round((done / $carves.length) * 100),
  };
});

export async function loadCarves(): Promise<void> {
  carveLoading.set(true);
  try {
    const rows = await db.carves.toArray();
    rows.sort((a, b) => (a.designId === b.designId ? a.seq - b.seq : a.designId.localeCompare(b.designId)));
    carves.set(rows);
    carveError.set('');
    carveReady.set(true);
  } catch (err) {
    carveError.set(err instanceof Error ? err.message : '工序读取失败');
    carveReady.set(true);
  } finally {
    carveLoading.set(false);
  }
}

export function carvesOfDesign(designId: string): Carve[] {
  return get(carves)
    .filter((carve) => carve.designId === designId)
    .sort((a, b) => a.seq - b.seq);
}

export function nextSeq(designId: string): number {
  const list = carvesOfDesign(designId);
  return list.length === 0 ? 1 : Math.max(...list.map((carve) => carve.seq)) + 1;
}

export async function createCarve(draft: CarveDraft): Promise<Carve> {
  const now = Date.now();
  const row: Carve = { ...draft, id: createId('carve'), createdAt: now, updatedAt: now };
  await db.carves.put(row);
  await loadCarves();
  return row;
}

export async function updateCarve(id: string, patch: Partial<Carve>): Promise<void> {
  await db.carves.update(id, { ...patch, updatedAt: Date.now() } as never);
  await loadCarves();
}

export async function removeCarve(id: string): Promise<void> {
  const target = get(carves).find((carve) => carve.id === id);
  await db.carves.delete(id);
  if (target) {
    const rest = carvesOfDesign(target.designId)
      .filter((carve) => carve.id !== id)
      .map((carve, index) => ({ ...carve, seq: index + 1, updatedAt: Date.now() }));
    if (rest.length > 0) await db.carves.bulkPut(rest);
  }
  await loadCarves();
}

export async function reorderCarves(designId: string, orderedIds: string[]): Promise<void> {
  const indexOf = new Map(orderedIds.map((id, index) => [id, index]));
  const rows = carvesOfDesign(designId)
    .sort((a, b) => {
      const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
      const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
      return ai - bi;
    })
    .map((carve, index) => ({ ...carve, seq: index + 1, updatedAt: Date.now() }));
  await db.carves.bulkPut(rows);
  await loadCarves();
}

export async function batchUpdateCarves(ids: string[], patch: Partial<Carve>): Promise<void> {
  if (ids.length === 0) return;
  const now = Date.now();
  const rows = get(carves)
    .filter((carve) => ids.includes(carve.id))
    .map((carve) => ({ ...carve, ...patch, updatedAt: now }));
  await db.carves.bulkPut(rows);
  await loadCarves();
  // 若批量完成把某再刻版的最后工序收掉，则尝试认证（仍需该版已登记钤印才会切换）
  const designIds = Array.from(new Set(rows.map((row) => row.designId)));
  await Promise.all(designIds.map((designId) => settleDesignAfterCarve(designId)));
}

/**
 * 工序变化后收敛印稿状态：
 * - 再刻版：满足「工序完成 + 已有钤印」则认证切换；否则保持在刻，不回写已刻；
 * - 普通稿：全部工序完成沿用原行为，回写印石为「已刻」。
 */
async function settleDesignAfterCarve(designId: string): Promise<void> {
  const fresh = await db.designs.get(designId);
  if (!fresh) return;
  const steps = await db.carves.where('designId').equals(designId).toArray();
  const allDone = steps.length > 0 && steps.every((step) => step.state === 'done');
  if (!allDone) return;
  if (isRecarvedDesign(fresh)) {
    await certifyRecarvedDesign(designId);
    return;
  }
  await updateStone(fresh.stoneId, { state: 'carved' });
}

/**
 * 推进工序状态；某印稿全部工序完成时按版本规则收敛印石状态。
 * expectedUpdatedAt 非空时校验页面持有的工序版本（另一标签页改过则要求重新确认）。
 * 返回推进后的状态，便于页面提示。
 */
export async function advanceCarve(id: string, expectedUpdatedAt?: number): Promise<CarveState> {
  const carve = await db.carves.get(id);
  if (!carve) throw new StaleVersionError('carves', id);
  if (expectedUpdatedAt !== undefined && carve.updatedAt !== expectedUpdatedAt) {
    throw new StaleVersionError('carves', id);
  }
  const next = nextCarveState(carve.state);
  if (next === carve.state) return carve.state;
  await updateIfCurrent(db.carves, id, { state: next }, expectedUpdatedAt);
  await loadCarves();
  await settleDesignAfterCarve(carve.designId);
  return next;
}

/** 按标准刀法序列生成工序（已存在的序号跳过） */
export async function generateStandardSequence(designId: string): Promise<number> {
  const existing = carvesOfDesign(designId);
  const now = Date.now();
  let created = 0;
  for (let index = 0; index < STANDARD_KNIFE_SEQUENCE.length; index += 1) {
    const seq = index + 1;
    if (existing.some((carve) => carve.seq === seq)) continue;
    const method = STANDARD_KNIFE_SEQUENCE[index] as KnifeMethod;
    await db.carves.put({
      id: createId('carve'),
      designId,
      seq,
      knifeMethod: method,
      minutes: suggestMinutes(method),
      operator: '',
      state: 'todo',
      createdAt: now,
      updatedAt: now,
    });
    created += 1;
  }
  await loadCarves();
  return created;
}

// 其它标签页改动工序或认证采用稿（designs）时，本标签页重新载入看板
if (typeof window !== 'undefined') {
  subscribeCrudChanges((table) => {
    if (table === 'carves' || table === 'designs') void loadCarves();
  });
}
