import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function delayScroll(ms: number) {
  return (): NodeJS.Timeout => setTimeout(() => window.scrollTo(0, 0), ms);
}
