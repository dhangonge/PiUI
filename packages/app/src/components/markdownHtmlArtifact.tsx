import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CodeBlock } from './CodeBlock'
import { CodeIcon, EyeIcon } from './Icons'
import { useTheme } from '../hooks/useTheme'
import { useInputCapabilities } from '../hooks/useInputCapabilities'
import {
  buildHtmlSandboxThemeCss,
  createHtmlSandboxMeasureScript,
  createHtmlSandboxStorageScript,
  createSandboxedHtmlDocument,
  HTML_SANDBOX_SECURITY_HEAD,
  HTML_SANDBOX_VIEWPORT_HEAD,
} from './htmlSandbox'

const HTML_SOURCE_BUTTON_CLASS =
  'absolute right-2 top-2 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md bg-bg-300/85 p-2 text-accent-main-100 opacity-0 shadow-sm transition-all hover:bg-bg-300/90 hover:text-accent-main-100 group-hover/html-preview:opacity-100 group-focus-within/html-preview:opacity-100'

function createStreamingHtmlDocument(resizeId: string, theme: 'light' | 'dark'): string {
  const themeHead = `<style id="piui-html-theme">${buildHtmlSandboxThemeCss(theme, 'hidden')}</style>`
  const themeCss = JSON.stringify({
    light: buildHtmlSandboxThemeCss('light', 'hidden'),
    dark: buildHtmlSandboxThemeCss('dark', 'hidden'),
  })
  const storageScript = createHtmlSandboxStorageScript()
  const measureScript = createHtmlSandboxMeasureScript(resizeId)
  const bridge = `<script>
  (() => {
    const id = ${JSON.stringify(resizeId)};
    const themeCss = ${themeCss};
    const measure = () => dispatchEvent(new Event('piui-html-measure'));
    let scheduledScripts = 0;
    let scriptQueue = Promise.resolve();
    const applyTheme = theme => {
      document.documentElement.style.colorScheme = theme;
      document.documentElement.dataset.theme = theme;
      const style = document.getElementById('piui-html-theme');
      if (style) style.textContent = themeCss[theme] || themeCss.light;
      dispatchEvent(new CustomEvent('piui-theme-change', { detail: { theme } }));
      dispatchEvent(new Event('resize'));
      measure();
    };
    const clean = (doc, scriptCount) => {
      const descriptors = [];
      Array.from(doc.querySelectorAll('script')).forEach((node, index) => {
        if (index >= scriptCount) {
          node.remove();
          return;
        }
        descriptors.push({
          attributes: Array.from(node.attributes).map(attr => [attr.name, attr.value]),
          text: node.textContent || ''
        });
        node.setAttribute('data-piui-script-index', String(index));
        node.setAttribute('type', 'application/x-piui-pending');
      });
      doc.querySelectorAll('*').forEach(node => Array.from(node.attributes).forEach(attr => {
        if (/^(href|src|action|formaction)$/i.test(attr.name) && /^\\s*javascript:/i.test(attr.value)) node.removeAttribute(attr.name);
      }));
      return descriptors;
    };
    const clone = node => document.importNode(node, true);
    const compatible = (current, next) => {
      if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) return false;
      if (current.nodeType !== 1) return true;
      const currentId = current.getAttribute('id');
      const nextId = next.getAttribute('id');
      if (currentId || nextId) return currentId === nextId;
      if (current.nodeName === 'SCRIPT') {
        return current.getAttribute('data-piui-script-index') === next.getAttribute('data-piui-script-index');
      }
      return true;
    };
    const patch = (current, next) => {
      if (!compatible(current, next)) {
        current.replaceWith(clone(next));
        return;
      }
      if (current.nodeType === 3 || current.nodeType === 8) {
        if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
        return;
      }
      const currentElement = current;
      const nextElement = next;
      if (currentElement.nodeName === 'SCRIPT' && currentElement.hasAttribute('data-piui-script-executed')) return;
      Array.from(currentElement.attributes).forEach(attr => {
        if (!nextElement.hasAttribute(attr.name)) currentElement.removeAttribute(attr.name);
      });
      Array.from(nextElement.attributes).forEach(attr => {
        if (currentElement.getAttribute(attr.name) !== attr.value) currentElement.setAttribute(attr.name, attr.value);
      });
      const nextChildren = Array.from(nextElement.childNodes);
      for (let index = 0; index < nextChildren.length; index += 1) {
        const nextChild = nextChildren[index];
        const currentChild = currentElement.childNodes[index];
        if (!currentChild) {
          currentElement.append(clone(nextChild));
          continue;
        }
        if (compatible(currentChild, nextChild)) {
          patch(currentChild, nextChild);
          continue;
        }
        const laterMatch = Array.from(currentElement.childNodes)
          .slice(index + 1)
          .find(candidate => compatible(candidate, nextChild));
        if (laterMatch) {
          currentElement.insertBefore(laterMatch, currentChild);
          patch(laterMatch, nextChild);
        } else {
          currentElement.insertBefore(clone(nextChild), currentChild);
        }
      }
      while (currentElement.childNodes.length > nextChildren.length) currentElement.lastChild?.remove();
    };
    const patchHead = next => {
      const currentNodes = Array.from(document.head.querySelectorAll('[data-piui-stream-head]'));
      const nextNodes = Array.from(next.head.querySelectorAll('style,link[rel="stylesheet"],script'));
      for (let index = 0; index < Math.max(currentNodes.length, nextNodes.length); index += 1) {
        const current = currentNodes[index];
        const candidate = nextNodes[index];
        if (!candidate) current?.remove();
        else if (!current) {
          const added = clone(candidate);
          added.setAttribute('data-piui-stream-head', '');
          document.head.append(added);
        } else patch(current, candidate);
      }
    };
    const runScripts = descriptors => {
      for (let index = scheduledScripts; index < descriptors.length; index += 1) {
        const descriptor = descriptors[index];
        scheduledScripts = index + 1;
        scriptQueue = scriptQueue.then(() => new Promise(resolve => {
          const pending = document.querySelector('script[data-piui-script-index="' + index + '"]');
          if (!pending || pending.hasAttribute('data-piui-script-executed')) {
            resolve();
            return;
          }
          const script = document.createElement('script');
          descriptor.attributes.forEach(([name, value]) => script.setAttribute(name, value));
          script.setAttribute('data-piui-script-index', String(index));
          script.setAttribute('data-piui-script-executed', '');
          if (pending.hasAttribute('data-piui-stream-head')) script.setAttribute('data-piui-stream-head', '');
          script.textContent = descriptor.text;
          const waitsForLoad = script.hasAttribute('src') || script.getAttribute('type') === 'module';
          if (script.hasAttribute('src') && !script.hasAttribute('async') && !script.hasAttribute('defer')) script.async = false;
          if (waitsForLoad) {
            script.addEventListener('load', resolve, { once: true });
            script.addEventListener('error', resolve, { once: true });
          }
          pending.replaceWith(script);
          if (!waitsForLoad) resolve();
        }));
      }
      scriptQueue.then(measure);
    };
    addEventListener('message', event => {
      const data = event.data;
      if (data?.type === 'piui-html-theme') {
        applyTheme(data.theme);
        return;
      }
      if (data?.type !== 'piui-html-stream' || data.id !== id || typeof data.html !== 'string') return;
      const next = new DOMParser().parseFromString(data.html, 'text/html');
      const scriptCount = data.complete === true ? Number.MAX_SAFE_INTEGER : Math.max(0, Number(data.scriptCount) || 0);
      const descriptors = clean(next, scriptCount);
      patchHead(next);
      patch(document.body, next.body);
      runScripts(descriptors);
      measure();
    });
  })();
  </script>`
  return `<!doctype html><html><head>${HTML_SANDBOX_SECURITY_HEAD}${HTML_SANDBOX_VIEWPORT_HEAD}${themeHead}${storageScript}</head><body>${measureScript}${bridge}</body></html>`
}

