/**
 * 印稿（Design）数据模型
 * 一方印石的印文与释文设计稿，可存多稿并标记采用稿。
 *
 * 换稿再刻：一方印石刻完后常会换稿重刻。印文、朱白文或边框一变就是一方新印，
 * 必须建立独立的「再刻版」而不是直接改采用稿：
 * - 旧稿及其工序、钤印、印谱条目原样留在印石历史里（adopted 取消、标记被替代）；
 * - 新稿复制旧工序为待办，不继承旧钤印；
 * - 新稿刻完且登记钤印（认证）后，才成为采用稿，印石状态 / 最佳效果 / 印谱统计才切到它。
 */

/** 朱文 / 白文 */
export type DesignStyle = 'zhu' | 'bai';

/** 边框式样：无框 / 双边 / 借边 / 瓦当 */
export type BorderStyle = 'none' | 'double' | 'borrow' | 'tile';

/** 决定「是否必须换稿再刻」的关键字段：印文、朱白文、边框 */
export type DesignKeyField = 'sealText' | 'style' | 'borderStyle';

export interface Design {
  id: string;
  /** 所属印石 id */
  stoneId: string;
  /** 印文 */
  sealText: string;
  /** 释文 */
  annotation: string;
  /** 朱文 / 白文 */
  style: DesignStyle;
  /** 边框式样 */
  borderStyle: BorderStyle;
  /** 章法备注 */
  layoutNote: string;
  /** 是否采用稿（同石采用稿唯一；再刻版认证通过后才置 true） */
  adopted: boolean;
  /** 版次：初版为 1，每次换稿再刻 +1 */
  revision: number;
  /** 再刻版来源稿 id；初版为 null */
  sourceDesignId: string | null;
  /** 被哪一版再刻稿替代；仍是现行版时为 null */
  supersededByDesignId: string | null;
  /** 认证时间（全部工序完成且已登记钤印）；未认证为 null */
  certifiedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type DesignDraft = Omit<
  Design,
  'id' | 'createdAt' | 'updatedAt' | 'revision' | 'sourceDesignId' | 'supersededByDesignId' | 'certifiedAt'
>;

/**
 * 版本在印石历史中的角色：
 * - active      现行采用版（已认证）
 * - recarving   再刻进行中（尚未认证的再刻版，期间旧版仍为采用稿）
 * - superseded  已被替代的旧版（留在印石历史）
 * - draft       普通未采用稿
 */
export type DesignVersionStatus = 'active' | 'recarving' | 'superseded' | 'draft';

export const DESIGN_VERSION_STATUS_LABEL: Record<DesignVersionStatus, string> = {
  active: '现行版',
  recarving: '再刻中',
  superseded: '旧版',
  draft: '未采用',
};

export const DESIGN_STYLE_LABEL: Record<DesignStyle, string> = {
  zhu: '朱文',
  bai: '白文',
};

export const DESIGN_STYLE_COLOR: Record<DesignStyle, string> = {
  zhu: '#9c2b1f',
  bai: '#23282a',
};

export const DESIGN_STYLE_OPTIONS: ReadonlyArray<{ value: DesignStyle; label: string }> = [
  { value: 'zhu', label: '朱文' },
  { value: 'bai', label: '白文' },
];

export const BORDER_STYLE_LABEL: Record<BorderStyle, string> = {
  none: '无框',
  double: '双边',
  borrow: '借边',
  tile: '瓦当',
};

export const BORDER_STYLE_OPTIONS: ReadonlyArray<{ value: BorderStyle; label: string }> = [
  { value: 'none', label: '无框' },
  { value: 'double', label: '双边' },
  { value: 'borrow', label: '借边' },
  { value: 'tile', label: '瓦当' },
];

/** 换稿再刻时判定为「新印」的关键字段 */
export const DESIGN_KEY_FIELDS: readonly DesignKeyField[] = ['sealText', 'style', 'borderStyle'];

export function createEmptyDesignDraft(stoneId: string): DesignDraft {
  return {
    stoneId,
    sealText: '',
    annotation: '',
    style: 'zhu',
    borderStyle: 'borrow',
    layoutNote: '',
    adopted: false,
  };
}

/** 印稿派生统计（工序完成数、完成率、剩余时长） */
export interface DesignProgress {
  designId: string;
  total: number;
  done: number;
  doing: number;
  percent: number;
  remainingMinutes: number;
  /** 最佳钤印评级 */
  bestGrade: string;
  /** 钤印次数 */
  impressionCount: number;
}
