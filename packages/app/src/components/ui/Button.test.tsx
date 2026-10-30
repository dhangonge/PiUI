import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PRESS_TRANSITION_CLASS } from '../../constants/animation'
import { Button } from './Button'

describe('Button', () => {
  it('保留既有静止样式：变体配色 / 圆角 / 尺寸', () => {
    render(<Button>发送</Button>)

    const button = screen.getByRole('button', { name: '发送' })
    expect(button).toHaveClass('rounded-lg')
    expect(button).toHaveClass('bg-accent-main-000')
    expect(button).toHaveClass('h-8')
  })

  it('onClick 正常触发', () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>确认</Button>)

    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('disabled 与 loading 时不触发 onClick', () => {
    const onClick = vi.fn()
    const { rerender } = render(
      <Button disabled onClick={onClick}>
        确认
      </Button>,
    )
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    expect(onClick).not.toHaveBeenCalled()

    rerender(
      <Button isLoading onClick={onClick}>
        确认
      </Button>,
    )
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('过渡只覆盖显式属性，不再用 transition-all', () => {
    render(<Button>发送</Button>)

    const button = screen.getByRole('button', { name: '发送' })
    expect(button).not.toHaveClass('transition-all')
    expect(button).toHaveClass(PRESS_TRANSITION_CLASS)
    // Tailwind 4 的 scale-* 输出独立的 scale 属性，按压需要连它一起过渡
    expect(PRESS_TRANSITION_CLASS).toContain('transition-[background-color,color,opacity,scale]')
    expect(PRESS_TRANSITION_CLASS).toContain('duration-[140ms]')
    expect(PRESS_TRANSITION_CLASS).toContain('ease-[cubic-bezier(0.23,1,0.32,1)]')
  })

  it('保留按压 scale，并在减少动态效果下关掉缩放', () => {
    render(<Button>发送</Button>)

    const button = screen.getByRole('button', { name: '发送' })
    expect(button).toHaveClass('motion-safe:active:scale-95')
    expect(button).not.toHaveClass('active:scale-95')
  })
})
