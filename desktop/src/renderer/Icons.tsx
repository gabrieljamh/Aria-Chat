import React from "react"

type P = { size?: number; className?: string }
const svg = (children: React.ReactNode, size = 16, className?: string) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    {children}
  </svg>
)

export const IconPlus = ({ size }: P) => svg(<><path d="M12 5v14M5 12h14" /></>, size)
export const IconSend = ({ size }: P) => svg(<><path d="M12 19V5M5 12l7-7 7 7" /></>, size)
export const IconMic = ({ size }: P) =>
  svg(
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>,
    size,
  )
export const IconFile = ({ size }: P) =>
  svg(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>, size)
export const IconSkill = ({ size }: P) =>
  svg(<><path d="m12 2 2.4 6.9H22l-6 4.4 2.3 6.9L12 16l-6.3 4.2L8 13.3 2 8.9h7.6z" /></>, size)
export const IconPlug = ({ size }: P) =>
  svg(<><path d="M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0zM12 16v6" /></>, size)
export const IconGlobe = ({ size }: P) =>
  svg(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>, size)
export const IconFolder = ({ size }: P) =>
  svg(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>, size)
export const IconChat = ({ size }: P) =>
  svg(<><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-5A8 8 0 1 1 21 12z" /></>, size)
export const IconClock = ({ size }: P) => svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>, size)
export const IconLayers = ({ size }: P) =>
  svg(<><path d="m12 3 9 5-9 5-9-5 9-5zM3 14l9 5 9-5" /></>, size)
export const IconSettings = ({ size }: P) =>
  svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </>,
    size,
  )
export const IconCheck = ({ size }: P) => svg(<><path d="M20 6 9 17l-5-5" /></>, size)
export const IconRefresh = ({ size }: P) =>
  svg(<><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" /></>, size)
export const IconCode = ({ size }: P) => svg(<><path d="m16 18 6-6-6-6M8 6l-6 6 6 6" /></>, size)
export const IconSparkle = ({ size }: P) =>
  svg(<><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" /></>, size)
export const IconEdit = ({ size }: P) =>
  svg(<><path d="M17 3a2.8 2.8 0 1 1 4 4L8.5 19.5 3 21l1.5-5.5L17 3z" /></>, size)
export const IconTrash = ({ size }: P) =>
  svg(<><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 10v8M14 10v8" /></>, size)
export const IconFork = ({ size }: P) =>
  svg(<><path d="M6 5v14M6 5l6-2M6 5l6 2M12 3v18M18 8v11M18 8l-6-1M18 8l-6 2" /></>, size)
export const IconChevronDown = ({ size }: P) => svg(<><path d="M6 9l6 6 6-6" /></>, size)
export const IconRegen = ({ size }: P) => IconRefresh({ size })
