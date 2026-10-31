import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  SETTINGS_COLOR_TRANSITION_CLASS,
  SETTINGS_DISCLOSURE_PANEL_CLASS,
  SETTINGS_MOVE_TRANSITION_CLASS,
} from '../settingsMotion'
import { SegmentedControl, SettingRow, SettingsDisclosure, SettingsSelect, Toggle } from './SettingsUI'

describe('Settings UI primitives', () => {
  it('uses the row label for its single switch focus target', () => {
    const onRowClick = vi.fn()
    const onToggle = vi.fn()
    render(
      <SettingRow label="Notifications" onClick={onRowClick}>
        <Toggle enabled={true} onChange={onToggle} />
      </SettingRow>,
    )

    const toggle = screen.getByRole('switch', { name: 'Notifications' })
    expect(toggle.closest('[data-setting-label]')).toHaveAttribute('data-setting-label', 'Notifications')
    expect(screen.queryByRole('button', { name: 'Notifications' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Notifications'))
    expect(onRowClick).toHaveBeenCalledTimes(1)
    fireEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onRowClick).toHaveBeenCalledTimes(1)
  })

  it('moves focus with the selected segmented option', () => {
    function Harness() {
      const [value, setValue] = useState<'one' | 'two'>('one')
      return (
        <SegmentedControl
          value={value}
          options={[
            { value: 'one', label: 'One' },
            { value: 'two', label: 'Two' },
          ]}
          onChange={setValue}
        />
      )
    }

    render(<Harness />)
    const first = screen.getByRole('tab', { name: 'One' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })

    expect(screen.getByRole('tab', { name: 'Two' })).toHaveFocus()
  })

  it('keeps focus on the selected option when a change is rejected', () => {
    render(
      <SegmentedControl
        value="one"
        options={[
          { value: 'one', label: 'One' },
          { value: 'two', label: 'Two' },
        ]}
        onChange={() => false}
      />,
    )

    const first = screen.getByRole('tab', { name: 'One' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(first).toHaveFocus()

    fireEvent.click(screen.getByRole('tab', { name: 'Two' }))
    expect(first).toHaveFocus()
  })
})

describe('Settings UI state feedback', () => {
  it('keeps the disclosure lazy until the first open, then keeps it mounted', () => {
    render(
      <SettingsDisclosure title="Raw config" count={2}>
        <div>Disclosure payload</div>
      </SettingsDisclosure>,
    )

    const trigger = screen.getByRole('button', { name: /Raw config/ })
    const panel = document.getElementById(trigger.getAttribute('aria-controls')!)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(panel).not.toBeNull()
    expect(screen.queryByText('Disclosure payload')).not.toBeInTheDocument()

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Disclosure payload')).toBeInTheDocument()

    // 折叠后保持挂载：不卸载子树，内部状态不丢
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Disclosure payload')).toBeInTheDocument()
    expect(document.getElementById(trigger.getAttribute('aria-controls')!)).toBe(panel)
  })

  it('syncs the disclosure chevron with the real row height transition', () => {
    render(
      <SettingsDisclosure title="Raw config" defaultOpen>
        <div>Disclosure payload</div>
      </SettingsDisclosure>,
    )

    const trigger = screen.getByRole('button', { name: /Raw config/ })
    const panel = document.getElementById(trigger.getAttribute('aria-controls')!)!
    const chevron = trigger.querySelector('svg')!

    expect(panel).toHaveClass('grid', 'grid-rows-[1fr]')
    for (const className of SETTINGS_DISCLOSURE_PANEL_CLASS.split(' ')) {
      expect(panel).toHaveClass(className)
    }
    // 箭头与行高同一时长、同一曲线，减少动态效果时同时归零
    expect(chevron).toHaveClass(...SETTINGS_MOVE_TRANSITION_CLASS.split(' '))
    expect(chevron).not.toHaveClass('-rotate-90')

    fireEvent.click(trigger)
    expect(panel).toHaveClass('grid-rows-[0fr]')
    expect(chevron).toHaveClass('-rotate-90')
  })

  it('moves the switch knob with an explicit, reduce-aware transition', () => {
    const { rerender } = render(<Toggle enabled={false} onChange={vi.fn()} ariaLabel="Keep awake" />)
    const toggle = screen.getByRole('switch', { name: 'Keep awake' })
    const knob = toggle.firstElementChild as HTMLElement

    expect(toggle).toHaveClass(...SETTINGS_COLOR_TRANSITION_CLASS.split(' '))
    expect(toggle).not.toHaveClass('transition-all')
    expect(knob).toHaveClass(...SETTINGS_MOVE_TRANSITION_CLASS.split(' '))
    expect(knob).toHaveClass('motion-reduce:transition-none')
    expect(knob.style.transform).toBe('translateX(0px)')

    rerender(<Toggle enabled onChange={vi.fn()} ariaLabel="Keep awake" />)
    expect(knob.style.transform).toBe('translateX(16px)')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  it('moves the segmented indicator with the same named move spec', () => {
    const { container } = render(
      <SegmentedControl
        value="one"
        options={[
          { value: 'one', label: 'One' },
          { value: 'two', label: 'Two' },
        ]}
        onChange={vi.fn()}
      />,
    )
    const indicator = container.firstElementChild?.firstElementChild as HTMLElement

    expect(indicator).toHaveClass(...SETTINGS_MOVE_TRANSITION_CLASS.split(' '))
    expect(indicator).not.toHaveClass('duration-300')
    expect(indicator.style.transform).toBe('translateX(0%)')
    expect(screen.getByRole('tab', { name: 'One' })).toHaveClass(...SETTINGS_COLOR_TRANSITION_CLASS.split(' '))
  })

  it('rotates the select chevron only through the named move spec', () => {
    render(
      <SettingsSelect
        value="one"
        ariaLabel="Pick one"
        options={[
          { value: 'one', label: 'One' },
          { value: 'two', label: 'Two' },
        ]}
        onChange={vi.fn()}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Pick one' })
    const chevron = trigger.querySelector('svg')!

    expect(trigger).toHaveClass(...SETTINGS_COLOR_TRANSITION_CLASS.split(' '))
    expect(chevron).toHaveClass(...SETTINGS_MOVE_TRANSITION_CLASS.split(' '))
    expect(chevron).not.toHaveClass('rotate-180')

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(chevron).toHaveClass('rotate-180')
  })
})
