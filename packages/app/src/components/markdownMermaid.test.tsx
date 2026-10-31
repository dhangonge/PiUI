import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownRenderer } from './MarkdownRenderer'
import { clearMermaidRenderCache } from './mermaidRenderCache'

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: '<svg><title>Diagram</title></svg>' })),
}))
const useInputCapabilitiesMock = vi.hoisted(() =>
  vi.fn(() => ({
    canHover: true,
    hasCoarsePointer: false,
    hasTouch: false,
    preferTouchUi: false,
  })),
)
const themeMock = vi.hoisted(() => ({ resolvedTheme: 'light' as 'light' | 'dark' }))

vi.mock('./CodeBlock', () => ({
  CodeBlock: ({
    code,
    language,
    variant,
    deferHighlight,
    forceHighlight,
    streamingHighlight,
    headerActions,
  }: {
    code: string
    language?: string
    variant?: string
    deferHighlight?: boolean
    forceHighlight?: boolean
    streamingHighlight?: boolean
    headerActions?: React.ReactNode
  }) => (
    <div
      data-testid="code-block"
      data-variant={variant ?? 'default'}
      data-defer-highlight={String(!!deferHighlight)}
      data-force-highlight={String(!!forceHighlight)}
      data-streaming-highlight={String(!!streamingHighlight)}
    >
      {language}
      {headerActions}
      {`${language ?? 'text'}:${code}`}
    </div>
  ),
}))

vi.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ resolvedTheme: themeMock.resolvedTheme }),
}))

vi.mock('../hooks/useInputCapabilities', () => ({
  useInputCapabilities: () => useInputCapabilitiesMock(),
}))

vi.mock('mermaid', () => ({
  default: mermaidMocks,
}))

vi.mock('./ui', () => ({
  CopyButton: ({ text }: { text: string }) => (
    <button data-testid="copy-button" aria-label="Copy to clipboard">
      {text.slice(0, 20)}
    </button>
  ),
}))

