/**
 * Utility helpers shared across components.
 */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind CSS class names, resolving conflicts with tailwind-merge.
 *
 * @param inputs - Class values (strings, arrays, conditionals via clsx).
 * @returns Merged class string.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
