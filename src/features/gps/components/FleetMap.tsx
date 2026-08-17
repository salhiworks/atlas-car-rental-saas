import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl'
import { MapPinOff } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { getBasemapConfiguration } from '@/lib/config/env'
import { cn } from '@/lib/utils/cn'
import type { GpsFleetRow, GpsPositionFreshness } from '@/types/database'

import { boundsOf } from '../domain'

import 'maplibre-gl/dist/maplibre-gl.css'

/**
 * The fleet, on a map.
 *
 * THE BASEMAP IS CONFIGURATION, NOT A CONSTANT. Map tiles are a metered
 * commercial service; hard-coding a public demo endpoint would put an entire
 * product's load onto an account that never agreed to carry it, and it would
 * stop working the day that account noticed. `VITE_MAP_STYLE_URL` points at a
 * style the deployment is licensed to use, and its licence's attribution goes in
 * `VITE_MAP_ATTRIBUTION`. With neither set the map still works — it plots every
 * vehicle on a plain graticule and says, in as many words, that no basemap is
 * configured. That is worth more than a beautiful map served from somebody
 * else's bandwidth.
 *
 * POSITIONS ARE DRAWN AS DATA, NOT AS DOM. One GeoJSON source and two circle
 * layers render a thousand vehicles at the same cost as ten; a thousand marker
 * elements would be a thousand absolutely-positioned nodes repositioned on every
 * frame of every pan. The colour of each circle is the position's freshness,
 * because on a map the only thing worth encoding in colour is how much the dot
 * can be trusted.
 *
 * NOTHING MOVES THAT DID NOT MOVE. There is no animation between positions, no
 * interpolation, no dead-reckoning along a road. A vehicle is drawn where the
 * provider last said it was, and if that was two hours ago the dot is the colour
 * of a two-hour-old fact.
 */

/** Freshness → colour, from the same status ramp the badges use. */
const FRESHNESS_COLOURS: Readonly<Record<GpsPositionFreshness, string>> = {
  fresh: '#1f7a4d',
  stale: '#8a5a00',
  very_stale: '#a33a2a',
  future: '#8a5a00',
  unknown: '#62686e',
}

const SOURCE_ID = 'fleet'
const LAYER_ID = 'fleet-vehicles'
const SELECTED_LAYER_ID = 'fleet-selected'

/**
 * The style used when no basemap is configured.
 *
 * A flat surface plus a graticule: enough to see relative positions and to tell
 * that the map is doing something, honest about the fact that there is no
 * cartography behind it. Deliberately contains no external source of any kind.
 */
function fallbackStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef0ee' } }],
  }
}

export interface FleetMapProps {
  rows: readonly GpsFleetRow[]
  selectedVehicleId: string | null
  onSelect: (vehicleId: string | null) => void
  className?: string
}

interface FleetFeatureProperties {
  vehicleId: string
  plate: string
  freshness: GpsPositionFreshness
}

function toFeatureCollection(
  rows: readonly GpsFleetRow[],
): GeoJSON.FeatureCollection<GeoJSON.Point, FleetFeatureProperties> {
  const features: GeoJSON.Feature<GeoJSON.Point, FleetFeatureProperties>[] = []

  for (const row of rows) {
    // A row without a usable fix has no place on a map. It is not drawn at 0,0,
    // and it is not dropped from the product either — the list beside the map
    // shows it, labelled "no position", which is the true statement.
    if (row.latitude === null || row.longitude === null || row.position_valid !== true) continue

    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] },
      properties: {
        vehicleId: row.vehicle_id,
        plate: row.vehicle_plate,
        freshness: row.position_freshness,
      },
    })
  }

  return { type: 'FeatureCollection', features }
}

