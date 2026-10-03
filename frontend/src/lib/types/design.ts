/**
 * 印稿（Design）数据模型
 * 一方印石的印文与释文设计稿，可存多稿并标记采用稿。
 */

/** 朱文 / 白文 */
export type DesignStyle = 'zhu' | 'bai';

/** 边框式样：无框 / 双边 / 借边 / 瓦当 */
export type BorderStyle = 'none' | 'double' | 'borrow' | 'tile';

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
  /** 是否采用稿 */
  adopted: boolean;
  /** 再刻来源印稿 id（首版为 null）；换稿再刻时指向上一版，旧稿留在印石历史里 */
  recarveOf: string | null;
  /** 版本序号：同一印石上的第几版（首版 1，换稿再刻递增） */
  version: number;
  createdAt: number;
  updatedAt: number;
}

export type DesignDraft = Omit<Design, 'id' | 'createdAt' | 'updatedAt'>;

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

export function createEmptyDesignDraft(stoneId: string): DesignDraft {
  return {
    stoneId,
    sealText: '',
    annotation: '',
    style: 'zhu',
    borderStyle: 'borrow',
    layoutNote: '',
    adopted: false,
    recarveOf: null,
    version: 1,
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
