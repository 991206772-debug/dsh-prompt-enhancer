/**
 * dsh-prompt-enhancer — Web Client half.
 *
 * 在 conversation.input.right（输入框右侧，list 型 slot）注册一个 ✨「增强提示词」按钮：
 *  - 点击把当前草稿 POST 给 Host 的 /prompt-enhancer/enhance；
 *  - 用返回结果 inputActions.setDraft() 整段写回输入框，绝不自动发送；
 *  - 有 loading 态、失败内联提示、二次点击还原上一版草稿（undo）、空草稿禁用；
 *  - 颜色一律走 --dsw-alias-* 主题 token，亮/暗主题自动跟随。
 * 只 require('react')，不引用任何 @deepseek-ai/* 客户端包。
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-enhancer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useRef } = React;

    const ENDPOINT = '/prompt-enhancer/enhance';
    const CLIENT_TIMEOUT_MS = 70000;
    const MAX_DRAFT_CHARS = 8000;

    /* ───────────────────────────── 文案（按用户要求锁定默认全中文） ───────────────────────────── */

    const MESSAGES = {
      button: '增强提示词',
      loading: '增强中…',
      undo: '还原原稿',
      doneHint: '已写回输入框',
      restored: '已还原原稿',
      emptyHint: '先输入草稿再增强',
      tooLong: '草稿超过 8000 字符，请先精简',
      draftChanged: '草稿已变更，未覆盖你的编辑',
      writeFailed: '写回输入框失败',
      timeout: '请求超时，请重试',
      network: '无法连接 Host 路由',
      failed: '增强失败',
    };

    const t = (key) => MESSAGES[key] || key;

    /* ───────────────────────────── 输入框读写 ───────────────────────────── */

    /**
     * DOM 兜底读取：当 Hook 尚未更新或在复杂渲染时隙时，从输入框的 contenteditable 容器直读。
     */
    function getDomDraft() {
      try {
        if (typeof document === 'undefined') return '';
        const el = document.querySelector('[data-lexical-editor="true"], .dsh-composer-input, [contenteditable="true"]');
        return el ? (el.innerText || el.textContent || '').replace(/\r\n/g, '\n') : '';
      } catch {
        return '';
      }
    }

    function writeDraft(inputActions, text) {
      if (!inputActions || typeof inputActions.setDraft !== 'function') return false;
      try {
        inputActions.setDraft(text);
        return true;
      } catch {
        return false;
      }
    }

    async function requestEnhancedPrompt(draft) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS) : null;
      let response;
      try {
        response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-dsh-prompt-enhancer': '1',
          },
          body: JSON.stringify({ draft }),
          signal: controller ? controller.signal : undefined,
        });
      } catch (error) {
        const aborted = error && (error.name === 'AbortError' || error.name === 'TimeoutError');
        throw new Error(aborted ? t('timeout') : `${t('network')}: ${error && error.message ? error.message : error}`);
      } finally {
        if (timer) clearTimeout(timer);
      }

      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok || !data || data.ok !== true) {
        const message =
          (data && data.error && (data.error.message || data.error.code)) || `${t('failed')} (HTTP ${response.status})`;
        throw new Error(message);
      }
      if (typeof data.prompt !== 'string' || data.prompt.trim().length === 0) {
        throw new Error(`${t('failed')}: empty result`);
      }
      return data.prompt;
    }

    /* ───────────────────────────── 样式（主题 token） ───────────────────────────── */

    const CSS = [
      '.dsh-pe{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;flex:none}',
      '.dsh-pe-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;box-sizing:border-box;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:8px;background:transparent;',
      'color:var(--dsw-alias-label-secondary,#8a8f98);font:inherit;font-size:12px;line-height:1;white-space:nowrap;',
      'cursor:pointer;transition:background .12s,border-color .12s,color .12s}',
      '.dsh-pe-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));',
      'border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.45));color:var(--dsw-alias-label-primary,#e6e8eb)}',
      '.dsh-pe-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-accent,rgba(127,127,127,.18))}',
      '.dsh-pe-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:1px}',
      '.dsh-pe-btn:disabled{opacity:.45;cursor:default}',
      '.dsh-pe-btn.is-undo{border-color:var(--dsw-alias-brand-primary,rgba(59,130,246,.6));',
      'color:var(--dsw-alias-brand-primary,#3b82f6)}',
      '.dsh-pe-btn.is-undo:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-accent,rgba(127,127,127,.18))}',
      '.dsh-pe-note{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;line-height:16px;',
      'color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.dsh-pe-note.is-error{color:var(--dsw-alias-state-error-primary,#f0616b)}',
      '.dsh-pe-note.is-ok{color:var(--dsw-alias-state-success-primary,#35c46a)}',
      '.dsh-pe-spin{display:inline-block;width:11px;height:11px;border-radius:50%;border:1.5px solid currentColor;',
      'border-top-color:transparent;animation:dsh-pe-spin .7s linear infinite}',
      '@keyframes dsh-pe-spin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion: reduce){.dsh-pe-spin{animation:none}}',
    ].join('');

    function SparkleIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 13,
          height: 13,
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block', flex: 'none' },
        },
        h('path', {
          d: 'M8 1.4l1.5 4.1 4.1 1.5-4.1 1.5L8 12.6 6.5 8.5 2.4 7l4.1-1.5L8 1.4z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M13 10.4l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9z',
          fill: 'currentColor',
          opacity: 0.75,
        }),
      );
    }

    function UndoIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 13,
          height: 13,
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block', flex: 'none' },
        },
        h('path', {
          d: 'M6.2 3.4a5.2 5.2 0 11-4.4 8.7l1.5-1.1a3.4 3.4 0 102.9-5.7h-1V3.4h1z',
          fill: 'currentColor',
        }),
        h('path', { d: 'M6.9 1.3L3.2 4.3l3.7 3V1.3z', fill: 'currentColor' }),
      );
    }

    /* ───────────────────────────── 组件 ───────────────────────────── */

    function PromptEnhancer(props) {
      const inputActions = props ? props.inputActions : null;
      const useInput = props ? props.useInput : null;
      const canAct = Boolean(inputActions && typeof inputActions.setDraft === 'function');

      // 实时订阅草稿：useInput((s) => s?.draft ?? '') 是 DSH composer 标准渠道
      let hookDraft = '';
      if (typeof useInput === 'function') {
        try {
          const val = useInput((state) => (state && typeof state.draft === 'string' ? state.draft : ''));
          if (typeof val === 'string') hookDraft = val;
        } catch {
          hookDraft = '';
        }
      }
      // 取 Hook 订阅值或 DOM 兜底
      const draft = hookDraft || getDomDraft();
      const draftRef = useRef(draft);
      draftRef.current = draft;

      const [phase, setPhase] = useState('idle'); // idle | loading | done | error
      const [note, setNote] = useState('');
      const [noteKind, setNoteKind] = useState('info');
      const undoRef = useRef(null);

      const undo = undoRef.current;
      const undoAvailable = Boolean(undo && typeof undo.after === 'string' && draft.trim() === undo.after.trim());
      const loading = phase === 'loading';
      const disabled = !canAct || loading || (draft.trim().length === 0 && !undoAvailable);

      const notify = (kind, text) => {
        setNoteKind(kind);
        setNote(text);
      };

      const onClick = async () => {
        if (!canAct || loading) return;
        // 点击时读取真实最新草稿（优先 draftRef，再取 DOM 兜底）
        const current = (draftRef.current || getDomDraft() || '').trim();

        // 第二次点击：草稿仍是我们刚写回的那一版 → 还原增强前的草稿。
        if (undoRef.current && current === undoRef.current.after.trim()) {
          const previous = undoRef.current.before;
          undoRef.current = null;
          if (writeDraft(inputActions, previous)) {
            setPhase('idle');
            notify('ok', t('restored'));
          } else {
            setPhase('error');
            notify('error', t('writeFailed'));
          }
          return;
        }

        if (current.length === 0) {
          setPhase('error');
          notify('error', t('emptyHint'));
          return;
        }
        if (current.length > MAX_DRAFT_CHARS) {
          setPhase('error');
          notify('error', t('tooLong'));
          return;
        }

        undoRef.current = null;
        setPhase('loading');
        notify('info', '');
        let enhanced;
        try {
          enhanced = await requestEnhancedPrompt(current);
        } catch (error) {
          setPhase('error');
          notify('error', error && error.message ? error.message : String(error));
          return; // 草稿一字未动
        }

        // 请求期间用户改了草稿：绝不覆盖更晚的手工编辑。
        const latest = (draftRef.current || getDomDraft() || '').trim();
        if (latest !== current) {
          setPhase('error');
          notify('error', t('draftChanged'));
          return;
        }
        if (!writeDraft(inputActions, enhanced)) {
          setPhase('error');
          notify('error', t('writeFailed'));
          return;
        }
        undoRef.current = { before: current, after: enhanced };
        setPhase('done');
        notify('ok', t('doneHint'));
      };

      const label = loading ? t('loading') : undoAvailable ? t('undo') : t('button');
      const buttonClass = `dsh-pe-btn${undoAvailable && !loading ? ' is-undo' : ''}`;
      const noteClass = `dsh-pe-note${noteKind === 'error' ? ' is-error' : noteKind === 'ok' ? ' is-ok' : ''}`;

      const children = [
        h(
          'button',
          {
            key: 'btn',
            type: 'button',
            className: buttonClass,
            title: disabled && !loading ? t('emptyHint') : t('button'),
            'aria-label': t('button'),
            'aria-busy': loading ? 'true' : 'false',
            disabled,
            onClick,
          },
          loading ? h('span', { className: 'dsh-pe-spin', 'aria-hidden': true }) : undoAvailable ? h(UndoIcon) : h(SparkleIcon),
          h('span', null, label),
        ),
      ];
      if (note) {
        children.push(
          h('span', { key: 'note', className: noteClass, role: 'status', title: note }, note),
        );
      }

      return h(
        React.Fragment,
        null,
        h('style', { key: 'css', type: 'text/css' }, CSS),
        h('span', { className: 'dsh-pe' }, children),
      );
    }

    /* ───────────────────────────── 注册 ───────────────────────────── */

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() =>
          ctx.slots.inject('conversation.input.right', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.right',
                id: 'prompt-enhancer',
                order: 30,
                label: '增强提示词',
              },
              PromptEnhancer,
            ),
          ),
        );
      },
    };
  },
});