describe('MarkdownRenderer mermaid', () => {
  beforeEach(() => {
    themeMock.resolvedTheme = 'light'
    clearMermaidRenderCache()
    useInputCapabilitiesMock.mockReset()
    useInputCapabilitiesMock.mockReturnValue({
      canHover: true,
      hasCoarsePointer: false,
      hasTouch: false,
      preferTouchUi: false,
    })
    mermaidMocks.initialize.mockClear()
    mermaidMocks.render.mockClear()
    mermaidMocks.render.mockResolvedValue({ svg: '<svg><title>Diagram</title></svg>' })
  })

  it('renders mermaid code fences as diagrams', async () => {
    render(<MarkdownRenderer content={'```mermaid\ngraph TD\n  A-->B\n```'} />)

    expect(await screen.findByRole('img', { name: 'Mermaid diagram' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeInTheDocument()
    expect(mermaidMocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: 'strict', startOnLoad: false, theme: 'default' }),
    )
  })

  it('renders completed mermaid diagrams in stable streaming blocks', async () => {
    render(<MarkdownRenderer content={'```mermaid\ngraph TD\n  A-->B\n```\n\nstill typing'} isStreaming />)

    expect(await screen.findByRole('img', { name: 'Mermaid diagram' })).toBeInTheDocument()
    expect(screen.getByText('still typing')).toBeInTheDocument()
    expect(mermaidMocks.render).toHaveBeenCalledTimes(1)
  })

  it('reuses cached mermaid output after remounting', async () => {
    const content = '```mermaid\ngraph TD\n  A-->B\n```'
    const first = render(<MarkdownRenderer content={content} />)
    expect(await screen.findByRole('img', { name: 'Mermaid diagram' })).toBeInTheDocument()
    first.unmount()

    render(<MarkdownRenderer content={content} />)

    expect(screen.getByRole('img', { name: 'Mermaid diagram' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Rendering diagram')).not.toBeInTheDocument()
    expect(mermaidMocks.render).toHaveBeenCalledTimes(1)
  })

  it('scopes cached mermaid ids for each mounted diagram', async () => {
    mermaidMocks.render.mockResolvedValue({
      svg: '<svg id="diagram" aria-labelledby="diagram-title"><title id="diagram-title">Diagram</title><style>#diagram-node { fill: red; }</style><defs><marker id="diagram-arrow"></marker></defs><path id="diagram-node" marker-end="url(#diagram-arrow)"></path><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hello<br>world</div></foreignObject></svg>',
    })
    render(<MarkdownRenderer content={'```mermaid\ngraph TD\n  A-->B\n```\n\n```mermaid\ngraph TD\n  A-->B\n```'} />)

    const diagrams = await screen.findAllByRole('img', { name: 'Mermaid diagram' })
    const firstSvg = diagrams[0].querySelector('svg')
    const secondSvg = diagrams[1].querySelector('svg')
    const firstMarker = firstSvg?.querySelector('marker')
    const secondMarker = secondSvg?.querySelector('marker')
    const firstTitle = firstSvg?.querySelector('title')

    expect(firstSvg?.id).not.toBe(secondSvg?.id)
    expect(firstMarker?.id).not.toBe(secondMarker?.id)
    expect(firstSvg?.querySelector('path')).toHaveAttribute('marker-end', `url(#${firstMarker?.id})`)
    expect(secondSvg?.querySelector('path')).toHaveAttribute('marker-end', `url(#${secondMarker?.id})`)
    expect(firstSvg).toHaveAttribute('aria-labelledby', firstTitle?.id)
    expect(firstSvg?.querySelector('style')).toHaveTextContent(`#${firstSvg?.querySelector('path')?.id}`)
    expect(mermaidMocks.render).toHaveBeenCalledTimes(1)
  })

  it('defers incomplete streaming mermaid diagrams as code blocks', () => {
    render(<MarkdownRenderer content={'```mermaid\ngraph TD\n  A-->B'} isStreaming />)

    expect(screen.getByTestId('code-block')).toHaveTextContent(/mermaid:graph TD\s+A-->B/)
    expect(screen.getByTestId('code-block')).toHaveAttribute('data-defer-highlight', 'true')
    expect(mermaidMocks.render).not.toHaveBeenCalled()
  })

  it('supports mermaid zoom, pan, and reset controls', async () => {
    render(<MarkdownRenderer content={'```mermaid\ngraph TD\n  A-->B\n```'} />)

    const diagram = await screen.findByRole('img', { name: 'Mermaid diagram' })
    const zoomIn = screen.getByRole('button', { name: 'Zoom in diagram' })

    expect(screen.queryByRole('button', { name: 'Enable diagram pan' })).not.toBeInTheDocument()
    expect(zoomIn).toHaveClass('h-8', 'w-8')
    expect(zoomIn).not.toHaveClass('markdown-html-control')

    fireEvent.click(zoomIn)
    expect(diagram).toHaveStyle({ transform: 'translate(0px, 0px) scale(1.15)' })

    fireEvent.pointerDown(diagram, { button: 0, clientX: 10, clientY: 20, pointerId: 1, pointerType: 'mouse' })
    fireEvent.pointerMove(diagram, { clientX: 35, clientY: 55, pointerId: 1, pointerType: 'mouse' })
    fireEvent.pointerUp(diagram, { pointerId: 1, pointerType: 'mouse' })
    expect(diagram).toHaveStyle({ transform: 'translate(25px, 35px) scale(1.15)' })

    fireEvent.click(screen.getByRole('button', { name: 'Reset diagram view' }))
    expect(diagram).toHaveStyle({ transform: 'translate(0px, 0px) scale(1)' })
  })

  it('keeps desktop controls for hover-capable touch input', async () => {
    useInputCapabilitiesMock.mockReturnValue({
      canHover: true,
      hasCoarsePointer: false,
      hasTouch: true,
      preferTouchUi: false,
    })

    render(<MarkdownRenderer content={'```mermaid\ngraph TD\n  A-->B\n```'} />)

    const diagram = await screen.findByRole('img', { name: 'Mermaid diagram' })

    expect(screen.queryByRole('button', { name: 'Enable diagram pan' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Zoom in diagram' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Zoom out diagram' })).toBeInTheDocument()
    expect(diagram.className).toContain('touch-pan-y')
  })

  it('uses tap-to-reveal mermaid controls for touch-preferred input', async () => {
    useInputCapabilitiesMock.mockReturnValue({
      canHover: false,
      hasCoarsePointer: true,
      hasTouch: true,
      preferTouchUi: true,
    })

    render(<MarkdownRenderer content={'```mermaid\ngraph TD\n  A-->B\n```'} />)

    const diagram = await screen.findByRole('img', { name: 'Mermaid diagram' })
    const container = diagram.parentElement
    const toolbar = screen.getByRole('button', { name: 'Copy to clipboard' }).parentElement

    expect(container).toHaveAttribute('tabindex', '0')
    expect(toolbar?.className).toContain('[@media(hover:none)]:opacity-0')
    expect(diagram.className).toContain('touch-pan-y')
    expect(screen.queryByRole('button', { name: 'Zoom in diagram' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Zoom out diagram' })).not.toBeInTheDocument()

    fireEvent.pointerDown(diagram, { clientX: 10, clientY: 20, pointerId: 2, pointerType: 'touch' })
    fireEvent.pointerMove(diagram, { clientX: 35, clientY: 55, pointerId: 2, pointerType: 'touch' })
    expect(diagram).toHaveStyle({ transform: 'translate(0px, 0px) scale(1)' })

    fireEvent.click(diagram)
    expect(container).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Enable diagram pan' }))
    const panButton = screen.getByRole('button', { name: 'Disable diagram pan' })
    expect(panButton).toHaveAttribute('aria-pressed', 'true')
    expect(panButton.className).toContain('ring-accent-main-100')
    expect(diagram.className).toContain('touch-none')

    fireEvent.pointerDown(diagram, { clientX: 10, clientY: 20, pointerId: 3, pointerType: 'touch' })
    fireEvent.pointerMove(diagram, { clientX: 35, clientY: 55, pointerId: 3, pointerType: 'touch' })
    expect(diagram).toHaveStyle({ transform: 'translate(25px, 35px) scale(1)' })
    fireEvent.pointerUp(diagram, { pointerId: 3, pointerType: 'touch' })

    fireEvent.pointerDown(diagram, { clientX: 100, clientY: 100, pointerId: 4, pointerType: 'touch' })
    fireEvent.pointerDown(diagram, { clientX: 140, clientY: 100, pointerId: 5, pointerType: 'touch' })
    fireEvent.pointerMove(diagram, { clientX: 180, clientY: 100, pointerId: 5, pointerType: 'touch' })
    expect(diagram).toHaveStyle({ transform: 'translate(-50px, -30px) scale(2)' })
  })
})
