import { Limits, Section } from './parts.tsx'

export function ImageTab() {
  return (
    <div className="flex flex-col gap-8">
      <Section title="Visible watermarks">
        <p className="max-w-[62ch] text-sm text-[var(--color-muted)]">
          Not built yet. Metadata stripping for images already works — drop a PNG, JPEG, WebP or GIF
          on the Files tab and it will report and remove EXIF, XMP and C2PA manifests without
          re-encoding a single pixel.
        </p>
      </Section>

      <Limits>
        <p>
          Robust pixel watermarks — SynthID, Tree-Ring, StableSignature, StegaStamp — are not
          removed by anything on this page, and will not be. They survive re-encoding, resizing and
          inpainting by design. A tool claiming otherwise is guessing.
        </p>
      </Limits>
    </div>
  )
}
