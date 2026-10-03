/**
 * 印稿 store（Svelte writable / derived）
 * 维护印稿草稿、采用稿标记与换稿再刻版本链；同一印石采用稿唯一。
 *
 * 换稿再刻规则：
 * - 印文 / 朱白文 / 边框变更且已有刻制或钤印历史时，禁止直接改稿，必须创建独立再刻版；
 * - 再刻版保留旧稿、旧工序、旧钤印、旧印谱条目于印石历史，复制旧工序为待办，不继承钤印；
 * - 再刻版刻完且登记钤印（认证）后才切换采用稿，印石状态 / 最佳效果 / 印谱统计随之切换。
 */
import { derived, get, writable } from 'svelte/store';
import {
  createId,
  db,
  removeDesignCascade,
  StaleVersionError,
  updateIfCurrent,
} from '$lib/utils/db';
import {
  DESIGN_KEY_FIELDS,
  type BorderStyle,
  type Design,
  type DesignDraft,
  type DesignStyle,
} from '$lib/types/design';
import type { Carve } from '$lib/types/carve';
import { designHasHistory, isRecarvedDesign, keyFieldsChanged, nextRevisionNo } from '$lib/utils/design';
import { readUiPrefs, writeUiPrefs } from '$lib/utils/db';
import { subscribeCrudChanges } from '$lib/utils/crud-events';

/** 直接修改已有刻制 / 钤印历史稿件的关键字段（应改走「换稿再刻」） */
export class DesignKeyFieldsError extends Error {
  constructor(public designId: string) {
    super('印文、朱白文或边框已变，请使用「换稿再刻」建立独立新版');
    this.name = 'DesignKeyFieldsError';
  }
}

/** 再刻版尚未刻完并登记钤印，不能提前设为采用稿 */
export class RecarveNotReadyError extends Error {
  constructor(public designId: string) {
    super('再刻版需全部工序完成并登记钤印后才会切换为采用稿');
    this.name = 'RecarveNotReadyError';
  }
}

export interface DesignFilters {
  keyword: string;
  styles: DesignStyle[];
  borderStyles: BorderStyle[];
  adoptedOnly: boolean;
}

export const DEFAULT_DESIGN_FILTERS: DesignFilters = {
  keyword: '',
  styles: [],
  borderStyles: [],
  adoptedOnly: false,
};

export const designs = writable<Design[]>([]);
export const designLoading = writable(false);
export const designReady = writable(false);
export const designError = writable('');
export const currentDesignId = writable<string | null>(readUiPrefs().lastDesignId);
export const designFilters = writable<DesignFilters>({ ...DEFAULT_DESIGN_FILTERS });

currentDesignId.subscribe((value) => {
  writeUiPrefs({ ...readUiPrefs(), lastDesignId: value });
});

/** 派生选择器：关键字 + 朱白文 + 边框 + 仅看采用稿 */
export const filteredDesigns = derived([designs, designFilters], ([$designs, $filters]) => {
  const keyword = $filters.keyword.trim();
  return $designs.filter((design) => {
    if (keyword.length > 0) {
      const haystack = `${design.sealText}${design.annotation}${design.layoutNote}`;
      if (!haystack.includes(keyword)) return false;
    }
    if ($filters.styles.length > 0 && !$filters.styles.includes(design.style)) return false;
    if ($filters.borderStyles.length > 0 && !$filters.borderStyles.includes(design.borderStyle)) return false;
    if ($filters.adoptedOnly && !design.adopted) return false;
    return true;
  });
});

export const adoptedDesigns = derived(designs, ($designs) => $designs.filter((design) => design.adopted));

export async function loadDesigns(): Promise<void> {
  designLoading.set(true);
  try {
    const rows = await db.designs.toArray();
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    designs.set(normalizeDesigns(rows));
    designError.set('');
    designReady.set(true);
    const current = get(currentDesignId);
    if (current !== null && !rows.some((design) => design.id === current)) {
      currentDesignId.set(rows[0]?.id ?? null);
    }
    if (get(currentDesignId) === null) currentDesignId.set(rows[0]?.id ?? null);
  } catch (err) {
    designError.set(err instanceof Error ? err.message : '印稿读取失败');
    designReady.set(true);
  } finally {
    designLoading.set(false);
  }
}

/** 回填 v2 之前历史稿缺失的版本字段 */
function normalizeDesigns(rows: Design[]): Design[] {
  return rows.map((row) => ({
    ...row,
    revision: typeof row.revision === 'number' && row.revision > 0 ? row.revision : 1,
    sourceDesignId: row.sourceDesignId ?? null,
    supersededByDesignId: row.supersededByDesignId ?? null,
    certifiedAt: row.certifiedAt ?? null,
  }));
}

export function designsOfStone(stoneId: string): Design[] {
  return get(designs)
    .filter((design) => design.stoneId === stoneId)
    .sort((a, b) => Number(b.adopted) - Number(a.adopted) || b.updatedAt - a.updatedAt);
}

export function designById(id: string): Design | undefined {
  return get(designs).find((design) => design.id === id);
}

