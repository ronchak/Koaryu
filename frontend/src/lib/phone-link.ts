/** Keep an explicit extension separate from the number passed to the dialer. */
export function phoneHref(phone: string): string | undefined {
  const match = /^(\+?[\d\s().-]+?)(?:\s*(?:ext(?:ension)?\.?|x|;ext=)\s*(\d+))?$/i.exec(
    phone.trim(),
  );
  if (!match) return undefined;

  const number = match[1].replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(number)) return undefined;

  // Preserve local numbers without guessing their country code. Unsupported
  // notes or dial strings stay visible as text rather than becoming a wrong number.
  return `tel:${number}${match[2] ? `;ext=${match[2]}` : ""}`;
}
