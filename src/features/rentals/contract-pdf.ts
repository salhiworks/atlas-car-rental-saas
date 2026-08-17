import type { DocumentProps } from '@react-pdf/renderer'
import { createElement, type ReactElement } from 'react'

import type { ContractSnapshot } from '@/types/database'

/**
 * Turning the contract component into PDF bytes.
 *
 * Kept apart from the component so the document stays a pure function of the
 * snapshot and can be rendered in Node by the test suite. Both the renderer and
 * the document are imported dynamically: @react-pdf is a large dependency, and
 * nobody should download a PDF engine to look at the rentals list.
 */

/**
 * The renderer's signature asks for an element whose props are DocumentProps.
 * ContractDocument takes a snapshot and returns exactly such a Document, but
 * the element type cannot express that, so it is stated here once rather than
 * at every call site.
 */
export async function contractElement(
  snapshot: ContractSnapshot,
): Promise<ReactElement<DocumentProps>> {
  const { ContractDocument } = await import('./contract-document')
  return createElement(ContractDocument, { snapshot }) as unknown as ReactElement<DocumentProps>
}

export async function renderContractPdf(snapshot: ContractSnapshot): Promise<Blob> {
  const [{ pdf }, element] = await Promise.all([
    import('@react-pdf/renderer'),
    contractElement(snapshot),
  ])
  return pdf(element).toBlob()
}

/** Filename an agency would recognise in their downloads folder. */
export function contractFileName(snapshot: ContractSnapshot): string {
  const safeNumber = snapshot.contract_number.replace(/[^A-Za-z0-9-]/g, '')
  const suffix = snapshot.version > 1 ? `-v${snapshot.version}` : ''
  return `${safeNumber}${suffix}.pdf`
}
