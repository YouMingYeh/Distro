const still = "/brand/distro-mascot.png";

export function DistroMascot({
  className,
  expression,
  lazy,
}: {
  className: string;
  expression?: "greet" | "happy";
  lazy?: boolean;
}) {
  const size = expression === "greet" ? 512 : 1024;

  return (
    <picture className={`distro-mascot ${className}`}>
      {expression && <source media="(prefers-reduced-motion: reduce)" srcSet={still} />}
      <img
        src={expression ? `/brand/distro-${expression}.webp` : still}
        width={size}
        height={size}
        alt=""
        loading={lazy ? "lazy" : undefined}
        decoding="async"
      />
    </picture>
  );
}
