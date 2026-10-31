import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PRESS_TRANSITION_CLASS } from '../../constants/animation'
import { MenuItem } from './MenuItem'

describe('MenuItem', () => {
  it('渲染标签、描述与图标', () => {
    const { container } = render(
      <MenuItem label="深度思考" description="推理过程会显示出来" icon={<span data-testid="icon" />} />,
    )

    expect(screen.getByText('深度思考')).toBeInTheDocument()
    expect(screen.getByText('推理过程会显示出来')).toBeInTheDocument()
    expect(screen.getByTestId('icon')).toBeInTheDocument()
    expect(container.querySelector('svg')).toBeNull()
  })

  it('onClick 正常触发，disabled 时不触发', () => {
    const onClick = vi.fn()
    const { rerender } = render(<MenuItem label="菜单项" onClick={onClick} />)
    fireEvent.click(screen.getByRole('button', { name: '菜单项' }))
    expect(onClick).toHaveBeenCalledTimes(1)

    rerender(<MenuItem label="菜单项" disabled onClick={onClick} />)
    fireEvent.click(screen.getByRole('button', { name: '菜单项' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('选中态显示勾选标记并保持可聚焦', () => {
    const { container } = render(<MenuItem label="模型 A" selected selectionRole="menuitemradio" />)

    const item = screen.getByRole('menuitemradio')
    expect(item).toHaveAttribute('aria-checked', 'true')
    expect(item).toHaveAttribute('tabindex', '0')
    // 勾选标记是唯一的内联 svg
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('option 角色使用 aria-selected', () => {
    render(<MenuItem label="模型 A" selected selectionRole="option" />)

    const item = screen.getByRole('option')
    expect(item).toHaveAttribute('aria-selected', 'true')
  })

  it('过渡只覆盖显式属性，不再用 transition-all', () => {
    render(<MenuItem label="菜单项" />)

    const item = screen.getByRole('button', { name: '菜单项' })
    expect(item).not.toHaveClass('transition-all')
    expect(item).toHaveClass(PRESS_TRANSITION_CLASS)
    // 既有状态：hover / 选中改 background-color 与 color，按压改 scale；
    // 自身没有 border / box-shadow / ring，所以不列
    expect(PRESS_TRANSITION_CLASS).toContain('background-color')
    expect(PRESS_TRANSITION_CLASS).toContain('color')
    expect(PRESS_TRANSITION_CLASS).toContain('scale')
  })

  it('保留按压 scale，减少动态效果下不缩放；disabled 没有按压反馈', () => {
    const { rerender } = render(<MenuItem label="菜单项" />)
    const item = screen.getByRole('button', { name: '菜单项' })
    expect(item).toHaveClass('motion-safe:active:scale-[0.98]')
    expect(item).not.toHaveClass('active:scale-[0.98]')

    rerender(<MenuItem label="菜单项" disabled />)
    expect(screen.getByRole('button', { name: '菜单项' })).not.toHaveClass('motion-safe:active:scale-[0.98]')
  })
})
