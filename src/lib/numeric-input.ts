/**
 * Numeric input helpers: a field that shows only "0" is emptied when the user taps it, so typing "10" gives 10
 * (not "010" or "100"). If the user leaves the field without typing anything, the original zero is put back.
 */

/** True for "0", "0.0", "0.00", "٠", "٠٫٠٠" ... (an all-zero number, with or without decimals). */
export const isZeroLikeText = (text: string): boolean =>
  /^[0٠۰]+(?:[.,٫][0٠۰]*)?$/.test(text.trim());

/** Marks the element as "emptied by us" and remembers the original text, so blur can restore it. */
const CLEARED_ATTR = 'data-zero-cleared';

/**
 * Sets an input's value in a way React's onChange sees (React ignores a plain `el.value = x`).
 * Returns nothing; read `el.value` afterwards to see whether the controlled state accepted it.
 */
export function setInputValueAndNotify(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  if (!setter) return;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Call on focus of a numeric field. */
export function clearZeroOnFocus(el: HTMLInputElement): void {
  if (el.readOnly || el.disabled) return;
  const original = el.value;
  if (!isZeroLikeText(original)) return;

  setInputValueAndNotify(el, '');
  if (el.value === '') {
    el.setAttribute(CLEARED_ATTR, original);
    return;
  }
  // The owner of the value does not allow an empty field (it turns "" back into 0): select the zero instead,
  // so the first digit typed replaces it.
  window.setTimeout(() => {
    if (el.value === original && document.activeElement === el) {
      try { el.select(); } catch { /* some input types do not support select() */ }
    }
  }, 0);
}

/** Call on blur of a numeric field: puts the zero back if the user left it empty. */
export function restoreZeroOnBlur(el: HTMLInputElement): void {
  const original = el.getAttribute(CLEARED_ATTR);
  if (original === null) return;
  el.removeAttribute(CLEARED_ATTR);
  if (el.value === '') setInputValueAndNotify(el, original);
}

/** Whether this input is a numeric field (number type, or a text field asking for a numeric keyboard). */
export const isNumericInput = (type: string | undefined, inputMode: string | undefined): boolean =>
  type === 'number' || inputMode === 'decimal' || inputMode === 'numeric';
