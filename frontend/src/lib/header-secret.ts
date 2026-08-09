const ASCII_CONTROL_OR_DEL = /[\u0000-\u001f\u007f]/;

export function isSafeHeaderSecret(value: string, minimumLength = 1) {
  return value.length >= minimumLength
    && value === value.trim()
    && !ASCII_CONTROL_OR_DEL.test(value);
}
