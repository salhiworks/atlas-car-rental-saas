import { createContext, useContext } from 'react'

export type ToastTone = 'info' | 'positive' | 'caution' | 'critical'

export interface ToastOptions {
  title: string
  description?: string
  tone?: ToastTone
  /** Milliseconds before auto-dismissal. Pass 0 to require a manual dismiss. */
  duration?: number
}

export interface ToastRecord extends Required<Omit<ToastOptions, 'description'>> {
  id: string
  description: string | undefined
}

export interface ToastApi {
  /** Shows a toast and returns its id, so a long-running action can dismiss its own. */
  toast: (options: ToastOptions) => string
  success: (title: string, description?: string) => string
  error: (title: string, description?: string) => string
  dismiss: (id: string) => void
}

export const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used inside <ToastProvider>.')
  }
  return context
}
