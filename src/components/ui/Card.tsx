/** Card from BRAND.md section 6: paper-deep, 16px radius, 24px pad, optional
 *  2px ember top-accent line (the LPM signature). */
export function Card({
  accent = true,
  className = "",
  children,
}: {
  accent?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`relative bg-paper-deep border border-hairline rounded-2xl p-6 ${className}`}
    >
      {accent && (
        <span className="absolute top-6 left-6 w-[60px] h-0.5 bg-ember" />
      )}
      <div className={accent ? "pt-4" : ""}>{children}</div>
    </div>
  );
}

export function CardLabel({ children }: { children: React.ReactNode }) {
  return <div className="brand-label">{children}</div>;
}
