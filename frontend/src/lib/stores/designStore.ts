/**
 * 印稿 store（Svelte writable / derived）
 * 维护印稿草稿与采用稿标记；同一印石可存多稿，采用稿唯一。
 * 换稿再刻：印文 / 朱白文 / 边框变更时建独立再刻版（复制旧工序为待办、不继承旧钤印），
 * 再刻版完成并登记钤印后才切换采用稿、印石状态与印谱统计。
 */
import { derived, get, writable } from 'svelte/store';
import { createId, db, removeDesignCascade, switchCatalogToRecarve } from '$lib/utils/db';
import type { BorderStyle, Design, DesignDraft, DesignStyle } from '$lib/types/design';
import type { Carve } from '$lib/types/carve';
import { readUiPrefs, writeUiPrefs } from '$lib/utils/db';
import { updateStone } from './stoneStore';

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
    designs.set(rows);
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
  const row: Design = { ...draft, id: createId('design'), createdAt: now, updatedAt: now };
  await db.designs.put(row);
  // 采用稿唯一：新稿标记采用时清除同石其它采用稿
  if (row.adopted) await clearOtherAdopted(row.stoneId, row.id);
  await loadDesigns();
  currentDesignId.set(row.id);
  return row;
}

export async function updateDesign(id: string, patch: Partial<Design>): Promise<void> {
  const existing = designById(id);
  await db.designs.update(id, { ...patch, updatedAt: Date.now() } as never);
  if (patch.adopted && existing) await clearOtherAdopted(existing.stoneId, id);
  await loadDesigns();
}

export async function removeDesign(id: string): Promise<void> {
  await removeDesignCascade(id);
  await loadDesigns();
}

/** 标记采用稿（同石其它稿取消采用） */
export async function adoptDesign(id: string): Promise<void> {
  await updateDesign(id, { adopted: true });
}

async function clearOtherAdopted(stoneId: string, keepId: string): Promise<void> {
  const siblings = (await db.designs.where('stoneId').equals(stoneId).toArray()).filter(
    (design) => design.id !== keepId && design.adopted,
  );
  if (siblings.length === 0) return;
  await db.designs.bulkPut(siblings.map((design) => ({ ...design, adopted: false, updatedAt: Date.now() })));
}

/* ------------------------------ 换稿再刻 ------------------------------ */

/** 再刻版切换通知：再刻版完成并登记钤印后置位，页面订阅展示后清除 */
export interface RecarveNotice {
  designId: string;
  sealText: string;
  version: number;
  at: number;
}

export const recarveNotice = writable<RecarveNotice | null>(null);

export function clearRecarveNotice(): void {
  recarveNotice.set(null);
}

/**
 * 换稿再刻：以 sourceId 为上一版建独立再刻版。
 * - 新稿不采用（adopted=false），recarveOf 指向上一版，version 递增；
 * - 旧稿、工序、钤印与印谱条目原样留在印石历史里；
 * - 旧工序按原序复制为「未开始」待办，不复制任何钤印记录。
 * 返回新印稿；上一版已被删除时返回 null。
 */
export async function createRecarveVersion(sourceId: string, draft: DesignDraft): Promise<Design | null> {
  const source = await db.designs.get(sourceId);
  if (!source) return null;
  const now = Date.now();
  const row: Design = {
    ...draft,
    stoneId: source.stoneId,
    adopted: false,
    recarveOf: source.id,
    version: source.version + 1,
    id: createId('design'),
    createdAt: now,
    updatedAt: now,
  };
  const copied: Carve[] = (await db.carves.where('designId').equals(sourceId).toArray())
    .sort((a, b) => a.seq - b.seq)
    .map((carve) => ({
      ...carve,
      id: createId('carve'),
      designId: row.id,
      state: 'todo',
      createdAt: now,
      updatedAt: now,
    }));
  await db.transaction('rw', [db.designs, db.carves], async () => {
    await db.designs.put(row);
    if (copied.length > 0) await db.carves.bulkPut(copied);
  });
  await loadDesigns();
  currentDesignId.set(row.id);
  return row;
}

/**
 * 再刻版切换检查：工序全部完成且已登记钤印时，
 * 才把采用稿、印石状态（已刻）与印谱统计切到该再刻版。
 * 由工序推进 / 批量完成 / 登记钤印后调用；返回是否发生了切换。
 */
export async function maybePromoteRecarve(designId: string): Promise<boolean> {
  const design = await db.designs.get(designId);
  if (!design || !design.recarveOf || design.adopted) return false;
  const steps = await db.carves.where('designId').equals(designId).toArray();
  if (steps.length === 0 || steps.some((step) => step.state !== 'done')) return false;
  const stamped = await db.impressions.where('designId').equals(designId).count();
  if (stamped === 0) return false;
  await adoptDesign(designId);
  await updateStone(design.stoneId, { state: 'carved' });
  await switchCatalogToRecarve(design);
  recarveNotice.set({ designId, sealText: design.sealText, version: design.version, at: Date.now() });
  return true;
}
