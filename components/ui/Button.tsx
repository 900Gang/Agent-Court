import type { ButtonHTMLAttributes } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "solid" | "outline" };

/** Defaults to type="button" so a button inside a form never submits it by accident. */
export function Button({ variant = "outline", type = "button", className, ...rest }: ButtonProps) {
  const classes = ["btn", variant === "solid" ? "btn-solid" : "", className ?? ""].filter(Boolean).join(" ");
  return <button type={type} className={classes} {...rest} />;
}
