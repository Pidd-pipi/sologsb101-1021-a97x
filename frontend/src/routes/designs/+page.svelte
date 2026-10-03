<script lang="ts">
  /**
   * /designs 印稿设计与释文编辑
   * 朱文白文、边框式样与章法备注录入并标记采用稿（同石采用稿唯一）。
   * 消费 Design、Stone；复用 <FilterBar>、<EmptyPanel>、<GradeTag>、<StatBadge>。
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
  import StaleConfirm from '$lib/components/common/StaleConfirm.svelte';
  import { useCarveProgress, progressOfDesign } from '$lib/hooks/useCarveProgress';
  import {
    adoptDesign,
    createDesign,
    createRecarveVersion,
    currentDesignId,
    designFilters,
    designs,
    designsOfStone,
    filteredDesigns,
    removeDesign,
    resetDesignFilters,
    setAdoptedOnly,
    setBorderStyles,
    setCurrentDesign,
    setDesignKeyword,
    setDesignStyles,
    updateDesign,
    DesignKeyFieldsError,
    RecarveNotReadyError,
  } from '$lib/stores/designStore';
  import { currentStoneId, setCurrentStone, stones, loadStones } from '$lib/stores/stoneStore';
  import { loadCarves } from '$lib/stores/carveStore';
  import { impressions, bestImpressionOf, loadImpressions } from '$lib/stores/impressionStore';
  import { StaleVersionError } from '$lib/utils/db';
  import {
    BORDER_STYLE_LABEL,
    BORDER_STYLE_OPTIONS,
    DESIGN_STYLE_LABEL,
    DESIGN_STYLE_OPTIONS,
    DESIGN_VERSION_STATUS_LABEL,
    createEmptyDesignDraft,
    type BorderStyle,
    type Design,
    type DesignDraft,
    type DesignStyle,
  } from '$lib/types/design';
  import { STONE_TYPE_LABEL } from '$lib/types/stone';
  import {
    designRevisionLabel,
    designVersionStatus,
    isRecarvedDesign,
    isSupersededDesign,
  } from '$lib/utils/design';

  const { progressByDesign } = useCarveProgress();
  const queryValues = $derived(parseQuery(router.querystring ?? ''));

  $effect(() => {
    setDesignKeyword(firstValue(queryValues, 'kw'));
    setDesignStyles((queryValues.style ?? []) as DesignStyle[]);
    setBorderStyles((queryValues.borderStyle ?? []) as BorderStyle[]);
    setAdoptedOnly(firstValue(queryValues, 'adopted') === '1');
  });

  function updateQuery(patch: Record<string, string | string[] | undefined>): void {
    const merged: Record<string, string[]> = { ...parseQuery(router.querystring ?? '') };
    Object.entries(patch).forEach(([key, value]) => {
      if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) delete merged[key];
      else merged[key] = Array.isArray(value) ? value : [value];
    });
    const qs = encodeQuery(merged);
    void push(`/designs${qs.length > 0 ? `?${qs}` : ''}`);
  }

  const selects: FilterSelectConfig[] = [
    { key: 'style', label: '朱白文', options: DESIGN_STYLE_OPTIONS.map((item) => ({ label: item.label, value: item.value })) },
    { key: 'borderStyle', label: '边框', options: BORDER_STYLE_OPTIONS.map((item) => ({ label: item.label, value: item.value })) },
  ];

  const stoneOptions = $derived($stones.map((stone) => ({ id: stone.id, name: stone.name })));
  const activeStoneId = $derived($currentStoneId ?? $stones[0]?.id ?? '');
  const list = $derived(
    $filteredDesigns.filter((design) => design.stoneId === activeStoneId || $currentStoneId === null),
  );

  const totals = $derived({
    designs: $designs.length,
    adopted: $designs.filter((design) => design.adopted).length,
    zhu: $designs.filter((design) => design.style === 'zhu').length,
    bai: $designs.filter((design) => design.style === 'bai').length,
    stamped: $impressions.length,
    recarving: $designs.filter((design) => designVersionStatus(design) === 'recarving').length,
    superseded: $designs.filter((design) => isSupersededDesign(design)).length,
  });

  let dialogOpen = $state(false);
  let editing = $state<Design | null>(null);
  let editVersionAt = 0;
  let draft = $state<DesignDraft>(createEmptyDesignDraft(''));
  let formError = $state('');
  let pendingDelete = $state<Design | null>(null);
  let toast = $state('');

  // 换稿再刻对话框
  let recarveOpen = $state(false);
  let recarveSource = $state<Design | null>(null);
  let recarveVersionAt = 0;
  let recarveDraft = $state<DesignDraft>(createEmptyDesignDraft(''));

  // 保存前重新确认（StaleVersionError）
  let staleOpen = $state(false);
  let staleMessage = $state('');

  function showToast(text: string): void {
    toast = text;
    setTimeout(() => (toast = ''), 3000);
  }

  /** 重新载入全部本地表（保存前重新确认） */
  async function reloadAll(): Promise<void> {
    await Promise.all([loadStones(), loadCarves(), loadImpressions()]);
  }

  function openCreate(): void {
    const stoneId = activeStoneId;
    if (!stoneId) return;
    editing = null;
    editVersionAt = 0;
    formError = '';
    draft = createEmptyDesignDraft(stoneId);
    dialogOpen = true;
  }

  function openEdit(design: Design): void {
    editing = design;
    editVersionAt = design.updatedAt;
    formError = '';
    draft = {
      stoneId: design.stoneId,
      sealText: design.sealText,
      annotation: design.annotation,
      style: design.style,
      borderStyle: design.borderStyle,
      layoutNote: design.layoutNote,
      adopted: design.adopted,
    };
    dialogOpen = true;
  }

  function openRecarve(design: Design): void {
    recarveSource = design;
    recarveVersionAt = design.updatedAt;
    formError = '';
    recarveDraft = {
      stoneId: design.stoneId,
      sealText: design.sealText,
      annotation: design.annotation,
      style: design.style,
      borderStyle: design.borderStyle,
      layoutNote: design.layoutNote,
      adopted: false,
    };
    recarveOpen = true;
  }

  async function submit(): Promise<void> {
    if (draft.sealText.trim().length === 0) return;
    if (!editing) {
      await createDesign({ ...draft });
      dialogOpen = false;
      return;
    }
    try {
      await updateDesign(editing.id, { ...draft }, editVersionAt);
      dialogOpen = false;
    } catch (error) {
      if (error instanceof DesignKeyFieldsError) {
        // 关键字段已变：关掉编辑框，带着修改直接打开「换稿再刻」
        const source = editing;
        dialogOpen = false;
        recarveSource = source;
        recarveVersionAt = editVersionAt;
        recarveDraft = { ...draft, adopted: false };
        formError = '印文、朱白文或边框已变，不能直接改旧稿；请在下方建立独立再刻版。';
        recarveOpen = true;
      } else if (error instanceof StaleVersionError) {
        staleMessage = '该印稿刚在另一标签页被修改';
        staleOpen = true;
      } else {
        formError = error instanceof Error ? error.message : '保存失败';
      }
    }
  }

  async function submitRecarve(): Promise<void> {
    if (!recarveSource) return;
    if (recarveDraft.sealText.trim().length === 0) return;
    try {
      const created = await createRecarveVersion(
        recarveSource.id,
        { ...recarveDraft },
        recarveVersionAt,
      );
      recarveOpen = false;
      showToast(`已建立第 ${created.revision} 版（再刻版）：旧稿与旧钤印已留存，工序已复制为待办`);
    } catch (error) {
      if (error instanceof StaleVersionError) {
        staleMessage = '旧稿刚在另一标签页被修改';
        staleOpen = true;
      } else {
        formError = error instanceof Error ? error.message : '建立再刻版失败';
      }
    }
  }

  async function adopt(design: Design): Promise<void> {
    try {
      await adoptDesign(design.id);
    } catch (error) {
      if (error instanceof RecarveNotReadyError) {
        showToast('再刻版需全部工序完成并登记钤印后才会自动切换为采用稿');
      } else if (error instanceof StaleVersionError) {
        staleMessage = '该印稿刚在另一标签页被修改';
        staleOpen = true;
      } else if (error instanceof DesignKeyFieldsError) {
        showToast('印文、朱白文或边框变更须使用「换稿再刻」');
      }
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    await removeDesign(pendingDelete.id);
    pendingDelete = null;
  }
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-xl tracking-wide text-ink">印稿设计与释文</h2>
      <p class="mt-1 text-sm text-ink-soft">同一印石可存多稿并标记采用稿；采用后可带出到刻制与钤印登记。</p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <select
        class="gb-input w-[220px]"
        value={activeStoneId}
        onchange={(event) => {
          const value = (event.currentTarget as HTMLSelectElement).value;
          setCurrentStone(value);
          const first = designsOfStone(value)[0];
          if (first) setCurrentDesign(first.id);
        }}
      >
        {#each stoneOptions as stone (stone.id)}
          <option value={stone.id}>{stone.name}</option>
        {/each}
      </select>
      <button class="gb-btn" onclick={() => void push('/carve')}>刻制看板</button>
      <button class="gb-btn-primary" onclick={openCreate}>新建印稿</button>
    </div>
  </div>

  <div class="flex flex-wrap gap-3">
    <StatBadge label="印稿总数" value={totals.designs} suffix="稿" tone="seal" />
    <StatBadge label="现行采用版" value={totals.adopted} suffix="稿" tone="jade" />
    <StatBadge label="再刻中" value={totals.recarving} suffix="稿" tone="amber" />
    <StatBadge label="历史旧版" value={totals.superseded} suffix="稿" tone="ink" />
    <StatBadge label="钤印次数" value={totals.stamped} suffix="次" />
  </div>

  <FilterBar
    keyword={$designFilters.keyword}
    placeholder="搜索印文 / 释文 / 章法…"
    {selects}
    values={queryValues}
    onKeyword={(value) => updateQuery({ kw: value })}
    onSelect={(key, value) => updateQuery({ [key]: value })}
    onReset={() => {
      resetDesignFilters();
      updateQuery({ kw: undefined, style: undefined, borderStyle: undefined, adopted: undefined });
    }}
    hint={`共 ${list.length} / ${$designs.length} 稿`}
  />

  <div class="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
    <button
      class="rounded-full border px-3 py-1 {$designFilters.adoptedOnly ? 'border-seal bg-seal/10 text-seal' : 'border-line'}"
      onclick={() => updateQuery({ adopted: $designFilters.adoptedOnly ? undefined : '1' })}
    >
      仅看采用稿
    </button>
    <span>当前印石：{stoneOptions.find((stone) => stone.id === activeStoneId)?.name ?? '未选择'}</span>
  </div>

  {#if list.length === 0}
    <EmptyPanel
      title={$designs.length === 0 ? '还没有设计任何印稿' : '当前筛选条件下没有印稿'}
      description={$designs.length === 0
        ? '为印石设计第一稿：填写印文、释文、朱白文与边框式样，并标记采用稿。'
        : '试着放宽朱白文或边框条件，或重置筛选。'}
      actionText="新建印稿"
      secondaryText="重置筛选"
      onAction={openCreate}
      onSecondary={() => {
        resetDesignFilters();
        updateQuery({ kw: undefined, style: undefined, borderStyle: undefined, adopted: undefined });
      }}
    />
  {:else}
    <div class="grid gap-4 md:grid-cols-2">
      {#each list as design (design.id)}
        {@const progress = progressOfDesign($progressByDesign, design.id)}
        {@const best = bestImpressionOf(design.id)}
        {@const status = designVersionStatus(design)}
        {@const source = isRecarvedDesign(design) && design.sourceDesignId
          ? $designs.find((item) => item.id === design.sourceDesignId)
          : null}
        <article
          class="gb-panel {$currentDesignId === design.id ? 'ring-2 ring-seal/40' : ''} {status ===
          'superseded'
            ? 'opacity-70'
            : ''}"
        >
          <header class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2">
              <span class="gb-tag" style="color:#9c2b1f;border-color:#9c2b1f66">{DESIGN_STYLE_LABEL[design.style]}</span>
              <span class="text-lg font-semibold tracking-[0.2em] text-ink">{design.sealText}</span>
              {#if design.adopted}<span class="gb-tag" style="color:#3f6b57;border-color:#3f6b5766">采用稿</span>{/if}
              {#if design.revision > 1}
                <span class="gb-tag" style="color:#b98a3c;border-color:#b98a3c66">{designRevisionLabel(design)}</span>
              {/if}
              {#if status === 'recarving'}
                <span class="gb-tag" style="color:#b98a3c;border-color:#b98a3c66">{DESIGN_VERSION_STATUS_LABEL.recarving}</span>
              {:else if status === 'superseded'}
                <span class="gb-tag" style="color:#8b8f90;border-color:#8b8f9066">{DESIGN_VERSION_STATUS_LABEL.superseded}</span>
              {/if}
            </div>
            <span class="text-xs text-ink-soft">{BORDER_STYLE_LABEL[design.borderStyle]}</span>
          </header>

          {#if source}
            <p class="mt-1 text-xs text-ink-soft">再刻自：{source.sealText}（{designRevisionLabel(source)}）</p>
          {/if}
          {#if status === 'superseded' && design.supersededByDesignId}
            {@const successor = $designs.find((item) => item.id === design.supersededByDesignId)}
            {#if successor}
              <p class="mt-1 text-xs text-ink-soft">已被「{successor.sealText}」{designRevisionLabel(successor)}替代，旧工序与钤印留存在此</p>
            {/if}
          {/if}

          <div class="mt-3 gb-seal-preview border-seal/50 text-seal" style="border-style:{design.borderStyle === 'none'
            ? 'none'
            : design.borderStyle === 'double'
              ? 'double'
              : 'solid'}">
            {design.sealText || '印文待定'}
          </div>

          <dl class="mt-3 space-y-1 text-sm text-ink-soft">
            <div>释文：{design.annotation || '未填写'}</div>
            <div>章法：{design.layoutNote || '未填写'}</div>
            <div>
              工序 {progress.done}/{progress.total}（{progress.percent}%）· 剩余 {progress.remainingMinutes} 分钟 · 钤印
              {progress.impressionCount} 次
            </div>
          </dl>

          {#if best}
            <div class="mt-2"><GradeTag grade={best.grade} size="small" note={`最佳 ${best.stampedAt}`} /></div>
          {/if}

          <div class="mt-3 flex flex-wrap gap-2">
            {#if $currentDesignId !== design.id}
              <button class="gb-btn" onclick={() => setCurrentDesign(design.id)}>设为当前</button>
            {/if}
            {#if !design.adopted}
              <button
                class="gb-btn"
                disabled={status === 'recarving'}
                title={status === 'recarving' ? '再刻版完成刻制并登记钤印后自动切换' : ''}
                onclick={() => void adopt(design)}
              >
                设为采用稿
              </button>
            {/if}
            <button class="gb-btn" onclick={() => (setCurrentDesign(design.id), void push('/carve'))}>排工序</button>
            <button class="gb-btn" onclick={() => (setCurrentDesign(design.id), void push('/impressions'))}>去钤印</button>
            {#if status !== 'superseded'}
              <button class="gb-btn" style="color:#b98a3c;border-color:#b98a3c66" onclick={() => openRecarve(design)}>
                换稿再刻
              </button>
            {/if}
            <button class="gb-btn" onclick={() => openEdit(design)}>编辑</button>
            <button class="gb-btn-danger" onclick={() => (pendingDelete = design)}>删除</button>
          </div>
        </article>
      {/each}
    </div>
  {/if}

  {#if toast}
    <div class="rounded-xl border border-jade/40 bg-jade/10 px-4 py-2 text-sm text-jade">{toast}</div>
  {/if}

  <p class="text-xs text-ink-soft">
    换稿再刻：印文、朱白文或边框一变就是新印，系统会建立独立再刻版——旧稿、旧工序、旧钤印与印谱条目留在印石历史，新稿复制旧工序为待办且不继承旧钤印；新版全部工序完成并登记钤印后，采用稿、印石状态、最佳效果与印谱统计才切换到它。
  </p>
</div>

{#if dialogOpen}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
    <div class="w-full max-w-lg rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="mb-3 text-lg text-ink">{editing ? `编辑印稿「${editing.sealText}」` : '新建印稿'}</h3>
      {#if formError}
        <div class="mb-3 rounded-xl border border-amber-400/50 bg-amber-400/10 px-3 py-2 text-sm" style="color:#b98a3c">
          {formError}
        </div>
      {/if}
      <div class="space-y-3">
        <label class="block">
          <span class="gb-label">所属印石</span>
          <select class="gb-input" bind:value={draft.stoneId}>
            {#each $stones as stone (stone.id)}
              <option value={stone.id}>{STONE_TYPE_LABEL[stone.stoneType]} · {stone.name}</option>
            {/each}
          </select>
        </label>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block">
            <span class="gb-label">印文</span>
            <input class="gb-input" bind:value={draft.sealText} placeholder="如：澄怀观道" />
          </label>
          <label class="block">
            <span class="gb-label">朱文 / 白文</span>
            <select class="gb-input" bind:value={draft.style}>
              {#each DESIGN_STYLE_OPTIONS as item (item.value)}
                <option value={item.value}>{item.label}</option>
              {/each}
            </select>
          </label>
        </div>
        <label class="block">
          <span class="gb-label">释文</span>
          <input class="gb-input" bind:value={draft.annotation} placeholder="如：宗炳《画山水序》语，四字朱文" />
        </label>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block">
            <span class="gb-label">边框式样</span>
            <select class="gb-input" bind:value={draft.borderStyle}>
              {#each BORDER_STYLE_OPTIONS as item (item.value)}
                <option value={item.value}>{item.label}</option>
              {/each}
            </select>
          </label>
          <label class="flex items-center gap-2 pt-5">
            <input type="checkbox" bind:checked={draft.adopted} />
            <span class="text-sm text-ink">标记为采用稿</span>
          </label>
        </div>
        <label class="block">
          <span class="gb-label">章法备注</span>
          <textarea class="gb-input" rows="2" bind:value={draft.layoutNote} placeholder="如：四字均分，「观」字略收以让边"></textarea>
        </label>
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (dialogOpen = false)}>取消</button>
        <button class="gb-btn-primary" onclick={() => void submit()}>保存</button>
      </div>
    </div>
  </div>
{/if}

{#if pendingDelete}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
    <div class="w-full max-w-md rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="text-lg text-ink">删除印稿</h3>
      <p class="mt-2 text-sm text-ink-soft">
        将同时删除「{pendingDelete.sealText}」的刻制工序、钤印记录与谱录条目，不可恢复。
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (pendingDelete = null)}>取消</button>
        <button class="gb-btn-primary" onclick={() => void confirmDelete()}>确认删除</button>
      </div>
    </div>
  </div>
{/if}

{#if recarveOpen && recarveSource}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
    <div class="w-full max-w-lg rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="mb-1 text-lg text-ink">换稿再刻：建立独立新版</h3>
      <p class="mb-3 text-xs text-ink-soft">
        基于「{recarveSource.sealText}」{designRevisionLabel(recarveSource)} 再刻。旧稿、旧工序、旧钤印与印谱条目保留在印石历史；新版复制旧工序为待办、不继承旧钤印，刻完并登记钤印后才切换。
      </p>
      {#if formError}
        <div class="mb-3 rounded-xl border border-amber-400/50 bg-amber-400/10 px-3 py-2 text-sm" style="color:#b98a3c">
          {formError}
        </div>
      {/if}
      <div class="space-y-3">
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block">
            <span class="gb-label">印文</span>
            <input class="gb-input" bind:value={recarveDraft.sealText} placeholder="如：澄怀观道" />
          </label>
          <label class="block">
            <span class="gb-label">朱文 / 白文</span>
            <select class="gb-input" bind:value={recarveDraft.style}>
              {#each DESIGN_STYLE_OPTIONS as item (item.value)}
                <option value={item.value}>{item.label}</option>
              {/each}
            </select>
          </label>
        </div>
        <label class="block">
          <span class="gb-label">释文</span>
          <input class="gb-input" bind:value={recarveDraft.annotation} placeholder="如：换朱文本，取法汉铸印" />
        </label>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block">
            <span class="gb-label">边框式样</span>
            <select class="gb-input" bind:value={recarveDraft.borderStyle}>
              {#each BORDER_STYLE_OPTIONS as item (item.value)}
                <option value={item.value}>{item.label}</option>
              {/each}
            </select>
          </label>
          <div class="flex items-end pb-1 text-xs text-ink-soft">
            新版将为第 {recarveSource.revision + 1} 版
          </div>
        </div>
        <label class="block">
          <span class="gb-label">章法备注</span>
          <textarea class="gb-input" rows="2" bind:value={recarveDraft.layoutNote} placeholder="如：改朱文后笔画细挺，边框收紧"></textarea>
        </label>
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (recarveOpen = false)}>取消</button>
        <button class="gb-btn-primary" onclick={() => void submitRecarve()}>建立再刻版</button>
      </div>
    </div>
  </div>
{/if}

{#if staleOpen}
  <StaleConfirm
    message={staleMessage}
    onReload={reloadAll}
    onCancel={() => {
      staleOpen = false;
      dialogOpen = false;
      recarveOpen = false;
    }}
  />
{/if}
