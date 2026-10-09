/** Category (ember) and venture (gold) pills. BRAND.md section 6 tables. */
export function Pill({
  tone = "ember",
  children,
}: {
  tone?: "ember" | "gold";
  children: React.ReactNode;
}) {
  const cls =
    tone === "gold"
      ? "bg-gold/20 text-[#9a7220]"
      : "bg-ember/10 text-ember";
  return (
    <span
      className={`inline-block px-[11px] py-1 rounded-full text-xs font-semibold ${cls}`}
    >
      {children}
    </span>
  );
}