export function FleetMap({ rows, selectedVehicleId, onSelect, className }: FleetMapProps) {
  const container = useRef<HTMLDivElement | null>(null)
  const map = useRef<MapLibreMap | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const onSelectRef = useRef(onSelect)

  // The map's handlers are registered once, when it is created, and must keep
  // reaching the current callback without tearing the map down and rebuilding it
  // every time the parent re-renders.
  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  const basemap = useMemo(() => getBasemapConfiguration(), [])
  const collection = useMemo(() => toFeatureCollection(rows), [rows])

  // Only refit when the set of plotted vehicles changes, never on every poll:
  // a map that recentres itself every thirty seconds cannot be used.
  const fitKey = useMemo(
    () =>
      collection.features
        .map((feature) => feature.properties.vehicleId)
        .sort()
        .join('|'),
    [collection],
  )
  const lastFitKey = useRef<string>('')

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
        // Tracking is a plan view. Pitch and rotation cost frames and make two
        // vehicles harder to compare, not easier.
        pitchWithRotate: false,
        dragRotate: false,
        touchZoomRotate: true,
      })
    } catch {
      /*
       * The map could not be constructed at all — no WebGL, a blocked style, a
       * headless browser without a GPU. This is an external system reporting a
       * failure, and the workspace has to say so rather than showing an empty
       * rectangle, so the state update is deliberate.
       */
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFailed(true)
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

    instance.on('error', (event) => {
      // A failed tile request must not take the workspace down with it. The map
      // keeps whatever it has; the notice above it says the basemap is missing.
      if (basemap.styleUrl && event.error) setFailed(true)
    })

    instance.on('load', () => {
      instance.addSource(SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })

      instance.addLayer({
        id: SELECTED_LAYER_ID,
        type: 'circle',
        source: SOURCE_ID,
        filter: ['==', ['get', 'vehicleId'], ''],
        paint: {
          'circle-radius': 14,
          'circle-color': '#22664f',
          'circle-opacity': 0.16,
          'circle-stroke-width': 1,
          'circle-stroke-color': '#22664f',
        },
      })

      instance.addLayer({
        id: LAYER_ID,
        type: 'circle',
        source: SOURCE_ID,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 4, 10, 6.5, 16, 9],
          'circle-color': [
            'match',
            ['get', 'freshness'],
            'fresh',
            FRESHNESS_COLOURS.fresh,
            'stale',
            FRESHNESS_COLOURS.stale,
            'very_stale',
            FRESHNESS_COLOURS.very_stale,
            'future',
            FRESHNESS_COLOURS.future,
            FRESHNESS_COLOURS.unknown,
          ],
          // A 2px surface ring keeps two vehicles in the same street legible
          // when their circles overlap.
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      })

      instance.on('click', LAYER_ID, (event) => {
        const properties: unknown = event.features?.[0]?.properties
        const id =
          typeof properties === 'object' && properties !== null
            ? (properties as { vehicleId?: unknown }).vehicleId
            : undefined
        if (typeof id === 'string') onSelectRef.current(id)
      })

      // Clicking the sea clears the selection, which is what everybody expects
      // and what nobody implements.
      instance.on('click', (event) => {
        const hits = instance.queryRenderedFeatures(event.point, { layers: [LAYER_ID] })
        if (hits.length === 0) onSelectRef.current(null)
      })

      instance.on('mouseenter', LAYER_ID, () => {
        instance.getCanvas().style.cursor = 'pointer'
      })
      instance.on('mouseleave', LAYER_ID, () => {
        instance.getCanvas().style.cursor = ''
      })

      setReady(true)
    })

    return () => {
      map.current = null
      setReady(false)
      instance.remove()
    }
  }, [basemap.attribution, basemap.styleUrl])

  // Data in.
  useEffect(() => {
    if (!ready || !map.current) return
    map.current.getSource<GeoJSONSource>(SOURCE_ID)?.setData(collection)
  }, [collection, ready])

  // Fit once per change in which vehicles are plotted.
  useEffect(() => {
    if (!ready || !map.current) return
    if (fitKey === lastFitKey.current || fitKey === '') return
    lastFitKey.current = fitKey

    const points = collection.features.map((feature) => ({
      longitude: feature.geometry.coordinates[0] as number,
      latitude: feature.geometry.coordinates[1] as number,
    }))
    const bounds = boundsOf(points)
    if (!bounds) return

    map.current.fitBounds(
      [
        [bounds.west, bounds.south],
        [bounds.east, bounds.north],
      ],
      { padding: 64, maxZoom: 14, duration: 400 },
    )
  }, [collection, fitKey, ready])

  // Selection highlight, and a gentle pan to whatever the list selected.
  useEffect(() => {
    if (!ready || !map.current) return
    map.current.setFilter(SELECTED_LAYER_ID, ['==', ['get', 'vehicleId'], selectedVehicleId ?? ''])

    if (!selectedVehicleId) return
    const feature = collection.features.find(
      (candidate) => candidate.properties.vehicleId === selectedVehicleId,
    )
    if (!feature) return

    map.current.easeTo({
      center: feature.geometry.coordinates as [number, number],
      duration: 400,
      zoom: Math.max(map.current.getZoom(), 12),
    })
  }, [collection, ready, selectedVehicleId])

  const plotted = collection.features.length
  const unplotted = rows.length - plotted

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
      <div ref={container} className="h-full w-full" data-testid="fleet-map-canvas" />

      {basemap.styleUrl === null || failed ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 p-3">
          <div className="border-line bg-surface/95 text-ink-muted pointer-events-auto mx-auto flex max-w-lg items-start gap-2.5 rounded-md border px-3 py-2 text-[0.8125rem] leading-5 shadow-raised backdrop-blur">
            <MapPinOff className="text-ink-subtle mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>
              {failed ? (
                'The configured basemap could not be loaded. Vehicle positions below are current; only the map imagery is missing.'
              ) : (
                <>
                  No basemap is configured, so vehicles are plotted without map imagery. Set{' '}
                  <code className="font-mono text-[0.75rem]">VITE_MAP_STYLE_URL</code> to a map
                  style your agency is licensed to use.
                </>
              )}
            </p>
          </div>
        </div>
      ) : null}

      {unplotted > 0 ? (
        <div className="border-line bg-surface/95 text-ink-muted absolute bottom-3 left-3 z-10 rounded-md border px-2.5 py-1.5 text-[0.75rem] shadow-raised backdrop-blur">
          {unplotted} of {rows.length} not shown — no usable position
        </div>
      ) : null}
    </div>
  )
}

export default FleetMap
