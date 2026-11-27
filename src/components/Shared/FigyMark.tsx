/**
 * The Figylo mark, at one size per place and the same shape everywhere.
 *
 * It had been `<img src="/logo.png">` written out six times at five different
 * sizes, and `logo.png` is not a mark: it is a 1536×1024 hero image, the icon
 * floating in the middle of a dark field, weighing 1.3MB. Every usage was
 * wrong in one of two ways. Three asked for `h-4 w-auto`, which honours the
 * 3:2 ratio and so drew a 24×16 strip that is mostly empty background. The
 * other two asked for `h-4 w-4`, which squares a 3:2 image by squashing it.
 * Either way the thing on screen was not the icon.
 *
 * `figylo-mark.png` is that icon cropped square and flush to its own rounded
 * edges, at 128px — six times the largest size drawn here, so it stays sharp
 * on a 3× display, and 30KB rather than 1.3MB for something that renders at
 * sixteen pixels.
 *
 * The radius is a share of the side rather than a fixed `rounded`, so the
 * curve matches the icon's own at every size instead of being slightly wrong
 * at all of them; 22% is the squircle app icons use. It is clipping the art's
 * own corners, which is what keeps the last row of dark pixels off the edge.
 */
export function FigyMark({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <img
      src="/figylo-mark.png"
      alt=""
      width={size}
      height={size}
      draggable={false}
      style={{ width: size, height: size, borderRadius: "22%" }}
      className={`shrink-0 select-none ${className}`}
    />
  );
}
