<script lang="ts">
  /**
   * <StaleConfirm> 保存前重新确认对话框
   * 另一标签页同时改了采用稿或补了钤印时，本页持有的记录版本已过期（StaleVersionError）。
   * 用户确认后先重新载入最新数据，再按原意图重试保存。
   */
  interface Props {
    /** 失效说明（可指明哪条记录） */
    message?: string;
    /** 重新载入最新数据 */
    onReload: () => void | Promise<void>;
    /** 关闭并放弃本次保存 */
    onCancel: () => void;
  }

  let { message = '', onReload, onCancel }: Props = $props();
</script>

<div class="fixed inset-0 z-[60] grid place-items-center bg-black/40 px-4">
  <div class="w-full max-w-md rounded-xl border border-seal/40 bg-paper-light p-5 shadow-xl">
    <h3 class="text-lg text-ink">页面记录已过期</h3>
    <p class="mt-2 text-sm leading-relaxed text-ink-soft">
      另一标签页已同时修改了采用稿或补记了钤印，当前页面的旧版本已失效。
      {message ? `（${message}）` : ''}
      请先重新载入最新内容确认，再决定是否仍要保存；本次改动尚未写入。
    </p>
    <div class="mt-5 flex justify-end gap-2">
      <button class="gb-btn" onclick={() => onCancel()}>放弃保存</button>
      <button
        class="gb-btn-primary"
        onclick={() => {
          void Promise.resolve(onReload()).then(() => onCancel());
        }}>
        重新确认并载入
      </button>
    </div>
  </div>
</div>
