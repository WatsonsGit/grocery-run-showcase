/** Buttons per BRAND.md section 6. Primary: ember bg, cream text.
 *  Secondary: ember border. Tertiary: ember text, underline on hover. */
type Variant = "primary" | "secondary" | "tertiary";

export function Button({
  variant = "primary",
  className = "",
  children,
  ...rest
}: { variant?: Variant } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const base =
    "inline-flex items-center gap-2 text-sm font-semibold rounded-lg transition-colors";
  const styles: Record<Variant, string> = {
    primary: "bg-ember text-paper px-4 py-2.5 hover:bg-ember-soft",
    secondary:
      "border border-ember text-ember px-4 py-2.5 hover:bg-ember/5",
    tertiary: "text-ember hover:underline px-1 py-1",
  };
  return (
    <button className={`${base} ${styles[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}
