// One authored icon set: 16px grid, 1.5px stroke, round caps, no fills.
//
// Drawn rather than borrowed from an emoji font, because an emoji renders in
// whatever the platform decided it looks like — different weight, different
// colour, different size on every OS — and this page's whole scanning
// affordance is one reserved amber that nothing else may spend.

interface IconProps {
  className?: string
}

const base = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

export const IconCopy = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="5.75" y="5.75" width="8.5" height="8.5" rx="1.5" />
    <path d="M10.25 5.75V3.25a1.5 1.5 0 0 0-1.5-1.5h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5h2.5" />
  </svg>
)

export const IconCheck = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="m2.75 8.5 3.5 3.5 7-7.5" />
  </svg>
)

export const IconDownload = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M8 1.75v8.5m0 0L4.75 7m3.25 3.25L11.25 7" />
    <path d="M2.25 11.75v1.5a1 1 0 0 0 1 1h9.5a1 1 0 0 0 1-1v-1.5" />
  </svg>
)

export const IconFile = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M9.25 1.75H4a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z" />
    <path d="M9.25 1.75V5.5H13" />
  </svg>
)

export const IconText = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M2.75 3.75h10.5M2.75 8h10.5M2.75 12.25h6" />
  </svg>
)

export const IconImage = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <rect x="2" y="3" width="12" height="10" rx="1" />
    <circle cx="5.75" cy="6.25" r="1" />
    <path d="m2.75 11.5 3-3 2.5 2.5 2-1.75 3 2.75" />
  </svg>
)

export const IconAlert = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M8 5.5v3.25M8 11.25h.008" />
    <circle cx="8" cy="8" r="6.25" />
  </svg>
)

export const IconTrash = ({ className }: IconProps) => (
  <svg {...base} className={className}>
    <path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4.25 4.25l.6 8.4a1 1 0 0 0 1 .85h4.3a1 1 0 0 0 1-.85l.6-8.4" />
  </svg>
)