export function setCurrentDesign(id: string | null): void {
  currentDesignId.set(id);
}

export function setDesignKeyword(keyword: string): void {
  designFilters.update((filters) => ({ ...filters, keyword }));
}

export function setDesignStyles(styles: DesignStyle[]): void {
  designFilters.update((filters) => ({ ...filters, styles }));
}

export function setBorderStyles(borderStyles: BorderStyle[]): void {
  designFilters.update((filters) => ({ ...filters, borderStyles }));
}

export function setAdoptedOnly(adoptedOnly: boolean): void {
  designFilters.update((filters) => ({ ...filters, adoptedOnly }));
}

export function resetDesignFilters(): void {
  designFilters.set({ ...DEFAULT_DESIGN_FILTERS });
}

export async function createDesign(draft: DesignDraft): Promise<Design> {
  const now = Date.now();
  const row: Design = {
    ...draft,
    id: createId('design'),
    revision: 1,
    sourceDesignId: null,
    supersededByDesignId: null,
    certifiedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.designs.put(row);
  // 采用稿唯一：新稿标记采用时清除同石其它采用稿
  if (row.adopted) await clearOtherAdopted(row.stoneId, row.id);
  await loadDesigns();
  currentDesignId.set(row.id);
  return row;
}

/**
 * 更新印稿。
 * - 编辑已有刻制 / 钤印历史的稿件时，印文 / 朱白文 / 边框任一变更都拒绝直接保存，
 *   须调用 createRecarveVersion() 建立独立再刻版；
 * - expectedUpdatedAt 为页面打开编辑框时的版本号，过期则抛 StaleVersionError。
 */
export async function updateDesign(
  id: string,
  patch: Partial<Design>,
  expectedUpdatedAt?: number,
): Promise<void> {
  const existing = await db.designs.get(id);
  if (!existing) throw new StaleVersionError('designs', id);
  if (expectedUpdatedAt !== undefined && existing.updatedAt !== expectedUpdatedAt) {
    throw new StaleVersionError('designs', id);
  }
  if (DESIGN_KEY_FIELDS.some((field) => field in patch)) {
    const before = {
      sealText: existing.sealText,
      style: existing.style,
      borderStyle: existing.borderStyle,
    };
    const after = {
      sealText: patch.sealText ?? existing.sealText,
      style: patch.style ?? existing.style,
      borderStyle: patch.borderStyle ?? existing.borderStyle,
    };
    if (keyFieldsChanged(before, after)) {
      const [carveRows, impressionRows] = await Promise.all([
        db.carves.where('designId').equals(id).toArray(),
        db.impressions.where('designId').equals(id).toArray(),
      ]);
      if (designHasHistory(existing, carveRows, impressionRows)) {
        throw new DesignKeyFieldsError(id);
      }
    }
  }
  await updateIfCurrent(db.designs, id, patch, expectedUpdatedAt);
  if (patch.adopted) await clearOtherAdopted(existing.stoneId, id);
  await loadDesigns();
}

export async function removeDesign(id: string): Promise<void> {
  await removeDesignCascade(id);
  await loadDesigns();
}

/**
 * 换稿再刻：基于旧稿建立独立再刻版。
 * - 旧稿取消采用并标记被谁替代；旧工序、旧钤印、旧印谱条目原样保留在印石历史；
 * - 新稿复制旧工序，状态全部重置为「未开始」（待办），不继承旧钤印；
 * - 新稿先不采用：全部工序完成且登记钤印后由认证流程切换；
 * - 印石状态回到「在刻」。
 * 返回新稿。
 */
export async function createRecarveVersion(
  sourceId: string,
  patch: Partial<DesignDraft>,
  expectedUpdatedAt?: number,
): Promise<Design> {
  const all = await db.designs.toArray();
  const source = all.find((design) => design.id === sourceId);
  if (!source) throw new StaleVersionError('designs', sourceId);
  if (expectedUpdatedAt !== undefined && source.updatedAt !== expectedUpdatedAt) {
    throw new StaleVersionError('designs', sourceId);
  }

  const now = Date.now();
  const revision = nextRevisionNo(all, sourceId);
  const newId = createId('design');
  const newDesign: Design = {
    stoneId: source.stoneId,
    sealText: patch.sealText ?? source.sealText,
    annotation: patch.annotation ?? source.annotation,
    style: patch.style ?? source.style,
    borderStyle: patch.borderStyle ?? source.borderStyle,
    layoutNote: patch.layoutNote ?? source.layoutNote,
    adopted: false,
    revision,
    sourceDesignId: source.id,
    supersededByDesignId: null,
    certifiedAt: null,
    id: newId,
    createdAt: now,
    updatedAt: now,
  };

  const sourceCarves = await db.carves.where('designId').equals(sourceId).toArray();
  const copiedCarves: Carve[] = [...sourceCarves]
    .sort((a, b) => a.seq - b.seq)
    .map((carve, index) => ({
      ...carve,
      id: createId('carve'),
      designId: newId,
      seq: index + 1,
      // 复制旧工序为待办：进度从头来过
      state: 'todo',
      createdAt: now,
      updatedAt: now,
    }));

  await db.transaction(
    'rw',
    [db.designs, db.carves, db.stones],
    async () => {
      // 旧稿留在印石历史：取消采用并挂接替代关系
      await db.designs.put({
        ...source,
        adopted: false,
        supersededByDesignId: newId,
        updatedAt: now,
      });
      // 同石若另有现行采用稿（重复换稿时），保留其采用关系不变
      await db.designs.put(newDesign);
      if (copiedCarves.length > 0) await db.carves.bulkPut(copiedCarves);
      // 再刻期间印石回到「在刻」，完成并认证后才切回「已刻」
      await db.stones.update(source.stoneId, { state: 'carving', updatedAt: now });
    },
  );

  await loadDesigns();
  currentDesignId.set(newId);
  return newDesign;
}

/** 再刻版是否已满足认证条件（以库内最新数据为准，供刻制 / 钤印完成时调用） */
export async function readyToCertify(designId: string): Promise<boolean> {
  const design = await db.designs.get(designId);
  if (!design || !isRecarvedDesign(design) || design.adopted) return false;
  const [steps, prints] = await Promise.all([
    db.carves.where('designId').equals(designId).toArray(),
    db.impressions.where('designId').equals(designId).toArray(),
  ]);
  return steps.length > 0 && steps.every((step) => step.state === 'done') && prints.length > 0;
}

/**
 * 再刻完成认证：刻完且已登记钤印后，把采用关系切到新版，并把印石置为「已刻」；
 * 同时为新版在印谱末尾补一条「待收录」条目（旧版条目保留在印谱历史中）。
 * 幂等：重复调用不会重复采用或重复建条目。返回是否本次发生了切换。
 */
export async function certifyRecarvedDesign(designId: string): Promise<boolean> {
  const design = await db.designs.get(designId);
  if (!design || !isRecarvedDesign(design) || design.adopted) return false;
  const [steps, prints] = await Promise.all([
    db.carves.where('designId').equals(designId).toArray(),
    db.impressions.where('designId').equals(designId).toArray(),
  ]);
  if (!(steps.length > 0 && steps.every((step) => step.state === 'done') && prints.length > 0)) {
    return false;
  }

  const now = Date.now();
  let switched = false;
  await db.transaction(
    'rw',
    [db.designs, db.stones, db.catalogs],
    async () => {
      // 事务内再确认一次，避免与另一标签页的认证竞争
      const fresh = await db.designs.get(designId);
      if (!fresh || fresh.adopted) return;
      const siblings = await db.designs.where('stoneId').equals(design.stoneId).toArray();
      await db.designs.bulkPut(
        siblings.map((item) => {
          if (item.id === designId) {
            switched = true;
            return { ...item, adopted: true, certifiedAt: now, updatedAt: now };
          }
          if (item.adopted) return { ...item, adopted: false, updatedAt: now };
          return item;
        }),
      );
      await db.stones.update(design.stoneId, { state: 'carved', updatedAt: now });
      // 新版印谱条目：旧版条目保留，仅给新版补一条待收录
      const exists = await db.catalogs.where('designId').equals(designId).count();
      if (exists === 0) {
        const orderNo = (await db.catalogs.where('stoneId').equals(design.stoneId).count()) + 1;
        await db.catalogs.put({
          id: createId('cata'),
          stoneId: design.stoneId,
          designId,
          orderNo,
          included: 'pending',
          note: '再刻版完成认证，待收录',
          createdAt: now,
          updatedAt: now,
        });
      }
    },
  );
  if (switched) await loadDesigns();
  return switched;
}

/**
 * 标记采用稿（同石其它稿取消采用）。
 * 再刻版不允许提前采用：未完成刻制 / 钤印时报错；已满足条件时走认证流程
 * （补认证时间与新版印谱待收录条目），采用关系由 certifyRecarvedDesign 切换。
 */
export async function adoptDesign(id: string): Promise<void> {
  const target = await db.designs.get(id);
  if (target && isRecarvedDesign(target) && !target.adopted) {
    const ready = await readyToCertify(id);
    if (!ready) throw new RecarveNotReadyError(id);
    await certifyRecarvedDesign(id);
    return;
  }
  await updateDesign(id, { adopted: true });
}

async function clearOtherAdopted(stoneId: string, keepId: string): Promise<void> {
  const siblings = (await db.designs.where('stoneId').equals(stoneId).toArray()).filter(
    (design) => design.id !== keepId && design.adopted,
  );
  if (siblings.length === 0) return;
  await db.designs.bulkPut(siblings.map((design) => ({ ...design, adopted: false, updatedAt: Date.now() })));
}

// 其它标签页改了印稿 / 工序（换稿再刻复制工序）/ 钤印（认证切换采用稿）时，重新载入使旧页面版本失效
if (typeof window !== 'undefined') {
  subscribeCrudChanges((table) => {
    if (table === 'designs' || table === 'carves' || table === 'impressions') void loadDesigns();
  });
}
