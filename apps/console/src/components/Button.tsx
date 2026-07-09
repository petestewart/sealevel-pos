import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "outlined" | "destructive-text";

/**
 * Design-system button (Console.dc.html footer actions): primary accent,
 * outlined, and destructive text variants. A plain styled <button>, safe in
 * server components (used inside server-action <form>s).
 */
export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const classes = `btn btn--${variant}${className ? ` ${className}` : ""}`;
  return <button className={classes} {...props} />;
}
