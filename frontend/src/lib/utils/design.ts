/**
 * 印稿版本（换稿再刻）工具
 * - 版本角色判定：现行版 / 再刻中 / 旧版 / 未采用稿
 * - 同石版本链排序、版次与来源关系派生
 * - 再刻完成条件：全部工序完成且已登记钤印（认证后才切换采用稿）
 * 跨 store 与页面共用，避免版本规则散落各处。
 */
import type { Carve } from '$lib/types/carve';
import { DESIGN_KEY_FIELDS, type Design, type DesignKeyField, type DesignVersionStatus } from '$lib/types/design';
import type { Impression } from '$lib/types/impression';

/** 版本在印石历史中的角色（见 DesignVersionStatus） */
export function designVersionStatus(design: Design): DesignVersionStatus {
  if (design.supersededByDesignId) return 'superseded';
  if (design.adopted) return 'active';
  if (design.sourceDesignId) return 'recarving';
  return 'draft';
}

/** 是否为换稿再刻产生的版本（初版之外的任何版本） */
export function isRecarvedDesign(design: Design): boolean {
  return design.sourceDesignId !== null;
}

/** 是否为留存在印石历史里的旧版 */
export function isSupersededDesign(design: Design): boolean {
  return design.supersededByDesignId !== null;
}

/**
 * 再刻版是否已完成刻制并登记过钤印（认证条件）。
 * 必须同时满足：存在工序、全部完成、至少一条钤印。
 */
export function isRecarveReady(design: Design, carves: Carve[], impressions: Impression[]): boolean {
  if (!design.sourceDesignId) return false;
  const steps = carves.filter((carve) => carve.designId === design.id);
  const prints = impressions.filter((impression) => impression.designId === design.id);
  return steps.length > 0 && steps.every((step) => step.state === 'done') && prints.length > 0;
}

/** 是否已有刻制 / 钤印历史（有关键字段变更时必须换稿再刻） */
export function designHasHistory(design: Design, carves: Carve[], impressions: Impression[]): boolean {
  return (
    carves.some((carve) => carve.designId === design.id) ||
    impressions.some((impression) => impression.designId === design.id)
  );
}

/** 取同一印石的全部版本（按版次升序，再按创建时间） */
export function revisionsOfStone(designs: Design[], stoneId: string): Design[] {
  return designs
    .filter((design) => design.stoneId === stoneId)
    .sort((a, b) => a.revision - b.revision || a.createdAt - b.createdAt);
}

/** 沿 sourceDesignId 追溯某版的初版（同石版本链起点） */
export function rootDesignId(designs: Design[], designId: string | null): string | null {
  if (!designId) return null;
  const byId = new Map(designs.map((design) => [design.id, design]));
  let current = byId.get(designId) ?? null;
  const guard = new Set<string>();
  while (current && current.sourceDesignId && !guard.has(current.id)) {
    guard.add(current.id);
    current = byId.get(current.sourceDesignId) ?? null;
  }
  return current?.id ?? designId;
}

/** 同一版本链上的全部版本（含初版与各次再刻版），按版次升序 */
export function revisionChain(designs: Design[], designId: string): Design[] {
  const rootId = rootDesignId(designs, designId);
  if (!rootId) return [];
  const byId = new Map(designs.map((design) => [design.id, design]));
  const chain: Design[] = [];
  const queue: string[] = [rootId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    chain.push(node);
    designs
      .filter((design) => design.sourceDesignId === id)
      .forEach((design) => queue.push(design.id));
  }
  return chain.sort((a, b) => a.revision - b.revision || a.createdAt - b.createdAt);
}

/** 下一版次（同版本链内最大版次 +1） */
export function nextRevisionNo(designs: Design[], sourceDesignId: string): number {
  const chain = revisionChain(designs, sourceDesignId);
  return chain.reduce((max, design) => Math.max(max, design.revision), 0) + 1;
}

/** 关键字段（印文 / 朱白文 / 边框）是否发生变化 */
export function keyFieldsChanged(
  before: Pick<Design, DesignKeyField>,
  after: Pick<Design, DesignKeyField>,
): boolean {
  return DESIGN_KEY_FIELDS.some((field) => before[field] !== after[field]);
}

/** 版本展示名：印文后附第 n 版（初版不缀版次） */
export function designRevisionLabel(design: Design): string {
  return design.revision > 1 ? `第 ${design.revision} 版` : '初版';
}
