/**
 * @local/dsh-wot-wallpaper — client half.
 *
 * Paints today's World of Tanks wallpaper behind the DSH web GUI and adds a slim
 * control bar in the `shell.bottom` slot (previous / next / refresh / on-off).
 * The pictures themselves come from the host half over the same origin.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-wot-wallpaper',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PKG = '@local/dsh-wot-wallpaper'
    const NS = 'wot-wallpaper'
    const PREFIX = '/wot-wallpaper'
    const DAY_MS = 24 * 60 * 60 * 1000
    const POLL_MS = 60 * 1000

    const STRINGS = {
      zh: {
        title: '坦克世界壁纸',
        idle: '正在准备壁纸…',
        empty: '暂无壁纸，刷新一下从官网下载',
        failed: '下载失败：{message}',
        refresh: '刷新',
        next: '下一张',
        prev: '上一张',
        enable: '开启',
        disable: '关闭',
        off: '壁纸已关闭',
        photos: '{n} 张',
        monthly: '每月更新',
        updatedToday: '今天更新',
        updated: '{n} 天前更新',
        never: '尚未下载',
        busy: '正在从官网下载…',
        source: '查看原图',
        today: '今日',
        nextIn: '{n} 天后更新',
      },
      en: {
        title: 'World of Tanks wallpaper',
        idle: 'Preparing wallpapers…',
        empty: 'No wallpapers yet — refresh to fetch them',
        failed: 'Download failed: {message}',
        refresh: 'Refresh',
        next: 'Next picture',
        prev: 'Previous picture',
        enable: 'Turn on',
        disable: 'Turn off',
        off: 'Wallpaper off',
        photos: '{n} pictures',
        monthly: 'monthly refresh',
        updatedToday: 'updated today',
        updated: 'updated {n} d ago',
        never: 'never downloaded',
        busy: 'Downloading from worldoftanks.eu…',
        source: 'Open original',
        today: 'today',
        nextIn: 'next refresh in {n} d',
      },
    }

    const BAR_CSS = `
.wotwp-bar{display:flex;flex-direction:row;align-items:center;gap:8px;width:100%;height:26px;padding:0 10px;box-sizing:border-box;
  font-family:Inter,var(--dsw-font-family);font-size:11px;line-height:1;letter-spacing:0;
  color:var(--dsw-alias-label-tertiary);background:color-mix(in srgb, var(--dsw-alias-bg-base) 72%, transparent);
  backdrop-filter:blur(16px) saturate(1.05);-webkit-backdrop-filter:blur(16px) saturate(1.05);
  border-top:.5px solid var(--dsw-alias-border-l3);user-select:none;-webkit-user-select:none}
.wotwp-bar[data-off=true]{background:color-mix(in srgb, var(--dsw-alias-bg-base) 92%, transparent)}
.wotwp-glyph{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:none;
  color:var(--dsw-alias-label-tertiary);opacity:.9}
.wotwp-name{flex:none;color:var(--dsw-alias-label-secondary);font-weight:500}
.wotwp-dot{flex:none;opacity:.45}
.wotwp-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.wotwp-meta{flex:none;opacity:.8}
.wotwp-spacer{flex:1 1 auto;min-width:8px}
.wotwp-actions{flex:none;display:flex;flex-direction:row;align-items:center;gap:2px}
.wotwp-btn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);
  font:inherit;line-height:1;padding:3px 6px;border-radius:5px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  min-width:18px}
.wotwp-btn:hover{background:color-mix(in srgb, var(--dsw-alias-label-tertiary) 16%, transparent);color:var(--dsw-alias-label-primary)}
.wotwp-btn:active{background:color-mix(in srgb, var(--dsw-alias-label-tertiary) 24%, transparent)}
.wotwp-btn:disabled{opacity:.4;cursor:default}
.wotwp-btn[data-busy=true] .wotwp-spin{animation:wotwp-spin 1s linear infinite}
.wotwp-spin{display:inline-block;transform-origin:50% 50%}
@keyframes wotwp-spin{to{transform:rotate(360deg)}}
.wotwp-err{color:var(--dsw-alias-label-secondary);opacity:.85;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`

    /* ---------------------------------------------------------- utilities */

    function pickLang() {
      const lang = String((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase()
      return lang.startsWith('zh') ? 'zh' : 'en'
    }

    let translate = null

    function t(key, params) {
      let text = null
      if (typeof translate === 'function') {
        try {
          const value = translate(key)
          if (typeof value === 'string' && value && value !== key) text = value
        } catch {
          text = null
        }
      }
      if (!text) {
        const lang = pickLang()
        text = STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key
      }
      if (!params) return text
      return text.replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])))
    }

    function localDaySerial(now = Date.now()) {
      return Math.floor((now - new Date(now).getTimezoneOffset() * 60 * 1000) / DAY_MS)
    }

    function origin() {
      if (typeof window === 'undefined') return 'http://127.0.0.1'
      return window.location.origin
    }

    function api(pathname) {
      return `${origin()}${PREFIX}${pathname}`
    }

    function absolute(url) {
      if (!url) return null
      try {
        return new URL(url, `${origin()}/`).href
      } catch {
        return null
      }
    }

    function daysBetween(from, to = Date.now()) {
      if (!from) return null
      return Math.max(0, Math.round((to - from) / DAY_MS))
    }

    async function fetchState() {
      const response = await fetch(api('/state'), { headers: { accept: 'application/json' }, cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    }

    async function postAction(action) {
      const response = await fetch(api('/action'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    }

    /* ------------------------------------------------------------------ css */

    function wallpaperCss(url) {
      const image = `url("${String(url).replace(/"/g, '%22')}")`
      const scrim = (top, middle, bottom) =>
        `linear-gradient(180deg,` +
        `color-mix(in srgb, var(--dsw-alias-bg-base) ${top}%, transparent) 0%,` +
        `color-mix(in srgb, var(--dsw-alias-bg-base) ${middle}%, transparent) 55%,` +
        `color-mix(in srgb, var(--dsw-alias-bg-base) ${bottom}%, transparent) 100%)`

      // The frame carries the picture; every chrome surface that paints over it
      // is turned into glass so the art stays visible behind the conversation.
      // A lightly blurred backdrop keeps the photo readable under text.
      const frame = `[class*="_frame"]:has([data-shell-bottom])`
      const glass = `color-mix(in srgb, var(--dsw-alias-bg-base) 76%, transparent)`
      const side = `color-mix(in srgb, var(--dsw-specific-sidebar-fill) 40%, transparent)`
      const blur = `backdrop-filter:blur(18px) saturate(1.08);-webkit-backdrop-filter:blur(18px) saturate(1.08)`
      return `
${frame}{position:relative;isolation:isolate;background-color:transparent;
  background-image:${scrim(64, 76, 62)},${image};
  background-position:center center,center center;background-size:cover,cover;background-repeat:no-repeat,no-repeat;
  background-attachment:fixed,fixed}
body[data-ds-dark-theme] ${frame}{background-image:${scrim(50, 62, 48)},${image}}
${frame} [class*="_centerCol"]{background-color:transparent;
  backdrop-filter:blur(2.5px) saturate(1.02);-webkit-backdrop-filter:blur(2.5px) saturate(1.02);
  background-image:linear-gradient(180deg,
    color-mix(in srgb, var(--dsw-alias-bg-base) 40%, transparent) 0%,
    color-mix(in srgb, var(--dsw-alias-bg-base) 52%, transparent) 48%,
    color-mix(in srgb, var(--dsw-alias-bg-base) 38%, transparent) 100%)}
body[data-ds-dark-theme] ${frame} [class*="_centerCol"]{background-image:linear-gradient(180deg,
    color-mix(in srgb, var(--dsw-alias-bg-base) 22%, transparent) 0%,
    color-mix(in srgb, var(--dsw-alias-bg-base) 32%, transparent) 48%,
    color-mix(in srgb, var(--dsw-alias-bg-base) 20%, transparent) 100%)}
${frame} [class*="_mainPanel"]{background-color:transparent}
${frame} [class*="_mainPanel"] > *,
${frame} [class*="_mainPanel"] > * > *,
${frame} [class*="_mainPanel"] > * > * > *{background-color:transparent;background-image:none}
/* The sidebar paints its own fill on an inner root, so target it without the
   frame prefix and with !important: the app's own rule is a background shorthand. */
[class*="_sidebarCol"],
[class*="_sidebarCol"] > *,
[class*="_sidebarCol"] > * > *,
[class*="_sidebarCol"] > * > * > *{background-color:${side} !important;background-image:none !important}
[class*="_sidebarCol"],
[class*="_sidebarCol"] > *{${blur}}
/* the right-hand dock lives under [data-dsh-panel-host] (a body-level portal) */
[data-dsh-panel-host]{background-color:transparent !important}
[data-dsh-panel-host] [class*="_tabHost_"],
[data-dsh-panel-host] [class*="_pane_"],
[data-dsh-panel-host] [class*="_surface_"]{background-color:${glass} !important;${blur}}
[data-dsh-panel-host] [class*="_content"],
[data-dsh-panel-host] [class*="_body"],
${frame} [class*="_rightbarCol"]{background-color:transparent !important}
/* the composer keeps its shape but turns into glass so the art shows through */
${frame} [class*="composerSeat"] [class*="_card"],
${frame} [class*="composerStack"] [class*="_card"]{
  background-color:color-mix(in srgb, var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1)) 82%, transparent);
  ${blur}}
${frame} [data-shell-bottom],
${frame} [data-shell-bottom] > *{background:transparent}
`
    }

    /* ------------------------------------------------------------ components */

    const glyph = (paths) =>
      h(
        'svg',
        { className: 'wotwp-glyph', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        ...paths.map((d, i) =>
          h('path', {
            key: i,
            d,
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            fill: 'none',
          }),
        ),
      )

    const tankGlyph = () =>
      glyph([
        'M2 12.5h9l2.6-2.2h1.1',
        'M2.6 12.5V11c0-.5.4-.9.9-.9h7.2c.4 0 .8.2 1 .6l1 1.8',
        'M6 10.1V8.4h3.1v1.7',
        'M9.1 9.2h4.6',
        'M4.4 13.6h.9M7 13.6h.9M9.6 13.6h.9',
      ])

    function useWallpaperState() {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [pending, setPending] = React.useState(false)

      const reload = React.useCallback(async () => {
        try {
          const next = await fetchState()
          setState(next)
          setError(null)
          return next
        } catch (failure) {
          setError(String(failure?.message ?? failure))
          return null
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        let timer = null
        const tick = () => {
          reload().then((next) => {
            if (!alive) return
            const interval = next && next.busy ? 2500 : POLL_MS
            timer = window.setTimeout(tick, interval)
          })
        }
        tick()
        const onVisible = () => {
          if (document.visibilityState === 'visible') reload()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive = false
          if (timer !== null) window.clearTimeout(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [reload])

      const act = React.useCallback(
        async (action) => {
          setPending(true)
          try {
            const next = await postAction(action)
            setState(next)
            setError(null)
            if (action === 'refresh' || next?.busy) {
              window.setTimeout(() => {
                reload()
              }, 1200)
            }
          } catch (failure) {
            setError(String(failure?.message ?? failure))
          } finally {
            setPending(false)
          }
        },
        [reload],
      )

      return { state, error, pending, reload, act }
    }

    function WallpaperBar() {
      const { state, error, pending, act } = useWallpaperState()

      const enabled = state ? state.enabled !== false : true
      const images = Array.isArray(state?.images) ? state.images : []
      const count = images.length
      const offset = Number.isFinite(state?.offset) ? state.offset : 0
      const index = count ? (((localDaySerial() + offset) % count) + count) % count : -1
      const current = index >= 0 ? images[index] : null
      const url = current ? absolute(current.url) : null
      const showWallpaper = enabled && Boolean(url)
      const busy = pending || Boolean(state?.busy)
      const errorText = error ?? (count ? null : state?.lastError ?? null)

      const meta = []
      if (count) meta.push(t('photos', { n: count }))
      meta.push(t('monthly'))
      if (state?.updatedAt) {
        const days = daysBetween(state.updatedAt) ?? 0
        meta.push(days <= 0 ? t('updatedToday') : t('updated', { n: days }))
      } else {
        meta.push(t('never'))
      }

      const styles = [
        h('style', { key: 'bar', 'data-plugin': PKG, 'data-plugin-css': 'bar' }, BAR_CSS),
      ]
      if (showWallpaper && url) {
        styles.push(h('style', { key: 'wall', 'data-plugin': PKG, 'data-plugin-css': 'wallpaper' }, wallpaperCss(url)))
      }

      let status
      if (!enabled) {
        status = h('span', { className: 'wotwp-title' }, t('off'))
      } else if (!count) {
        status = h(
          'span',
          { className: 'wotwp-err', title: errorText ?? undefined },
          busy ? t('busy') : errorText ? t('failed', { message: errorText }) : t('idle'),
        )
      } else {
        status = h(
          'span',
          { className: 'wotwp-title', title: current ? `${current.title}${current.remote ? `\n${current.remote}` : ''}` : undefined },
          `${t('today')} · ${current?.title ?? ''}`,
        )
      }

      const buttons = []
      if (!enabled) {
        buttons.push(
          h('button', { key: 'enable', className: 'wotwp-btn', type: 'button', title: t('enable'), onClick: () => act('enable') }, t('enable')),
        )
      } else {
        if (count > 1) {
          buttons.push(
            h('button', { key: 'prev', className: 'wotwp-btn', type: 'button', title: t('prev'), 'aria-label': t('prev'), onClick: () => act('prev') }, '‹'),
            h('button', { key: 'next', className: 'wotwp-btn', type: 'button', title: t('next'), 'aria-label': t('next'), onClick: () => act('next') }, '›'),
          )
        }
        buttons.push(
          h(
            'button',
            {
              key: 'refresh',
              className: 'wotwp-btn',
              type: 'button',
              title: t('refresh'),
              'aria-label': t('refresh'),
              'data-busy': busy ? 'true' : 'false',
              disabled: busy,
              onClick: () => act('refresh'),
            },
            h('span', { className: 'wotwp-spin' }, '⟳'),
          ),
          h('button', { key: 'off', className: 'wotwp-btn', type: 'button', title: t('disable'), 'aria-label': t('disable'), onClick: () => act('disable') }, '✕'),
        )
      }

      return h(
        React.Fragment,
        null,
        ...styles,
        h(
          'div',
          { className: 'wotwp-bar', 'data-off': enabled ? 'false' : 'true', 'data-wot-wallpaper-bar': 'true' },
          h('span', { className: 'wotwp-glyph' }, tankGlyph()),
          h('span', { className: 'wotwp-name' }, t('title')),
          h('span', { className: 'wotwp-dot' }, '·'),
          status,
          h('span', { className: 'wotwp-spacer' }),
          h('span', { className: 'wotwp-meta' }, meta.join(' · ')),
          h('span', { className: 'wotwp-spacer' }),
          h('span', { className: 'wotwp-actions' }, ...buttons),
        ),
      )
    }

    /* --------------------------------------------------------------- plugin */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          let dispose = null
          try {
            if (ctx.locale && typeof ctx.locale.register === 'function') {
              dispose = ctx.locale.register(NS, { zh: STRINGS.zh, en: STRINGS.en })
              if (typeof ctx.locale.bind === 'function') translate = ctx.locale.bind(NS)
            }
          } catch {
            translate = null
          }
          return () => {
            translate = null
            if (typeof dispose === 'function') {
              try {
                dispose()
              } catch {
                /* already disposed */
              }
            }
          }
        }, 'wot-wallpaper: dictionaries')

        ctx.slots.inject('shell.bottom', () =>
          ctx.slots.register({ name: 'shell.bottom', id: 'wot-wallpaper', order: 10, locale: NS }, WallpaperBar),
        )
      },
    }
  },
})

