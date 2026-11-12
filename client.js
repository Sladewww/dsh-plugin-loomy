/**
 * Loomy 网关 DSH 插件 · Client 半侧
 *
 * 静态 bundle 没有 host.call，Client→Host 走同源 HTTP 路由 /__loomy/v2/api/*。
 * 左侧栏入口 = sidebar.panellist（只画图标，shell 自己画按钮并 selectPanel）
 *            + main（keyed，key 必须等于 sidebar 的 id）。
 * 纯 React.createElement，无 JSX / 无构建 / 无第三方模块。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-loomy',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'loomy-gateway';
    const API = '/__loomy/v2/api';

    // ------------------------------------------------------------ 主题
    // 全部颜色走宿主的 --dsw-alias-* token（Theme.listTokens 报告这些 token
    // requiresLightAndDark=true，宿主切换明暗时会自动换值）。不写固定深/浅色，
    // 面板因此跟随宿主主题；color-scheme 保持 inherit，原生控件也跟着走。
    const v = (name, fallback) => `var(${name}, ${fallback})`;
    const C = {
      base: v('--dsw-alias-bg-base', 'transparent'),
      panel: v('--dsw-alias-bg-layer-1', 'transparent'),
      raised: v('--dsw-alias-bg-layer-2', 'transparent'),
      hover: v('--dsw-alias-bg-overlay', 'transparent'),
      primary: v('--dsw-alias-label-primary', 'inherit'),
      secondary: v('--dsw-alias-label-secondary', 'inherit'),
      tertiary: v('--dsw-alias-state-idle-primary', 'inherit'),
      border: v('--dsw-alias-border-l1', 'currentColor'),
      borderStrong: v('--dsw-alias-border-l2', 'currentColor'),
      danger: v('--dsw-alias-state-error-primary', 'inherit'),
      ok: v('--dsw-alias-state-success-primary', 'inherit'),
      warn: v('--dsw-alias-state-warn-primary', 'inherit'),
      brand: v('--dsw-alias-brand-primary', 'currentColor'),
      onBrand: v('--dsw-alias-bg-base', 'inherit'),
    };
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    // 组件级样式：只处理原生控件无法用内联样式表达的部分（滚动条 /
    // placeholder / 自动填充 / select option / 焦点环）。颜色一律用 token，
    // 不强制 color-scheme，随宿主明暗切换。随面板挂载而生效、卸载而移除。
    const PANEL_CSS = [
      '[data-loomy-panel],[data-loomy-panel] *{scrollbar-color:var(--dsw-alias-border-l2,currentColor) transparent;scrollbar-width:thin}',
      '[data-loomy-panel] *::-webkit-scrollbar{width:9px;height:9px}',
      '[data-loomy-panel] *::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,currentColor);border-radius:6px;border:2px solid transparent;background-clip:padding-box}',
      '[data-loomy-panel] *::-webkit-scrollbar-track{background:transparent}',
      '[data-loomy-panel] input::placeholder,[data-loomy-panel] textarea::placeholder{color:var(--dsw-alias-state-idle-primary,currentColor);opacity:1}',
      '[data-loomy-panel] input::-webkit-outer-spin-button,[data-loomy-panel] input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}',
      '[data-loomy-panel] input[type=number]{-moz-appearance:textfield;appearance:textfield}',
      '[data-loomy-panel] input:-webkit-autofill,',
      '[data-loomy-panel] input:-webkit-autofill:hover,',
      '[data-loomy-panel] input:-webkit-autofill:focus{-webkit-text-fill-color:var(--dsw-alias-label-primary,inherit);box-shadow:0 0 0 1000px var(--dsw-alias-bg-layer-2,transparent) inset;caret-color:var(--dsw-alias-label-primary,inherit)}',
      '[data-loomy-panel] select option{background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary,inherit)}',
      '[data-loomy-panel] button:focus-visible,',
      '[data-loomy-panel] input:focus-visible,',
      '[data-loomy-panel] select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,currentColor);outline-offset:1px}',
    ].join('\n');

    const S = {
      root: {
        boxSizing: 'border-box', height: '100%', overflow: 'auto',
        padding: '20px 24px 40px', color: C.primary, background: C.base,
        fontSize: 'var(--dsh-content-font-size, 13px)', lineHeight: 1.55,
        display: 'flex', flexDirection: 'column', gap: 16,
      },
      header: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
      h1: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: 1.4, color: C.primary },
      sub: { margin: 0, color: C.tertiary, fontSize: 12 },
      tabs: { display: 'flex', gap: 4, borderBottom: '1px solid ' + C.border, paddingBottom: 0 },
      tab: {
        font: 'inherit', fontSize: 13, padding: '6px 14px', border: 'none',
        background: 'transparent', color: C.secondary, cursor: 'pointer',
        borderBottom: '2px solid transparent', marginBottom: -1, borderRadius: '5px 5px 0 0',
      },
      tabOn: { color: C.primary, background: C.panel, borderBottomColor: C.brand, fontWeight: 600 },
      card: {
        border: '1px solid ' + C.border, borderRadius: 8, background: C.panel,
        padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10,
      },
      cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
      h3: { margin: 0, fontSize: 13, fontWeight: 600, color: C.primary },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '6px 18px' },
      metaItem: { display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0, fontSize: 12 },
      metaLabel: { color: C.tertiary, flex: 'none' },
      mono: { fontFamily: MONO, fontSize: 12, color: C.secondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      hint: { color: C.tertiary, fontSize: 12 },
      btn: {
        font: 'inherit', fontSize: 12, lineHeight: '20px', padding: '3px 12px',
        borderRadius: 5, border: '1px solid ' + C.borderStrong, background: C.raised,
        color: C.primary, cursor: 'pointer', whiteSpace: 'nowrap',
      },
      btnPrimary: {
        font: 'inherit', fontSize: 12, lineHeight: '20px', padding: '3px 14px',
        borderRadius: 5, border: '1px solid ' + C.brand, background: C.brand,
        color: C.onBrand, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: 600,
      },
      btnOff: { color: C.tertiary, cursor: 'not-allowed', opacity: 0.5 },
      input: {
        boxSizing: 'border-box', padding: '4px 8px', border: '1px solid ' + C.borderStrong,
        borderRadius: 5, background: C.raised, color: C.primary, font: 'inherit',
        fontSize: 12, lineHeight: '20px', outline: 'none', minWidth: 140,
      },
      select: {
        boxSizing: 'border-box', padding: '4px 8px', border: '1px solid ' + C.borderStrong,
        borderRadius: 5, background: C.raised, color: C.primary, font: 'inherit',
        fontSize: 12, lineHeight: '20px', outline: 'none',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid ' + C.borderStrong, color: C.tertiary, fontWeight: 500 },
      td: { padding: '6px 8px', borderBottom: '1px solid ' + C.border, color: C.primary, verticalAlign: 'middle' },
      badge: {
        display: 'inline-block', padding: '0 7px', borderRadius: 10, fontSize: 11,
        lineHeight: '18px', border: '1px solid ' + C.borderStrong, color: C.secondary,
        background: C.raised,
      },
      pre: {
        margin: 0, padding: 10, background: C.raised, border: '1px solid ' + C.border,
        borderRadius: 6, fontFamily: MONO, fontSize: 11, lineHeight: 1.5,
        color: C.secondary,
        whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 220, overflow: 'auto',
      },
      err: { color: C.danger, fontSize: 12, whiteSpace: 'pre-wrap' },
      ok: { color: C.ok, fontSize: 12, whiteSpace: 'pre-wrap' },
      warn: { color: C.warn, fontSize: 12, whiteSpace: 'pre-wrap' },
      pillOn: { color: C.ok, fontWeight: 600 },
      pillOff: { color: C.tertiary, fontWeight: 600 },
    };

    // ------------------------------------------------------- 统一请求封装
    async function api(path, options) {
      try {
        const res = await fetch(API + '/' + path, options);
        let body = null;
        try { body = await res.json(); } catch (e) { body = null; }
        if (!res.ok || (body && body.ok === false)) {
          return { ok: false, message: (body && body.message) || 'HTTP ' + res.status, data: body && body.data };
        }
        return { ok: true, data: body && body.data !== undefined ? body.data : body };
      } catch (e) {
        return { ok: false, message: '请求失败：' + (e && e.message ? e.message : e) };
      }
    }
    const get = (path) => api(path, { method: 'GET' });
    const post = (path, payload) => api(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });

    function shortNum(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return '—';
      if (Math.abs(n) >= 10000) return (n / 1000).toFixed(1) + 'K';
      return String(n);
    }

    // ------------------------------------------------------------- 左侧栏图标
    function LoomyIcon(props) {
      const size = (props && props.size) || 16;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true,
        style: { display: 'block' },
      },
        h('rect', { x: 1, y: 1, width: 14, height: 14, rx: 4, fill: C.brand, opacity: 0.95 }),
        h('path', { d: 'M4.5 5.5h7M4.5 8h7M4.5 10.5h4.5', stroke: C.onBrand, strokeWidth: 1.5, strokeLinecap: 'round', fill: 'none' }),
        h('circle', { cx: 11.5, cy: 10.5, r: 1.7, fill: C.onBrand }),
      );
    }

    // ---------------------------------------------------------------- 主面板
    function LoomyPanel() {
      const [tab, setTab] = React.useState('service');
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [status, setStatus] = React.useState(null);
      const [config, setConfig] = React.useState(null);
      const [state, setState] = React.useState(null);
      const [models, setModels] = React.useState([]);
      const [synced, setSynced] = React.useState(null);
      const [logs, setLogs] = React.useState([]);
      const [testResult, setTestResult] = React.useState('');
      const [cfgDraft, setCfgDraft] = React.useState(null);
      const [addDraft, setAddDraft] = React.useState(null);
      // 客户端登录态扫描结果 / 勾选集合 / 自定义扫描根目录
      const [clientScan, setClientScan] = React.useState(null);
      const [clientSelected, setClientSelected] = React.useState([]);
      const [clientRootDraft, setClientRootDraft] = React.useState('');

      const flash = (msg, kind) => {
        setError(kind === 'error' ? msg : '');
        setNotice(kind === 'error' ? '' : msg);
      };

      async function loadAll(showBusy) {
        if (showBusy) setBusy('refresh');
        const [st, cfg, stt, md, sy, lg] = await Promise.all([
          get('status'), get('config'), get('state'), get('models'), get('synced'), get('logs?lines=80'),
        ]);
        if (st.ok) setStatus(st.data);
        if (cfg.ok) {
          setConfig(cfg.data);
          setCfgDraft(cfg.data);
          setClientRootDraft((prev) => (prev === '' ? (cfg.data.clientRoot || '') : prev));
        }
        if (stt.ok) setState(stt.data); else setState(null);
        if (md.ok) setModels(md.data.models || []); else setModels([]);
        if (sy.ok) setSynced(sy.data); else setSynced(null);
        if (lg.ok) setLogs((lg.data && lg.data.lines) || []);
        if (!st.ok) setError(st.message);
        setBusy('');
      }

      React.useEffect(() => { loadAll(false); }, []);

      async function act(label, fn) {
        setBusy(label); setError(''); setNotice('');
        try {
          const res = await fn();
          if (!res.ok) { flash(res.message || '操作失败', 'error'); return; }
          flash(res.data && res.data.message ? res.data.message : '操作完成', 'ok');
          await loadAll(false);
          return res;
        } finally { setBusy(''); }
      }

      const running = !!(status && status.running);

      // ---- 通用小组件 ----
      const meta = (label, value) => h('span', { style: S.metaItem, key: label },
        h('span', { style: S.metaLabel }, label),
        h('span', { style: S.mono }, String(value === undefined || value === null || value === '' ? '—' : value)));

      const btn = (key, label, onClick, opts) => {
        const primary = !!(opts && opts.primary);
        const disabled = !!(opts && opts.disabled) || !!busy;
        const base = primary ? S.btnPrimary : S.btn;
        return h('button', {
          key, type: 'button',
          style: { ...base, ...(disabled ? S.btnOff : {}) },
          disabled,
          onMouseEnter: (e) => { if (!disabled) e.currentTarget.style.background = primary ? C.brand : C.hover; },
          onMouseLeave: (e) => { e.currentTarget.style.background = primary ? C.brand : C.raised; },
          onClick,
        }, label);
      };

      const card = (key, title, right, children) => h('div', { key, style: S.card },
        h('div', { style: S.cardHead }, h('span', { style: S.h3 }, title), right || null),
        ...children);

      // ---- 服务页 ----
      function serviceView() {
        const st = status || {};
        return [
          card('svc-state', '服务状态',
            h('span', {
              style: { ...S.badge, color: running ? C.ok : C.tertiary },
            }, running ? '● 运行中' : '○ 已停止'),
            [
              h('div', { style: S.row, key: 'actions' },
                btn('start', '启动', () => act('start', () => post('start')), { primary: !running, disabled: running }),
                btn('stop', '停止', () => act('stop', () => post('stop')), { disabled: !running }),
                btn('refresh', '刷新', () => loadAll(true))),
              h('div', { style: S.grid, key: 'meta' },
                meta('端口', st.port), meta('PID', st.pid),
                meta('Python', st.pythonPath), meta('数据目录', st.dataDir),
                meta('策略', st.strategy), meta('默认模型', st.defaultModel),
                meta('路由 ID', st.providerRoute), meta('启动于', st.startedAt ? new Date(st.startedAt).toLocaleString() : '—')),
              st.error ? h('div', { style: S.err, key: 'err', role: 'alert' }, st.error) : null,
              h('div', { key: 'hint', style: S.hint },
                '网关只监听 127.0.0.1，账号与日志保存在数据目录。修改端口 / Python 路径 / 策略后需停止再启动。'),
            ]),
          card('svc-health', '网关健康', null, [
            h('div', { key: 'health', style: S.grid },
              meta('账号数', state && state.totals ? state.totals.accounts : '—'),
              meta('可用账号', state && state.totals ? state.totals.usable : '—'),
              meta('可用额度', state && state.totals ? shortNum(state.totals.available) : '—'),
              meta('上游模型', state && state.config ? state.config.models : '—'),
              meta('累计请求', state && state.totals ? state.totals.requests : '—'),
              meta('消耗点数', state && state.totals ? shortNum(state.totals.points_used) : '—')),
            !running ? h('div', { key: 'off', style: S.hint }, '网关未启动，无法读取实时状态。') : null,
          ]),
          card('svc-logs', '网关日志（末尾 80 行）',
            btn('log-refresh', '刷新日志', async () => { const r = await get('logs?lines=80'); if (r.ok) setLogs((r.data && r.data.lines) || []); }),
            [h('pre', { key: 'pre', style: S.pre }, logs.length ? logs.join('\n') : (st.tail || []).join('\n') || '（暂无日志）')]),
        ];
      }

      // ---- 模型页 ----
      function modelsView() {
        const syncList = (synced && synced.models) || [];
        const enabled = (synced && synced.enabledModels) || [];
        const isOn = (id) => enabled.includes(id);
        const enabledCount = models.filter((m) => isOn(m.id)).length;

        // 单个开关：立即写 Config（cordis.patch.yml）+ 同步 pi-ai。
        // 因 configEditor.edit 会重启插件，写完做一次延迟刷新。
        const toggleOne = (id, next) => act('toggle', async () => {
          const r = await post('modelToggle', { id, enabled: next });
          if (r.ok) {
            // 乐观更新，避免重启期间 UI 闪烁
            setSynced((s) => ({ ...(s || {}), enabledModels: next ? [...(s.enabledModels || []), id] : (s.enabledModels || []).filter((x) => x !== id) }));
          }
          return r;
        });

        const switchStyle = (on) => ({
          position: 'relative', display: 'inline-block', width: 34, height: 18,
          borderRadius: 9, border: '1px solid ' + (on ? C.brand : C.borderStrong),
          background: on ? C.brand : C.raised, cursor: busy ? 'not-allowed' : 'pointer',
          padding: 0, verticalAlign: 'middle', transition: 'background .15s',
        });
        const knobStyle = (on) => ({
          position: 'absolute', top: 2, left: on ? 17 : 2, width: 12, height: 12,
          borderRadius: '50%', background: on ? C.onBrand : C.tertiary,
          transition: 'left .15s',
        });
        const Switch = (id, on) => h('button', {
          key: 'sw-' + id, type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false',
          'aria-label': (on ? '停用 ' : '启用 ') + id,
          style: switchStyle(on), disabled: !!busy || !running,
          onClick: () => toggleOne(id, !on),
        }, h('span', { style: knobStyle(on) }));

        const modelRows = models.map((m) => h('tr', { key: m.id },
          h('td', { style: { ...S.td, fontFamily: MONO } }, m.id),
          h('td', { style: S.td }, m.name),
          h('td', { style: S.td }, m.contextWindow ? shortNum(m.contextWindow) : '—'),
          h('td', { style: S.td }, Switch(m.id, isOn(m.id)),
            h('span', { style: { marginLeft: 8, color: isOn(m.id) ? C.ok : C.tertiary, fontSize: 11 } }, isOn(m.id) ? '启用' : '停用'))));

        return [
          card('md-sync', '同步模型到 DSH',
            h('span', { style: S.row },
              btn('all-on', '全部启用', () => act('all-on', () => post('modelsEnabled', { ids: models.map((m) => m.id) })), { disabled: running === false }),
              btn('all-off', '全部停用', () => act('all-off', () => post('modelsEnabled', { ids: [] })), { disabled: running === false })),
            [
              h('div', { key: 'hint', style: S.hint },
                '启用的模型（当前 ' + enabledCount + '/' + models.length + '）会写入 dsh-llm-pi-ai 的 loomy 路由，出现在输入框的模型选择器里。' +
                '启用清单保存在本插件的 Config（profile 的 cordis.patch.yml），不需要去「设置 → 模型」手动改。'),
              h('div', { key: 'hint2', style: S.hint },
                '点「同步模型到 DSH」可刷新上游目录并把新增模型默认启用；全部停用会移除该路由。'),
              h('div', { key: 'syncrow', style: S.row },
                btn('sync', busy === 'sync' ? '同步中…' : '同步模型到 DSH', () => act('sync', () => post('sync')), { primary: true, disabled: running === false })),
              synced && synced.available === false
                ? h('div', { key: 'warn', style: S.warn }, '当前无法自动写入 pi-ai 配置（' + (synced.reason || '条目不可编辑') + '）。请检查「设置」里的诊断信息。')
                : null,
            ]),
          card('md-list', '模型启用开关（' + enabledCount + ' / ' + models.length + ' 已启用）', null, [
            models.length
              ? h('div', { style: { overflowX: 'auto' } },
                  h('table', { key: 'tbl', style: S.table },
                    h('thead', null, h('tr', null,
                      h('th', { style: S.th }, '模型 ID'), h('th', { style: S.th }, '显示名'),
                      h('th', { style: S.th }, '上下文'), h('th', { style: S.th }, '启用'))),
                    h('tbody', null, modelRows)))
              : h('div', { key: 'empty', style: S.hint }, '未读取到模型目录。请先启动网关，再点「同步模型到 DSH」。'),
          ]),
          card('md-synced', '已写入 DSH 的模型（' + syncList.length + '）', null, [
            syncList.length
              ? h('div', { key: 'list', style: S.row }, syncList.map((m) => h('span', { key: m.id, style: S.badge }, m.id)))
              : h('div', { key: 'none', style: S.hint }, enabledCount ? '尚未同步，点「同步模型到 DSH」。' : '全部停用，loomy 路由已移除。'),
          ]),
          card('md-test', '测试对话', null, [
            h('div', { key: 'row', style: S.row },
              btn('test', busy === 'test' ? '测试中…' : '测试对话', () => act('test', async () => {
                const r = await post('test', { model: config ? config.defaultModel : '' });
                if (r.ok) setTestResult(typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2));
                return r;
              }), { disabled: !running })),
            testResult ? h('pre', { key: 'out', style: S.pre }, testResult) : h('span', { key: 'hint', style: S.hint }, '会消耗账号点数；用于确认网关到上游的链路是否通畅。'),
          ]),
        ];
      }

      // ---- 账号池页 ----
      function accountTable(accounts) {
        const head = h('thead', null,
          h('tr', null,
            h('th', { style: S.th }, '名称'),
            h('th', { style: S.th }, '手机号'),
            h('th', { style: S.th }, '可用额度'),
            h('th', { style: S.th }, '会话天数'),
            h('th', { style: S.th }, '请求数'),
            h('th', { style: S.th }, '状态'),
            h('th', { style: S.th }, '操作')));
        const rows = accounts.map((a) => {
          const enabled = a.enabled !== false;
          const actionCells = h('span', { style: S.row },
            btn('t-' + a.name, enabled ? '停用' : '启用', () => act('toggle', () => post('account', { action: 'update', name: a.name, enabled: !enabled }))),
            btn('r-' + a.name, '续期', () => act('renew', () => post('account', { action: 'renew', name: a.name }))),
            btn('d-' + a.name, '删除', () => {
              if (typeof window !== 'undefined' && !window.confirm('确定删除账号 ' + a.name + '？')) return Promise.resolve({ ok: false, message: '已取消' });
              return act('remove', () => post('account', { action: 'remove', name: a.name }));
            }));
          return h('tr', { key: a.name },
            h('td', { style: { ...S.td, fontFamily: MONO } }, a.name),
            h('td', { style: S.td }, a.loginid_masked || a.loginid || '—'),
            h('td', { style: S.td }, shortNum(a.available)),
            h('td', { style: S.td }, a.session_days_left === undefined ? '—' : a.session_days_left),
            h('td', { style: S.td }, a.requests || 0),
            h('td', { style: S.td },
              h('span', { style: enabled ? S.pillOn : S.pillOff }, enabled ? '启用' : '停用'),
              a.last_error ? h('span', { key: 'e', style: { color: C.danger, marginLeft: 6 } }, '!') : null),
            h('td', { style: S.td }, actionCells));
        });
        return h('div', { key: 'table', style: { ...S.card, padding: 0, overflowX: 'auto' } },
          h('table', { style: S.table }, head, h('tbody', null, rows)));
      }

      // ---- 桌面客户端登录态扫描 ----
      const doClientScan = () => act('client-scan', async () => {
        const q = clientRootDraft ? '?root=' + encodeURIComponent(clientRootDraft) : '';
        const r = await get('clientScan' + q);
        if (r.ok) {
          setClientScan(r.data);
          // 默认勾选「未过期 且 尚未导入」的项
          setClientSelected((r.data.items || []).filter((it) => !it.expired && !it.alreadyImported).map((it) => it.token));
        }
        return r;
      });

      const doClientImport = () => act('client-import', async () => {
        const r = await post('clientImport', { tokens: clientSelected });
        if (r.ok) {
          setClientSelected([]);
          // 重新扫描一次，让「已导入」状态刷新
          const q = clientRootDraft ? '?root=' + encodeURIComponent(clientRootDraft) : '';
          const s = await get('clientScan' + q);
          if (s.ok) setClientScan(s.data);
        }
        return r;
      });

      const toggleClientToken = (token) => setClientSelected((prev) =>
        prev.includes(token) ? prev.filter((x) => x !== token) : [...prev, token]);

      function clientScanCard() {
        const items = (clientScan && clientScan.items) || [];
        const errors = (clientScan && clientScan.errors) || [];
        const selectable = items.filter((it) => !it.expired && !it.alreadyImported);
        const allSelected = selectable.length > 0 && selectable.every((it) => clientSelected.includes(it.token));
        return card('ac-scan', '扫描桌面客户端登录态',
          h('span', { style: S.row },
            btn('scan-root-toggle', clientRootDraft ? '自定义目录 ✓' : '默认目录',
              () => { /* 目录输入在下方表单里，这里只作状态提示 */ return Promise.resolve({ ok: true, data: {} }); }),
            btn('ac-scan-btn', busy === 'client-scan' ? '扫描中…' : '扫描客户端', doClientScan, { primary: true })),
          [
            h('div', { key: 'rootrow', style: S.row },
              h('label', { style: { ...S.metaItem, flex: 1, minWidth: 280 } }, '扫描根目录',
                h('input', {
                  style: { ...S.input, flex: 1, minWidth: 260 },
                  value: clientRootDraft,
                  placeholder: '留空 = C:\\Users\\Public\\Loomy',
                  onChange: (e) => setClientRootDraft(e.target.value),
                })),
              h('span', { key: 'hint', style: S.hint }, clientScan ? `上次扫描：${clientScan.root}` : '点「扫描客户端」读取 auth-session.json')),
            h('div', { key: 'notice', style: S.hint },
              '客户端只保留最后登录的一个账号：登录第二个会覆盖 auth-session.json。要导入多个账号，请逐个登录并分别扫描导入；已导入的持久账号不会因覆盖而丢失。'),
            errors.length
              ? h('div', { key: 'errs', style: S.warn }, errors.join('；'))
              : null,
            !clientScan
              ? h('div', { key: 'empty', style: S.hint },
                  '扫描本机 Loomy 桌面客户端的登录态，勾选后可一键导入为账号池里的持久账号（会写入 accounts.json，可启用/停用/续期）。')
              : items.length === 0
                ? h('div', { key: 'none', style: S.hint }, '未发现客户端登录态文件。')
                : h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    h('label', { key: 'all', style: { ...S.metaItem, cursor: 'pointer' } },
                      h('input', {
                        type: 'checkbox',
                        checked: allSelected,
                        onChange: () => setClientSelected(allSelected ? [] : selectable.map((it) => it.token)),
                      }),
                      h('span', { style: S.hint }, `全选可导入（${selectable.length}）`)),
                    items.map((it) => {
                      const blocked = it.expired || it.alreadyImported;
                      return h('label', {
                        key: it.token,
                        style: {
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '6px 8px', borderRadius: 6,
                          border: '1px solid ' + C.border, background: C.raised,
                          opacity: blocked ? 0.55 : 1, cursor: blocked ? 'not-allowed' : 'pointer',
                        },
                      },
                        h('input', {
                          type: 'checkbox', disabled: blocked,
                          checked: !it.alreadyImported && clientSelected.includes(it.token),
                          onChange: () => toggleClientToken(it.token),
                        }),
                        h('span', { style: { fontFamily: MONO, fontSize: 12, minWidth: 110 } }, it.phoneMasked),
                        h('span', { style: S.hint }, it.sessionMasked),
                        h('span', { style: { ...S.hint, marginLeft: 'auto' } },
                          it.alreadyImported ? '已导入' : it.expired ? '已过期' : (it.daysLeft === null ? '有效期未知' : `剩余 ${it.daysLeft} 天`)),
                      );
                    })),
            clientScan && items.length
              ? h('div', { key: 'actions', style: S.row },
                  btn('ac-import', busy === 'client-import' ? '导入中…' : `导入选中（${clientSelected.length}）`,
                    doClientImport, { primary: true, disabled: clientSelected.length === 0 }),
                  h('span', { key: 'tip', style: S.hint }, '导入为持久账号；同一 session 已存在会跳过。'))
              : null,
          ]);
      }

      function accountsView() {
        const accounts = (state && state.accounts) || [];
        const totals = (state && state.totals) || {};
        return [
          card('ac-head', '账号池（' + accounts.length + ' 个 / 可用 ' + (totals.usable || 0) + '）',
            h('span', { style: S.row },
              btn('ac-refresh', '刷新额度', () => act('refresh', () => post('refresh'))),
              btn('ac-add', '添加账号', () => setAddDraft({ name: '', loginid: '', password: '', session: '', login: true }), { primary: true })),
            [
              h('div', { key: 'sum', style: S.grid },
                meta('可用额度', shortNum(totals.available)),
                meta('累计请求', totals.requests),
                meta('消耗点数', shortNum(totals.points_used)),
                meta('路由策略', state && state.config ? state.config.strategy : '—')),
            ]),
          clientScanCard(),
          accounts.length
            ? accountTable(accounts)
            : h('div', { key: 'empty', style: S.card },
                h('div', { style: S.hint }, running ? '账号池为空。点「添加账号」用手机号+密码登录，或直接粘贴 session。' : '网关未启动，无法读取账号池。')),
          addDraft ? h('div', { key: 'add', style: S.card },
            h('span', { style: S.h3 }, '添加账号'),
            h('div', { style: S.grid },
              h('label', { style: S.metaItem }, '名称', h('input', { style: S.input, value: addDraft.name, placeholder: 'main', onChange: (e) => setAddDraft({ ...addDraft, name: e.target.value }) })),
              h('label', { style: S.metaItem }, '手机号', h('input', { style: S.input, value: addDraft.loginid, placeholder: '13800000000', onChange: (e) => setAddDraft({ ...addDraft, loginid: e.target.value }) })),
              h('label', { style: S.metaItem }, '密码', h('input', { style: S.input, type: 'password', value: addDraft.password, placeholder: '讯飞账号中心设置的密码', onChange: (e) => setAddDraft({ ...addDraft, password: e.target.value }) })),
              h('label', { style: S.metaItem }, '或 session', h('input', { style: S.input, value: addDraft.session, placeholder: '32 位 session（可留空）', onChange: (e) => setAddDraft({ ...addDraft, session: e.target.value }) }))),
            h('div', { style: S.row },
              btn('add-ok', '保存并登录', () => {
                if (!addDraft.name.trim()) { flash('账号名不能为空', 'error'); return Promise.resolve({ ok: false }); }
                return act('add', async () => {
                  const r = await post('account', { action: 'add', ...addDraft });
                  if (r.ok) setAddDraft(null);
                  return r;
                });
              }, { primary: true }),
              btn('add-cancel', '取消', () => { setAddDraft(null); return Promise.resolve({ ok: true, data: {} }); }))) : null,
        ];
      }

      // ---- 设置页 ----
      function settingsView() {
        const d = cfgDraft || {};
        const set = (key, value) => setCfgDraft({ ...d, [key]: value });
        return [
          card('cfg', '网关设置', null, [
            h('div', { key: 'grid', style: S.grid },
              h('label', { style: S.metaItem, key: 'port' }, '端口',
                h('input', { style: S.input, type: 'number', value: d.port === undefined ? '' : d.port, onChange: (e) => set('port', e.target.value) })),
              h('label', { style: S.metaItem, key: 'py' }, 'Python 路径',
                h('input', { style: S.input, value: d.pythonPath || '', placeholder: '留空自动探测 python / python3', onChange: (e) => set('pythonPath', e.target.value) })),
              h('label', { style: S.metaItem, key: 'strategy' }, '路由策略',
                h('select', { style: S.select, value: d.strategy || 'balance', onChange: (e) => set('strategy', e.target.value) },
                  h('option', { value: 'balance' }, 'balance · 余额优先'),
                  h('option', { value: 'round_robin' }, 'round_robin · 轮询'),
                  h('option', { value: 'lru' }, 'lru · 最近最少使用'))),
              h('label', { style: S.metaItem, key: 'model' }, '默认模型',
                h('input', { style: S.input, value: d.defaultModel || '', onChange: (e) => set('defaultModel', e.target.value) })),
              h('label', { style: S.metaItem, key: 'route' }, 'DSH 路由 ID',
                h('input', { style: S.input, value: d.providerRoute || '', onChange: (e) => set('providerRoute', e.target.value) })),
              h('label', { style: S.metaItem, key: 'auto' }, '自动启动',
                h('select', { style: S.select, value: String(!!d.autoStart), onChange: (e) => set('autoStart', e.target.value === 'true') },
                  h('option', { value: 'false' }, '否'), h('option', { value: 'true' }, '是')))),
            h('div', { key: 'actions', style: S.row },
              btn('cfg-save', '保存设置', () => act('save', () => post('config', d)), { primary: true }),
              btn('cfg-reset', '放弃修改', () => { setCfgDraft(config); return Promise.resolve({ ok: true, data: {} }); })),
            h('div', { key: 'hint', style: S.hint },
              '端口 / Python 路径 / 策略变更需重启网关才生效。账号密码按上游设计明文存于数据目录的 accounts.json，请妥善保护该目录，仅用于你自己的账号。'),
          ]),
          card('cfg-diag', '诊断信息', btn('diag', '读取环境', async () => {
            const r = await get('diagnose');
            if (r.ok) flash(JSON.stringify(r.data, null, 2), 'ok'); else flash(r.message, 'error');
          }), [
            h('div', { key: 'grid', style: S.grid },
              meta('数据目录', config ? config.dataDir : '—'),
              meta('网关源码', status ? status.gatewayDir : '—'),
              meta('configEditor', '见下方诊断输出')),
            notice ? h('pre', { key: 'diag-out', style: S.pre }, notice) : null,
          ]),
        ];
      }

      const views = {
        service: serviceView,
        models: modelsView,
        accounts: accountsView,
        settings: settingsView,
      };
      const TabButton = (key, label) => h('button', {
        key, type: 'button', style: { ...S.tab, ...(tab === key ? S.tabOn : {}) },
        onClick: () => setTab(key),
      }, label);

      return h('div', { style: S.root, 'data-loomy-panel': '' },
        h('div', { style: S.header },
          h(LoomyIcon, { size: 22 }),
          h('div', null,
            h('div', { style: S.h1 }, 'Loomy 网关'),
            h('div', { style: S.sub }, '本机 OpenAI / Anthropic 兼容网关 · 账号池 · DSH 模型同步'))),
        h('div', { style: S.tabs },
          TabButton('service', '服务'), TabButton('models', '模型'),
          TabButton('accounts', '账号池'), TabButton('settings', '设置')),
        error ? h('div', { style: S.err, role: 'alert' }, error) : null,
        notice && tab !== 'settings' ? h('div', { style: S.ok, role: 'status' }, notice) : null,
        busy ? h('div', { style: S.hint }, '处理中：' + busy + ' …') : null,
        (views[tab] || views.service)());
    }

    // ------------------------------------------------------------------ apply
    function apply(ctx) {
      // 组件级样式：styles.insert 由 Client 运行时提供，返回移除函数。
      // 用 try 包住，缺该能力时也不影响面板主体（内联样式已全部走主题 token）。
      try {
        if (typeof styles !== 'undefined' && styles && typeof styles.insert === 'function') {
          const removeCss = styles.insert(PANEL_CSS);
          ctx.effect(() => removeCss, 'loomy: theme-aware panel css');
        }
      } catch (e) { console.warn('[loomy] 组件样式注入失败：', e); }

      // 声明期安全注册：槽位未声明时 inject 会等声明提交后再执行。
      try {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 60,
          label: 'Loomy 网关',
        }, LoomyIcon));
      } catch (e) { console.error('[loomy] 注册左侧栏图标失败：', e); }

      try {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, LoomyPanel));
      } catch (e) { console.error('[loomy] 注册主面板失败：', e); }
    }

    return { name: 'loomy-dsh-client', inject: ['slots'], apply };
  },
});
