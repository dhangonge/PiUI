import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNotification } from './useNotification'
import { STORAGE_KEY_NOTIFICATIONS_ENABLED } from '../constants/storage'

const native = vi.hoisted(() => ({ granted: false, request: vi.fn(), send: vi.fn() }))

beforeEach(() => {
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => native.granted })
  vi.stubGlobal(
    'Notification',
    class {
      static get permission() {
        return native.granted ? 'granted' : 'default'
      }
      static requestPermission = native.request
      constructor(...args: unknown[]) {
        native.send(...args)
      }
    },
  )
  native.granted = false
  native.request.mockReset().mockImplementation(async () => {
    native.granted = true
    return 'granted'
  })
  native.send.mockReset()
  localStorage.removeItem(STORAGE_KEY_NOTIFICATIONS_ENABLED)
})
afterEach(() => vi.unstubAllGlobals())

it('can turn notifications off and back on without asking for an already granted permission', async () => {
  const { result } = renderHook(useNotification)
  await act(async () => {
    await result.current.setEnabled(true)
  })
  expect(result.current.enabled).toBe(true)
  await act(async () => {
    await result.current.setEnabled(false)
  })
  expect(result.current.enabled).toBe(false)
  native.request.mockRejectedValue(new Error('must not request granted permission'))
  await act(async () => {
    await result.current.setEnabled(true)
  })
  expect(result.current.enabled).toBe(true)
  expect(result.current.permission).toBe('granted')
  expect(native.request).toHaveBeenCalledTimes(1)
  expect(localStorage.getItem(STORAGE_KEY_NOTIFICATIONS_ENABLED)).toBe('true')
})

it('does not let a delayed permission grant override a newer disable', async () => {
  let resolve!: (value: string) => void
  native.request.mockReturnValue(
    new Promise<string>(done => {
      resolve = done
    }),
  )
  const { result } = renderHook(useNotification)
  let enabling!: Promise<void>
  act(() => {
    enabling = result.current.setEnabled(true)
  })
  await waitFor(() => expect(native.request).toHaveBeenCalledTimes(1))
  await act(async () => {
    await result.current.setEnabled(false)
  })
  await act(async () => {
    native.granted = true
    resolve('granted')
    await enabling
  })
  expect(result.current.enabled).toBe(false)
  expect(localStorage.getItem(STORAGE_KEY_NOTIFICATIONS_ENABLED)).toBeNull()
})

it('does not ask for permission from a background notification', async () => {
  localStorage.setItem(STORAGE_KEY_NOTIFICATIONS_ENABLED, 'true')
  const { result } = renderHook(useNotification)
  await act(async () => {
    await result.current.sendNotification('Complete', 'Finished')
  })
  expect(native.request).not.toHaveBeenCalled()
  expect(native.send).not.toHaveBeenCalled()
})

it('does not mark a blocked browser notification setting as enabled', async () => {
  vi.unstubAllGlobals()
  vi.stubGlobal('Notification', { permission: 'denied', requestPermission: vi.fn() })
  const { result } = renderHook(useNotification)
  await act(async () => {
    await result.current.setEnabled(true)
  })
  expect(result.current.enabled).toBe(false)
  expect(result.current.permission).toBe('denied')
})
