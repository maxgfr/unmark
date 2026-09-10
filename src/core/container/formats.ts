/** Shared by the engine's format type, the file picker and the UI's format count. */
export const CONTAINER_FORMATS = {
  PNG: ['.png'],
  JPEG: ['.jpg', '.jpeg'],
  WebP: ['.webp'],
  GIF: ['.gif'],
  HEIC: ['.heic', '.heif'],
  AVIF: ['.avif'],
  MP4: ['.mp4', '.m4v', '.mov'],
  SVG: ['.svg'],
  PDF: ['.pdf'],
  DOCX: ['.docx'],
  PPTX: ['.pptx'],
  XLSX: ['.xlsx'],
  ODT: ['.odt'],
  EPUB: ['.epub'],
  HTML: ['.html', '.htm'],
  Markdown: ['.md', '.markdown'],
  Text: ['.txt'],
} as const

export type ContainerFormat = keyof typeof CONTAINER_FORMATS | 'unknown'
export const SUPPORTED_FORMATS = Object.keys(CONTAINER_FORMATS) as Exclude<
  ContainerFormat,
  'unknown'
>[]
export const FILE_ACCEPT = Object.values(CONTAINER_FORMATS).flat().join(',')
export const FORMAT_LABELS = SUPPORTED_FORMATS.map((format) =>
  format === 'MP4' ? 'MP4/MOV' : format,
).join(' · ')
