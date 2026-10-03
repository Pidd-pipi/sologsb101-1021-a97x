/**
 * 钤印 store（Svelte writable / derived）
 * 维护钤印记录与评级排序；可一键把最佳效果回填为采用稿效果。
 *
 * 换稿再刻：给再刻版登记第一条钤印是「完成」的最后一步——
 * 若该版工序已全部完成，登记后立即认证切换采用稿；此前旧版仍是现行版。
 */
import { derived, get, writable } from 'svelte/store';
import { createId, db, StaleVersionError, updateIfCurrent } from '$lib/utils/db';
import { subscribeCrudChanges } from '$lib/utils/crud-events';
import {
  GRADE_WEIGHT,
  type Grade,
  type Impression,
  type ImpressionDraft,
  type PaperKind,
} from '$lib/types/impression';
import {
  adoptDesign,
  certifyRecarvedDesign,
  designById,
  updateDesign,
} from './designStore';

export interface ImpressionFilters {
  keyword: string;
  grades: Grade[];
  paperTypes: PaperKind[];
}

export const DEFAULT_IMPRESSION_FILTERS: ImpressionFilters = {
  keyword: '',
  grades: [],
  paperTypes: [],
};

export const impressions = writable<Impression[]>([]);
export const impressionLoading = writable(false);
export const impressionReady = writable(false);
export const impressionError = writable('');
export const impressionFilters = writable<ImpressionFilters>({ ...DEFAULT_IMPRESSION_FILTERS });

/** 派生选择器：关键字 + 评级 + 纸张 */
export const filteredImpressions = derived(
  [impressions, impressionFilters],
  ([$impressions, $filters]) => {
    const keyword = $filters.keyword.trim();
    return $impressions.filter((impression) => {
      if (keyword.length > 0) {
        const haystack = `${impression.inkBrand}${impression.note}${impression.stampedAt}`;
        if (!haystack.includes(keyword)) return false;
      }
      if ($filters.grades.length > 0 && !$filters.grades.includes(impression.grade)) return false;
      if ($filters.paperTypes.length > 0 && !$filters.paperTypes.includes(impression.paperType)) return false;
      return true;
    });
  },
);

/** 按评级降序（同评级按日期倒序） */
export const gradeSortedImpressions = derived(impressions, ($impressions) =>
  [...$impressions].sort(
    (a, b) => GRADE_WEIGHT[b.grade] - GRADE_WEIGHT[a.grade] || b.stampedAt.localeCompare(a.stampedAt),
  ),
);

export async function loadImpressions(): Promise<void> {
  impressionLoading.set(true);
  try {
    const rows = await db.impressions.toArray();
    rows.sort((a, b) => b.stampedAt.localeCompare(a.stampedAt));
    impressions.set(rows);
    impressionError.set('');
    impressionReady.set(true);
  } catch (err) {
    impressionError.set(err instanceof Error ? err.message : '钤印记录读取失败');
    impressionReady.set(true);
  } finally {
    impressionLoading.set(false);
  }
}

export function impressionsOfDesign(designId: string): Impression[] {
  return get(impressions)
    .filter((impression) => impression.designId === designId)
    .sort((a, b) => GRADE_WEIGHT[b.grade] - GRADE_WEIGHT[a.grade] || b.stampedAt.localeCompare(a.stampedAt));
}

/** 某印稿的最佳钤印（评级最高，同日取最新） */
export function bestImpressionOf(designId: string): Impression | undefined {
  return impressionsOfDesign(designId)[0];
}

export function setImpressionKeyword(keyword: string): void {
  impressionFilters.update((filters) => ({ ...filters, keyword }));
}

export function setImpressionGrades(grades: Grade[]): void {
  impressionFilters.update((filters) => ({ ...filters, grades }));
}

export function setImpressionPaperTypes(paperTypes: PaperKind[]): void {
  impressionFilters.update((filters) => ({ ...filters, paperTypes }));
}

export function resetImpressionFilters(): void {
  impressionFilters.set({ ...DEFAULT_IMPRESSION_FILTERS });
}

export interface CreateImpressionResult {
  impression: Impression;
  /** 本次登记是否触发了再刻版认证切换 */
  certified: boolean;
}

/**
 * 登记钤印。
 * expectedDesignUpdatedAt 为页面打开时该印稿的版本号：另一标签页若改过采用稿，
 * 则拒绝写入并抛 StaleVersionError，请用户重新确认后再登记。
 * 再刻版在工序全部完成后收到第一条钤印即完成认证（切换采用稿与印石状态）。
 */
export async function createImpression(
  draft: ImpressionDraft,
  expectedDesignUpdatedAt?: number,
): Promise<CreateImpressionResult> {
  const design = await db.designs.get(draft.designId);
  if (!design) throw new StaleVersionError('designs', draft.designId);
  if (expectedDesignUpdatedAt !== undefined && design.updatedAt !== expectedDesignUpdatedAt) {
    throw new StaleVersionError('designs', draft.designId);
  }
  const now = Date.now();
  const row: Impression = { ...draft, id: createId('impr'), createdAt: now, updatedAt: now };
  await db.impressions.put(row);
  await loadImpressions();
  const certified = await certifyRecarvedDesign(draft.designId);
  return { impression: row, certified };
}

export async function updateImpression(
  id: string,
  patch: Partial<Impression>,
  expectedUpdatedAt?: number,
): Promise<void> {
  await updateIfCurrent(db.impressions, id, patch, expectedUpdatedAt);
  await loadImpressions();
  const target = get(impressions).find((impression) => impression.id === id);
  if (target) await certifyRecarvedDesign(target.designId);
}

export async function removeImpression(id: string): Promise<void> {
  await db.impressions.delete(id);
  await loadImpressions();
}

/**
 * 一键回填为采用稿效果：把该印稿评级最高的一条标记为采用效果，并把印稿置为采用稿。
 * 再刻版若尚未完成刻制 / 钤印，会抛 RecarveNotReadyError（由 createImpression 的认证切换负责）。
 */
export async function applyBestAsAdopted(designId: string): Promise<Impression | undefined> {
  const best = bestImpressionOf(designId);
  if (!best) return undefined;
  const now = Date.now();
  const siblings = get(impressions).filter((impression) => impression.designId === designId);
  await db.impressions.bulkPut(
    siblings.map((impression) => ({
      ...impression,
      note: impression.id === best.id ? '采用稿效果' : impression.note.replace('采用稿效果', '').trim(),
      updatedAt: now,
    })),
  );
  const design = designById(designId);
  if (design) {
    await adoptDesign(designId);
  } else {
    await updateDesign(designId, { adopted: true });
  }
  await loadImpressions();
  return best;
}

// 其它标签页补了钤印或认证切换采用稿时，本标签页重新载入使旧页面版本失效
if (typeof window !== 'undefined') {
  subscribeCrudChanges((table) => {
    if (table === 'impressions' || table === 'designs') void loadImpressions();
  });
}
