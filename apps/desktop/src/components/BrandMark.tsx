interface BrandMarkProps {
  readonly size?: number;
  readonly className?: string;
}

export function BrandMark({ size = 28, className }: BrandMarkProps) {
  return (
    <svg aria-hidden="true" className={className} height={size} viewBox="0 0 48 48" width={size}>
      <path
        d="M24 4 41 13.5v20L24 44 7 33.5v-20L24 4Z"
        fill="#1C2028"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2.4"
      />
      <path
        d="m7 13.5 17 10 17-10M24 23.5V44"
        fill="none"
        stroke="#42D392"
        strokeLinejoin="round"
        strokeWidth="2.4"
      />
      {[
        [24, 4],
        [7, 13.5],
        [41, 13.5],
        [24, 23.5],
        [7, 33.5],
        [41, 33.5],
        [24, 44],
      ].map(([cx, cy], index) => (
        <circle
          key={`${cx}-${cy}`}
          cx={cx}
          cy={cy}
          fill={index < 3 ? '#6677F4' : '#42D392'}
          r="2.8"
        />
      ))}
    </svg>
  );
}
