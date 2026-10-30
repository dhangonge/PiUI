import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PRESS_TRANSITION_CLASS } from '../../constants/animation'
import { IconButton } from './IconButton'

describe('IconButton', () => {
  it('保留既有静止样式：变体配色 / 圆角 / 尺寸', () => {
    render(
      <IconButton aria-label="更多">
        <span />
      </IconButton>,
    )

    const button = screen.getByRole('button', { name: '更多' })
    expect(button).toHaveClass('rounded-lg')
    expect(button).toHaveClass('h-8')
    expect(button).toHaveClass('w-8')
    expect(button).toHaveClass('bg-transparent')
  })

  it('onClick 正常触发，disabled 时不触发', () => {
    const onClick = vi.fn()
    const { rerender } = render(
      <IconButton aria-label="更多" onClick={onClick}>
        <span />
      </IconButton>,
    )
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    expect(onClick).toHaveBeenCalledTimes(1)

    rerender(
      <IconButton aria-label="更多" disabled onClick={onClick}>
        <span />
      </IconButton>,
    )
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('过渡只覆盖显式属性，不再用 transition-all', () => {
    render(
      <IconButton aria-label="更多">
        <span />
      </IconButton>,
    )

    const button = screen.getByRole('button', { name: '更多' })
    expect(button).not.toHaveClass('transition-all')
    expect(button).toHaveClass(PRESS_TRANSITION_CLASS)
    // 按压走 Tailwind 4 的 scale 属性，不是 transform
    expect(PRESS_TRANSITION_CLASS).toContain('scale')
  })

  it('保留按压 scale，并在减少动态效果下关掉缩放', () => {
    render(
      <IconButton aria-label="更多">
        <span />
      </IconButton>,
    )

    const button = screen.getByRole('button', { name: '更多' })
    expect(button).toHaveClass('motion-safe:active:scale-90')
    expect(button).not.toHaveClass('active:scale-90')
  })
})
