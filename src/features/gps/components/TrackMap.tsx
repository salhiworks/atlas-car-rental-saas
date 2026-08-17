import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl'
import { useEffect, useMemo, useRef, useState } from 'react'

import { getBasemapConfiguration } from '@/lib/config/env'
import { cn } from '@/lib/utils/cn'
import type { GpsTrackPoint } from '@/types/database'

import { boundsOf } from '../domain'

import 'maplibre-gl/dist/maplibre-gl.css'

/**
 * One vehicle's reported positions, in the order the provider reported them.
 *
 * The line joins consecutive reports with straight segments. It does NOT snap to
 * roads, interpolate between reports, or smooth a jagged sequence into a
 * plausible route. A tracker reporting every two minutes on a motorway produces
 * a line that cuts every bend, and that is the honest picture of what was
 * recorded — a route drawn through the road network would be a guess presented
 * with the same confidence as a measurement.
 *
 * Start and end are marked because the direction of travel is not visible from a
 * line, and every reported point is drawn as a small dot so the reporting
 * interval — the thing that determines how much this track can be trusted — is
 * visible rather than hidden by the line.
 */

const LINE_SOURCE = 'track-line'
const POINT_SOURCE = 'track-points'
const ENDS_SOURCE = 'track-ends'

function fallbackStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef0ee' } }],
  }
}

export interface TrackMapProps {
  /** Already thinned for drawing by the caller; never re-ordered here. */
  points: readonly GpsTrackPoint[]
  className?: string
}

export function TrackMap({ points, className }: TrackMapProps) {
  const container = useRef<HTMLDivElement | null>(null)
  const map = useRef<MapLibreMap | null>(null)
  const [ready, setReady] = useState(false)

  const basemap = useMemo(() => getBasemapConfiguration(), [])

  const geometry = useMemo(() => {
    const coordinates = points.map((point) => [point.longitude, point.latitude] as [number, number])
    const first = points[0]
    const last = points[points.length - 1]

    return {
      line: {
        type: 'FeatureCollection',
        features:
          coordinates.length > 1
            ? [
                {
                  type: 'Feature' as const,
                  geometry: { type: 'LineString' as const, coordinates },
                  properties: {},
                },
              ]
            : [],
      } satisfies GeoJSON.FeatureCollection,
      dots: {
        type: 'FeatureCollection',
        features: coordinates.map((coordinate) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: coordinate },
          properties: {},
        })),
      } satisfies GeoJSON.FeatureCollection,
      ends: {
        type: 'FeatureCollection',
        features:
          first && last
            ? [
                {
                  type: 'Feature' as const,
                  geometry: {
                    type: 'Point' as const,
                    coordinates: [first.longitude, first.latitude],
                  },
                  properties: { role: 'start' },
                },
                {
                  type: 'Feature' as const,
                  geometry: {
                    type: 'Point' as const,
                    coordinates: [last.longitude, last.latitude],
                  },
                  properties: { role: 'end' },
                },
              ]
            : [],
      } satisfies GeoJSON.FeatureCollection,
      coordinates,
    }
  }, [points])

  useEffect(() => {
    if (!container.current || map.current) return

    let instance: MapLibreMap
    try {
      instance = new maplibregl.Map({
        container: container.current,
        style: basemap.styleUrl ?? fallbackStyle(),
        center: [0, 20],
        zoom: 1.4,
        attributionControl: false,
        pitchWithRotate: false,
        dragRotate: false,
      })
    } catch {
      return
    }

    map.current = instance
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    instance.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: basemap.attribution ?? undefined,
      }),
      'bottom-right',
    )

    instance.on('load', () => {
      const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
      instance.addSource(LINE_SOURCE, { type: 'geojson', data: empty })
      instance.addSource(POINT_SOURCE, { type: 'geojson', data: empty })
      instance.addSource(ENDS_SOURCE, { type: 'geojson', data: empty })

      instance.addLayer({
        id: 'track-line',
        type: 'line',
        source: LINE_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#22664f', 'line-width': 2, 'line-opacity': 0.85 },
      })

      instance.addLayer({
        id: 'track-dots',
        type: 'circle',
        source: POINT_SOURCE,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 14, 3],
          'circle-color': '#22664f',
          'circle-opacity': 0.55,
        },
      })

      instance.addLayer({
        id: 'track-ends',
        type: 'circle',
        source: ENDS_SOURCE,
        paint: {
          'circle-radius': 6.5,
          'circle-color': ['match', ['get', 'role'], 'start', '#62686e', '#1f7a4d'],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      })

      setReady(true)
    })

    return () => {
      map.current = null
      setReady(false)
      instance.remove()
    }
  }, [basemap.attribution, basemap.styleUrl])

  useEffect(() => {
    if (!ready || !map.current) return
    const instance = map.current
    instance.getSource<GeoJSONSource>(LINE_SOURCE)?.setData(geometry.line)
    instance.getSource<GeoJSONSource>(POINT_SOURCE)?.setData(geometry.dots)
    instance.getSource<GeoJSONSource>(ENDS_SOURCE)?.setData(geometry.ends)

    const bounds = boundsOf(
      geometry.coordinates.map(([longitude, latitude]) => ({ longitude, latitude })),
    )
    if (!bounds) return

    instance.fitBounds(
      [
        [bounds.west, bounds.south],
        [bounds.east, bounds.north],
      ],
      { padding: 48, maxZoom: 15, duration: 0 },
    )
  }, [geometry, ready])

  return (
    <div className={cn('relative isolate overflow-hidden', className)}>
      {/*
        Sized with h-full rather than `absolute inset-0`.

        MapLibre stamps `.maplibregl-map` on whatever element it is given,
        and that class sets `position: relative` — same specificity as
        Tailwind's `absolute`, so whichever stylesheet loads last wins. When
        MapLibre's did, the element stopped being positioned, `inset-0` no
        longer sized it, its height collapsed to zero, and the canvas was
        clipped out of existence by the class's own `overflow: hidden`. The
        map looked like an empty rectangle with no error anywhere.
      */}
      <div ref={container} className="h-full w-full" data-testid="track-map-canvas" />
      {basemap.styleUrl === null ? (
        <p className="border-line bg-surface/95 text-ink-muted absolute top-2 left-2 z-10 rounded-md border px-2 py-1 text-[0.6875rem] shadow-raised">
          No basemap configured
        </p>
      ) : null}
    </div>
  )
}

export default TrackMap
