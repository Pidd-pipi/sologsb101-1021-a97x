<script lang="ts">
  /**
   * /impressions 钤印登记与效果比对
   * 同稿多枚并列展示印泥、纸张、压力与评级并择优，可一键回填为采用稿效果。
   * 保存前比对版本戳：其他标签页修改采用稿或补钤印时，先重新确认再写。
   * 消费 Impression、Design；复用 <GradeTag>、<FilterBar>、<StatBadge>、<EmptyPanel>。
   */
  import { push, router } from '$lib/router';
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte';
  import FilterBar, {
    encodeQuery,
    firstValue,
    parseQuery,
    type FilterSelectConfig,
  } from '$lib/components/common/FilterBar.svelte';
  import GradeTag from '$lib/components/common/GradeTag.svelte';
  import StatBadge from '$lib/components/common/StatBadge.svelte';
  import {
    applyBestAsAdopted,
    bestImpressionOf,
    createImpression,
    filteredImpressions,
    impressionFilters,
    impressionsOfDesign,
    removeImpression,
    resetImpressionFilters,
    setImpressionGrades,
    setImpressionKeyword,
    setImpressionPaperTypes,
    updateImpression,
  } from '$lib/stores/impressionStore';
  import { clearRecarveNotice, currentDesignId, designs, recarveNotice, setCurrentDesign } from '$lib/stores/designStore';
  import { impressionVersionStamp, rowUpdatedAt } from '$lib/utils/db';
  import {
    GRADE_COLOR,
    GRADE_LABEL,
    GRADE_OPTIONS,
    GRADE_WEIGHT,
    INK_BRAND_OPTIONS,
    PAPER_KIND_LABEL,
    PAPER_KIND_OPTIONS,
    PRESSURE_LABEL,
    PRESSURE_OPTIONS,
    createEmptyImpressionDraft,
    type Grade,
    type Impression,
    type ImpressionDraft,
    type PaperKind,
  } from '$lib/types/impression';
  import { DESIGN_STYLE_LABEL } from '$lib/types/design';

  const queryValues = $derived(parseQuery(router.querystring ?? ''));

  $effect(() => {
    setImpressionKeyword(firstValue(queryValues, 'kw'));
    setImpressionGrades((queryValues.grade ?? []) as Grade[]);
    setImpressionPaperTypes((queryValues.paperType ?? []) as PaperKind[]);
  });

  const activeDesignId = $derived($currentDesignId ?? $designs[0]?.id ?? '');
  const activeDesign = $derived($designs.find((design) => design.id === activeDesignId) ?? null);
  const list = $derived(impressionsOfDesign(activeDesignId));

  const totals = $derived({
    total: $filteredImpressions.length,
    excellent: $filteredImpressions.filter((item) => item.grade === 'excellent').length,
    waste: $filteredImpressions.filter((item) => item.grade === 'waste').length,
    designs: new Set($filteredImpressions.map((item) => item.designId)).size,
  });

  function updateQuery(patch: Record<string, string | string[] | undefined>): void {
    const merged: Record<string, string[]> = { ...parseQuery(router.querystring ?? '') };
    Object.entries(patch).forEach(([key, value]) => {
      if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) delete merged[key];
      else merged[key] = Array.isArray(value) ? value : [value];
    });
    const qs = encodeQuery(merged);
    void push(`/impressions${qs.length > 0 ? `?${qs}` : ''}`);
  }

  const selects: FilterSelectConfig[] = [
    { key: 'grade', label: '评级', options: GRADE_OPTIONS.map((item) => ({ label: item.label, value: item.value })) },
    { key: 'paperType', label: '纸张', options: PAPER_KIND_OPTIONS.map((item) => ({ label: item.label, value: item.value })) },
  ];

  let dialogOpen = $state(false);
  let editing = $state<Impression | null>(null);
  let draft = $state<ImpressionDraft>(createEmptyImpressionDraft(''));
  let pendingDelete = $state<Impression | null>(null);
  let toast = $state('');
  /** 打开对话框时记录的版本戳：采用稿 updatedAt、该稿钤印集合戳、被编辑记录 updatedAt */
  let baseDesignStamp = $state<number | null>(null);
  let baseImpressionStamp = $state('');
  let baseRowStamp = $state<number | null>(null);
  /** 保存前重新确认：proceed 为 null 表示仅提示不可继续（如记录已被删除） */
  let staleConfirm = $state<{ text: string; proceed: (() => Promise<void>) | null } | null>(null);

  // 再刻版完成并登记钤印后，采用稿 / 印石状态 / 印谱统计已切换的提示
  $effect(() => {
    const notice = $recarveNotice;
    if (!notice) return;
    toast = `再刻第 ${notice.version} 版「${notice.sealText}」已完成并登记钤印：采用稿、印石状态与印谱统计已切换`;
    clearRecarveNotice();
    setTimeout(() => (toast = ''), 3600);
  });

  async function openCreate(): Promise<void> {
    if (!activeDesignId) return;
    editing = null;
    draft = createEmptyImpressionDraft(activeDesignId);
    baseDesignStamp = activeDesign?.updatedAt ?? null;
    baseImpressionStamp = await impressionVersionStamp(activeDesignId);
    dialogOpen = true;
  }

  function openEdit(impression: Impression): void {
    editing = impression;
    draft = {
      designId: impression.designId,
      inkBrand: impression.inkBrand,
      paperType: impression.paperType,
      pressure: impression.pressure,
      grade: impression.grade,
      stampedAt: impression.stampedAt,
      note: impression.note,
    };
    baseRowStamp = impression.updatedAt;
    dialogOpen = true;
  }

  async function submit(): Promise<void> {
    const stale = await checkStaleBeforeSave();
    if (stale) {
      staleConfirm = stale;
      return;
    }
    await doSubmit();
  }

  /** 保存前重新确认：其他标签页修改采用稿或补钤印时，旧页面版本失效 */
  async function checkStaleBeforeSave(): Promise<{ text: string; proceed: (() => Promise<void>) | null } | null> {
    if (editing) {
      const fresh = await rowUpdatedAt('impressions', editing.id);
      if (fresh === null) return { text: '该钤印记录已在其他页面被删除。', proceed: null };
      if (baseRowStamp !== null && fresh !== baseRowStamp) {
        return { text: '该钤印记录已在其他页面被修改，保存将覆盖那些更改。是否继续？', proceed: doSubmit };
      }
      return null;
    }
    const designFresh = await rowUpdatedAt('designs', draft.designId);
    if (designFresh === null) return { text: '该印稿已在其他页面被删除，无法登记钤印。', proceed: null };
    const impressionFresh = await impressionVersionStamp(draft.designId);
    if ((baseDesignStamp !== null && designFresh !== baseDesignStamp) || impressionFresh !== baseImpressionStamp) {
      return {
        text: '该采用稿或其钤印记录已在其他页面变更（可能另一标签页改了采用稿或补了钤印）。确认继续登记？',
        proceed: doSubmit,
      };
    }
    return null;
  }

  async function doSubmit(): Promise<void> {
    if (editing) {
      await updateImpression(editing.id, { ...draft });
      editing = null;
    } else {
      await createImpression({ ...draft });
    }
    dialogOpen = false;
    staleConfirm = null;
  }

  async function confirmStale(): Promise<void> {
    const proceed = staleConfirm?.proceed;
    staleConfirm = null;
    if (proceed) await proceed();
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    await removeImpression(pendingDelete.id);
    pendingDelete = null;
  }

  async function adoptBest(): Promise<void> {
    const best = await applyBestAsAdopted(activeDesignId);
    toast = best
      ? `已把 ${best.stampedAt} 的「${GRADE_LABEL[best.grade]}」效果回填为采用稿效果`
      : '该印稿还没有钤印记录';
    setTimeout(() => (toast = ''), 2600);
  }
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-xl tracking-wide text-ink">钤印登记与效果比对</h2>
      <p class="mt-1 text-sm text-ink-soft">同稿多枚并列展示印泥、纸张、压力与评级，按评级择优并可一键回填采用稿效果。</p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <select
        class="gb-input w-[260px]"
        value={activeDesignId}
        onchange={(event) => setCurrentDesign((event.currentTarget as HTMLSelectElement).value)}
      >
        {#each $designs as design (design.id)}
          <option value={design.id}>{design.sealText} · {DESIGN_STYLE_LABEL[design.style]}</option>
        {/each}
      </select>
      <button class="gb-btn" disabled={list.length === 0} onclick={() => void adoptBest()}>回填采用稿效果</button>
      <button class="gb-btn-primary" onclick={() => void openCreate()}>登记钤印</button>
    </div>
  </div>

  {#if toast}
    <div class="rounded-xl border border-jade/40 bg-jade/10 px-4 py-2 text-sm text-jade">{toast}</div>
  {/if}

  {#if activeDesign}
    <div class="gb-panel flex flex-wrap items-center gap-3 text-sm text-ink-soft">
      <span class="text-ink">印文：{activeDesign.sealText}</span>
      <span>释文：{activeDesign.annotation || '未填写'}</span>
      <span>{activeDesign.adopted ? '已采用' : '未采用'}</span>
      {#if bestImpressionOf(activeDesignId)}
        {@const best = bestImpressionOf(activeDesignId)}
        {#if best}
          <GradeTag grade={best.grade} size="small" note={`当前最佳 ${best.stampedAt}`} />
        {/if}
      {/if}
    </div>
  {/if}

  <div class="flex flex-wrap gap-3">
    <StatBadge label="钤印记录" value={totals.total} suffix="次" tone="seal" />
    <StatBadge label="优等效果" value={totals.excellent} suffix="次" tone="jade" />
    <StatBadge label="废印" value={totals.waste} suffix="次" />
    <StatBadge label="覆盖印稿" value={totals.designs} suffix="稿" tone="amber" />
    <StatBadge label="当前稿钤印" value={list.length} suffix="次" tone="ink" />
  </div>

  <FilterBar
    keyword={$impressionFilters.keyword}
    placeholder="搜索印泥 / 备注 / 日期…"
    {selects}
    values={queryValues}
    onKeyword={(value) => updateQuery({ kw: value })}
    onSelect={(key, value) => updateQuery({ [key]: value })}
    onReset={() => {
      resetImpressionFilters();
      updateQuery({ kw: undefined, grade: undefined, paperType: undefined });
    }}
    hint={`当前稿 ${list.length} 次`}
  />

  {#if list.length === 0}
    <EmptyPanel
      title="该印稿还没有钤印记录"
      description="登记第一次钤印：填写印泥品牌、纸张、压力与效果评级；同稿多次钤印会自动按评级排序。"
      actionText="登记钤印"
      onAction={() => void openCreate()}
    />
  {:else}
    <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {#each list as impression (impression.id)}
        {@const isBest = bestImpressionOf(activeDesignId)?.id === impression.id}
        <article class="gb-panel {isBest ? 'ring-2 ring-jade/40' : ''}">
          <header class="flex flex-wrap items-center justify-between gap-2">
            <GradeTag grade={impression.grade} />
            <span class="text-xs text-ink-soft">{impression.stampedAt}</span>
          </header>

          <div class="mt-3 gb-seal-preview border-seal/40 text-seal" style="border-color:{GRADE_COLOR[impression.grade]}66">
            {activeDesign?.sealText ?? ''}
          </div>

          <dl class="mt-3 space-y-1 text-sm text-ink-soft">
            <div>印泥：{impression.inkBrand}</div>
            <div>纸张：{PAPER_KIND_LABEL[impression.paperType]} · 压力：{PRESSURE_LABEL[impression.pressure]}</div>
            <div>评级权重：{GRADE_WEIGHT[impression.grade]}（优 4 → 废 1）</div>
            {#if impression.note}<div>备注：{impression.note}</div>{/if}
          </dl>

          <div class="mt-3 flex flex-wrap gap-2">
            {#if isBest}<span class="gb-tag" style="color:#3f6b57;border-color:#3f6b5766">当前最佳</span>{/if}
            <button class="gb-btn" onclick={() => openEdit(impression)}>编辑</button>
            <button class="gb-btn-danger" onclick={() => (pendingDelete = impression)}>删除</button>
          </div>
        </article>
      {/each}
    </div>
  {/if}

  <p class="text-xs text-ink-soft">
    评级排序：优 &gt; 良 &gt; 一般 &gt; 废；「回填采用稿效果」会把当前稿评级最高的一条标记为采用效果，并把印稿置为采用稿。
    再刻版工序全部完成后，首次登记钤印会把采用稿、印石状态与印谱统计切换到再刻版；
    若另一标签页改了采用稿或补了钤印，保存前会先提示重新确认。
  </p>
</div>

{#if dialogOpen}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
    <div class="w-full max-w-lg rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="mb-3 text-lg text-ink">{editing ? '编辑钤印记录' : '登记钤印'}</h3>
      <div class="space-y-3">
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block">
            <span class="gb-label">印泥品牌</span>
            <input class="gb-input" list="ink-brands" bind:value={draft.inkBrand} />
            <datalist id="ink-brands">
              {#each INK_BRAND_OPTIONS as brand (brand)}
                <option value={brand}></option>
              {/each}
            </datalist>
          </label>
          <label class="block">
            <span class="gb-label">纸张</span>
            <select class="gb-input" bind:value={draft.paperType}>
              {#each PAPER_KIND_OPTIONS as item (item.value)}
                <option value={item.value}>{item.label}</option>
              {/each}
            </select>
          </label>
        </div>
        <div class="grid gap-3 sm:grid-cols-3">
          <label class="block">
            <span class="gb-label">压力</span>
            <select class="gb-input" bind:value={draft.pressure}>
              {#each PRESSURE_OPTIONS as item (item.value)}
                <option value={item.value}>{item.label}</option>
              {/each}
            </select>
          </label>
          <label class="block">
            <span class="gb-label">效果评级</span>
            <select class="gb-input" bind:value={draft.grade}>
              {#each GRADE_OPTIONS as item (item.value)}
                <option value={item.value}>{item.label}</option>
              {/each}
            </select>
          </label>
          <label class="block">
            <span class="gb-label">钤印日期</span>
            <input class="gb-input" type="date" bind:value={draft.stampedAt} />
          </label>
        </div>
        <label class="block">
          <span class="gb-label">备注</span>
          <input class="gb-input" bind:value={draft.note} placeholder="如：采用稿效果，朱色匀净" />
        </label>
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (dialogOpen = false)}>取消</button>
        <button class="gb-btn-primary" onclick={() => void submit()}>保存</button>
      </div>
    </div>
  </div>
{/if}

{#if staleConfirm}
  <div class="fixed inset-0 z-[60] grid place-items-center bg-black/40 px-4">
    <div class="w-full max-w-md rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="text-lg text-ink">保存前请重新确认</h3>
      <p class="mt-2 text-sm text-ink-soft">{staleConfirm.text}</p>
      <div class="mt-5 flex justify-end gap-2">
        {#if staleConfirm.proceed}
          <button class="gb-btn" onclick={() => (staleConfirm = null)}>取消</button>
          <button class="gb-btn-primary" onclick={() => void confirmStale()}>确认并保存</button>
        {:else}
          <button class="gb-btn-primary" onclick={() => (staleConfirm = null)}>知道了</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if pendingDelete}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
    <div class="w-full max-w-md rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="text-lg text-ink">删除钤印记录</h3>
      <p class="mt-2 text-sm text-ink-soft">
        将删除 {pendingDelete.stampedAt} 使用「{pendingDelete.inkBrand}」的这次钤印记录。
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (pendingDelete = null)}>取消</button>
        <button class="gb-btn-primary" onclick={() => void confirmDelete()}>确认删除</button>
      </div>
    </div>
  </div>
{/if}