export function HtmlPreviewSurface({
  children,
  className = '',
  forceTouchControlsVisible = false,
  onViewSource,
  surfaceRef,
  style,
}: {
  children: React.ReactNode
  className?: string
  forceTouchControlsVisible?: boolean
  onViewSource: () => void
  surfaceRef?: React.RefObject<HTMLDivElement | null>
  style?: React.CSSProperties
}) {
  const { t } = useTranslation('components')
  const { preferTouchUi } = useInputCapabilities()

  const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (
      event.target instanceof Element &&
      event.target.closest('button, a, input, textarea, select, summary, [contenteditable]')
    ) {
      return
    }
    event.currentTarget.focus({ preventScroll: true })
  }, [])

  return (
    <div
      ref={surfaceRef}
      className={`group/html-preview relative max-w-full overflow-hidden contain-content ${preferTouchUi ? 'focus:outline-none' : ''} ${className}`}
      style={style}
      tabIndex={preferTouchUi ? 0 : undefined}
      onClick={preferTouchUi ? handleClick : undefined}
    >
      <button
        type="button"
        onClick={onViewSource}
        className={`${HTML_SOURCE_BUTTON_CLASS} ${preferTouchUi && !forceTouchControlsVisible ? '[@media(hover:none)]:opacity-0' : '[@media(hover:none)]:opacity-100'}`}
        title={t('markdown.viewHtmlSource')}
        aria-label={t('markdown.viewHtmlSource')}
      >
        <CodeIcon />
      </button>
      {children}
    </div>
  )
}

