import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui'

export interface SignaturePadProps {
  onChange: (blob: Blob | null) => void
  label: string
}

/**
 * Signing on the screen.
 *
 * Optional throughout: plenty of agencies print, sign on paper and file it, and
 * a drawn signature is not claimed to be more than what it is — a record that
 * the person was present at the counter and agreed. It is stored as a PNG in
 * the same private bucket as the contract, never in the contract snapshot.
 *
 * Pointer events rather than mouse or touch events, so a pen, a finger and a
 * trackpad all draw with one code path.
 */
export function SignaturePad({ onChange, label }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawing = useRef(false)
  const [hasInk, setHasInk] = useState(false)

  // The canvas is sized to its own device pixels so a signature is not a blurry
  // upscale on the tablets these are usually taken on.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ratio = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = Math.round(rect.width * ratio)
    canvas.height = Math.round(rect.height * ratio)

    const context = canvas.getContext('2d')
    if (!context) return
    context.scale(ratio, ratio)
    context.lineWidth = 1.8
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.strokeStyle = '#101614'
  }, [])

  const position = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const start = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const context = canvasRef.current?.getContext('2d')
    if (!context) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drawing.current = true
    const { x, y } = position(event)
    context.beginPath()
    context.moveTo(x, y)
  }

  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return
    const context = canvasRef.current?.getContext('2d')
    if (!context) return
    const { x, y } = position(event)
    context.lineTo(x, y)
    context.stroke()
    if (!hasInk) setHasInk(true)
  }

  const end = useCallback(() => {
    if (!drawing.current) return
    drawing.current = false

    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob((blob) => onChange(blob), 'image/png')
  }, [onChange])

  const clear = () => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    setHasInk(false)
    onChange(null)
  }

  return (
    <div className="space-y-2">
      <div className="border-line bg-surface overflow-hidden rounded-md border">
        <canvas
          ref={canvasRef}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
          className="block h-32 w-full touch-none"
          aria-label={label}
          role="img"
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-ink-subtle text-[0.75rem]">{label}</p>
        <Button variant="ghost" size="sm" onClick={clear} disabled={!hasInk}>
          Clear
        </Button>
      </div>
    </div>
  )
}