export function MarkdownHtmlArtifact({
  code,
  isReasoning,
  isIncomplete,
  language = 'html',
}: {
  code: string
  isReasoning: boolean
  isIncomplete?: boolean
  language?: string
}) {
  const { t } = useTranslation('components')
  const [view, setView] = useState<'preview' | 'code'>('preview')
  const [contentHeight, setContentHeight] = useState(120)
  const [contentWidth, setContentWidth] = useState<number | null>(null)
  const [touchControlsVisible, setTouchControlsVisible] = useState(false)
  const previewSurfaceRef = useRef<HTMLDivElement>(null)
  const scrollportRef = useRef<HTMLDivElement>(null)
  const streamFrameRef = useRef<HTMLIFrameElement>(null)
  const canonicalFrameRef = useRef<HTMLIFrameElement>(null)
  const [canonicalReady, setCanonicalReady] = useState(false)
  const resizeId = useId()
  const canonicalResizeId = `${resizeId}-canonical`
  const { resolvedTheme } = useTheme()
  const theme = resolvedTheme === 'dark' ? 'dark' : 'light'
  const [initialTheme] = useState<'light' | 'dark'>(theme)
  const [usesStreamBridge] = useState(() => !!isIncomplete)
  const streamSrcDoc = useMemo(() => createStreamingHtmlDocument(resizeId, initialTheme), [initialTheme, resizeId])
  const canonicalSrcDoc = useMemo(
    () => createSandboxedHtmlDocument(code, canonicalResizeId, initialTheme),
    [canonicalResizeId, code, initialTheme],
  )
  const showCanonical = !usesStreamBridge || !isIncomplete

  const sendStreamingHtml = useCallback(() => {
    if (!usesStreamBridge) return
    const scriptCount = isIncomplete
      ? Array.from(code.matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi)).length
      : Number.MAX_SAFE_INTEGER
    streamFrameRef.current?.contentWindow?.postMessage(
      { type: 'piui-html-stream', id: resizeId, html: code, complete: !isIncomplete, scriptCount },
      '*',
    )
  }, [code, isIncomplete, resizeId, usesStreamBridge])

  useEffect(() => {
    sendStreamingHtml()
  }, [sendStreamingHtml])

  const sendTheme = useCallback(() => {
    const message = { type: 'piui-html-theme', theme }
    streamFrameRef.current?.contentWindow?.postMessage(message, '*')
    canonicalFrameRef.current?.contentWindow?.postMessage(message, '*')
  }, [theme])

  useEffect(() => {
    sendTheme()
  }, [sendTheme])

  useEffect(() => {
    if (!touchControlsVisible) return
    const hideControlsOutsidePreview = (event: PointerEvent) => {
      if (event.target instanceof Node && !previewSurfaceRef.current?.contains(event.target)) {
        setTouchControlsVisible(false)
      }
    }
    window.addEventListener('pointerdown', hideControlsOutsidePreview, true)
    return () => window.removeEventListener('pointerdown', hideControlsOutsidePreview, true)
  }, [touchControlsVisible])

  useEffect(() => {
    const scrollport = scrollportRef.current
    if (!scrollport || typeof ResizeObserver === 'undefined') return
    let lastWidth = scrollport.clientWidth
    const observer = new ResizeObserver(() => {
      const nextWidth = scrollport.clientWidth
      if (nextWidth === lastWidth) return
      lastWidth = nextWidth
      // Unlock width only. Height updates from the next content measure after reflow.
      setContentWidth(current => (current == null ? current : null))
    })
    observer.observe(scrollport)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const handleFrameMessage = (event: MessageEvent) => {
      const data = event.data
      if (data?.type !== 'piui-html-interaction' && data?.type !== 'piui-html-resize') return
      const fromStream = event.source === streamFrameRef.current?.contentWindow && data.id === resizeId
      const fromCanonical = event.source === canonicalFrameRef.current?.contentWindow && data.id === canonicalResizeId
      if (!fromStream && !fromCanonical) return
      if (data.type === 'piui-html-interaction') {
        setTouchControlsVisible(true)
        return
      }
      const height = Number(data.height)
      const width = Number(data.width)
      if (Number.isFinite(height)) setContentHeight(Math.min(4000, Math.max(120, Math.round(height))))
      if (Number.isFinite(width)) {
        const measured = Math.min(10000, Math.max(1, Math.round(width)))
        const available = scrollportRef.current?.clientWidth ?? 0
        setContentWidth(current => {
          const next = available > 0 && measured <= available + 1 ? null : measured
          return current === next ? current : next
        })
      }
    }
    window.addEventListener('message', handleFrameMessage)
    return () => window.removeEventListener('message', handleFrameMessage)
  }, [canonicalResizeId, resizeId])

  if (view === 'code') {
    return (
      <CodeBlock
        code={code}
        language={language}
        variant={isReasoning ? 'reasoning' : 'default'}
        wordwrap={isReasoning}
        className="my-4 first:mt-0 last:mb-0"
        headerActions={
          <button
            type="button"
            onClick={() => setView('preview')}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md p-2 text-text-400 transition-colors hover:bg-bg-300/60 hover:text-text-200"
            title={t('markdown.previewHtml')}
            aria-label={t('markdown.previewHtml')}
          >
            <EyeIcon />
          </button>
        }
      />
    )
  }

  return (
    <HtmlPreviewSurface
      className="my-4 first:mt-0 last:mb-0 w-full max-w-full transition-[height] duration-75 ease-out"
      forceTouchControlsVisible={touchControlsVisible}
      style={{ height: `${contentHeight}px` }}
      onViewSource={() => setView('code')}
      surfaceRef={previewSurfaceRef}
    >
      <div
        ref={scrollportRef}
        className="h-full w-full max-w-full overflow-x-auto overflow-y-hidden code-scrollbar"
        style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-x pan-y', overscrollBehaviorX: 'contain' }}
      >
        <div
          className="relative h-full w-full"
          style={{ minWidth: contentWidth == null ? '100%' : `${contentWidth}px` }}
        >
          {usesStreamBridge && !canonicalReady && (
            <iframe
              ref={streamFrameRef}
              title={t('markdown.htmlPreview')}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={streamSrcDoc}
              onLoad={() => {
                sendStreamingHtml()
                sendTheme()
              }}
              style={{ colorScheme: theme }}
              className="absolute inset-0 block h-full w-full border-0 bg-transparent"
            />
          )}
          {showCanonical && (
            <iframe
              ref={canonicalFrameRef}
              title={t('markdown.htmlPreview')}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={canonicalSrcDoc}
              onLoad={() => {
                setCanonicalReady(true)
                sendTheme()
              }}
              style={{ colorScheme: theme }}
              className={`absolute inset-0 block h-full w-full border-0 bg-transparent ${usesStreamBridge && !canonicalReady ? 'pointer-events-none opacity-0' : 'opacity-100'}`}
            />
          )}
        </div>
      </div>
    </HtmlPreviewSurface>
  )
}
